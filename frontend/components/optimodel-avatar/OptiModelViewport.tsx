"use client";

import {
	cloneKeyframe,
	normalizeKeyframe,
	zeroKeyframe,
	type FlameKeyframe,
} from "@/lib/arkit-flame";
import { useEffect, useRef } from "react";
import { FlameFeed } from "@/lib/optimodel/flame-feed";
import {
	IDLE_SPEED_DEFAULT,
	startIdleLoop,
	type AnimationInfo,
	type AvatarCoreLike,
	type IdleLoopHandle,
} from "@/lib/optimodel/idle-loop";
import {
	SpeechOverlayController,
	speechOverlayFromFlame,
} from "@/lib/optimodel/speech-overlay";
import {
	ensureOptiModelSdkInitialized,
	installOptiModelAssetCache,
	waitForOptiModelWarmupIdle,
	warmOptiModelRuntime,
} from "@/lib/gsplat-preload";
import { lipsyncMark, RenderStats } from "@/lib/optimodel/lipsync-metrics";
import { getOptiModelAsset } from "@/lib/stock-avatars";

/** Idle render cadence (fps-matched to the 25fps clip) vs while speech is driving the mouth. */
const IDLE_RENDER_INTERVAL_MS = 1000 / 25;
const SPEAKING_RENDER_INTERVAL_MS = 1000 / 50;
/** Worker speech gate (0..1) above which the mouth is driven by speech. */
const FLAME_GATE_SPEAKING = 0.35;

type AvatarViewHandle = {
	dispose: () => void;
	onFirstRendering?: (() => void) | null;
	renderFlame: (
		keyframeData?: FlameKeyframe,
		enableIdleRendering?: boolean,
	) => Promise<void>;
	/** Internal — stop SDK idle RAF so we can own WASM frame reads. */
	stopRenderLoop?: () => void;
	/**
	 * AvatarView mints a private id (`${avatar.id}-${ts}-${rand}`) and keys
	 * WASM character/animation handles under it. Idle frame reads must use
	 * this id or shape lookup falls back to a stale default handle.
	 */
	characterId?: string;
};

type Props = {
	/** Worker-generated FLAME frames for the current speech turn. Idle-only when omitted (prejoin warm). */
	flameFeed?: FlameFeed;
	/** Catalog id (`samira` | `sanjay`). */
	avatarId?: string | null;
	onStatus?: (msg: string) => void;
	className?: string;
};

/**
 * OptiModel stage: Gaussian avatar driven by worker FLAME frames → speech overlay.
 */
export function OptiModelViewport({
	flameFeed,
	avatarId = "sanjay",
	onStatus,
	className,
}: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const idleFeedRef = useRef<FlameFeed | null>(null);
	if (!idleFeedRef.current) idleFeedRef.current = new FlameFeed();
	const activeFeed = flameFeed ?? idleFeedRef.current;
	const flameFeedRef = useRef(activeFeed);
	const onStatusRef = useRef(onStatus);

	flameFeedRef.current = activeFeed;
	onStatusRef.current = onStatus;

	const asset = getOptiModelAsset(avatarId);
	const characterId = asset.characterId;

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let cancelled = false;
		let view: AvatarViewHandle | null = null;
		let idle: IdleLoopHandle | null = null;
		let core: AvatarCoreLike | null = null;
		let raf = 0;
		let speaking = false;
		const overlay = new SpeechOverlayController();
		const viewReady = { current: false };
		const stats = new RenderStats();

		const stopIdle = () => {
			idle?.stop();
			idle = null;
		};

		const renderMerged = async (idleKf: FlameKeyframe) => {
			if (!view || !viewReady.current || cancelled) return;
			const t0 = performance.now();
			try {
				await view.renderFlame(overlay.composite(idleKf), false);
				stats.rendered(performance.now() - t0);
			} catch (e) {
				onStatusRef.current?.(
					e instanceof Error ? e.message : String(e),
				);
			}
		};

		const startIdle = (
			animationInfo: AnimationInfo,
			viewCharacterId?: string,
		) => {
			stopIdle();
			if (!core) {
				onStatusRef.current?.("ready · no idle core");
				return;
			}
			idle = startIdleLoop({
				getCore: () => core,
				characterId: viewCharacterId,
				animationInfo,
				getPlaybackRate: () => IDLE_SPEED_DEFAULT,
				getRenderIntervalMs: () =>
					speaking
						? SPEAKING_RENDER_INTERVAL_MS
						: IDLE_RENDER_INTERVAL_MS,
				onTickSkipped: () => stats.skip(),
				renderFrame: async (kf) => {
					await renderMerged(kf);
				},
				onError: (e) => {
					onStatusRef.current?.(
						e instanceof Error ? e.message : String(e),
					);
				},
			});
			onStatusRef.current?.("idle + speech overlay");
		};

		const driveLoop = () => {
			stats.loop();
			const sample = flameFeedRef.current.sample();
			if (sample && sample.gate >= FLAME_GATE_SPEAKING) {
				if (!speaking) {
					lipsyncMark("first-mouth-frame");
				}
				speaking = true;
				overlay.setSpeech(speechOverlayFromFlame(sample.keyframe));
			} else if (speaking) {
				speaking = false;
				overlay.setSpeech(null);
			}
			stats.flush(speaking);
			raf = requestAnimationFrame(driveLoop);
		};

		void (async () => {
			try {
				onStatusRef.current?.("warming OptiModel…");
				installOptiModelAssetCache();
				// Finish lobby prefetch/init if still in flight; otherwise warm now.
				await waitForOptiModelWarmupIdle();
				if (cancelled) return;
				await warmOptiModelRuntime(avatarId);
				if (cancelled) return;

				onStatusRef.current?.("initializing SDK…");
				// Lobby warm already initializes; this is a no-op if so.
				const kit = await ensureOptiModelSdkInitialized();
				const { AvatarSDK, AvatarManager, AvatarView } = kit;

				if (cancelled) return;

				core =
					(
						AvatarSDK as unknown as {
							getAvatarCore?: () => AvatarCoreLike | null;
						}
					).getAvatarCore?.() ?? null;

				if (cancelled) return;
				onStatusRef.current?.("attaching OptiModel avatar…");

				const avatar = await AvatarManager.shared.load(
					characterId,
					(info) => {
						if (
							info.type === "downloading" &&
							typeof info.progress === "number"
						) {
							onStatusRef.current?.(
								`download ${(info.progress * 100).toFixed(0)}%`,
							);
						}
						if (info.type === "failed" && info.error) {
							onStatusRef.current?.(
								`renderer failed: ${info.error.message}`,
							);
						}
					},
				);

				if (cancelled) return;
				core =
					(
						AvatarSDK as unknown as {
							getAvatarCore?: () => AvatarCoreLike | null;
						}
					).getAvatarCore?.() ?? core;

				let baseline: FlameKeyframe = zeroKeyframe();
				try {
					const frameRes = await fetch(
						`/optimodel/${asset.dir}/idle.frame0.json`,
					);
					if (frameRes.ok) {
						baseline = normalizeKeyframe(
							(await frameRes.json()) as Partial<FlameKeyframe>,
						);
					}
				} catch {
					/* keep zeros */
				}

				container.replaceChildren();
				view = new AvatarView(
					avatar,
					container,
				) as unknown as AvatarViewHandle;

				await new Promise<void>((resolve, reject) => {
					const t = window.setTimeout(
						() =>
							reject(
								new Error("Timed out waiting for first frame"),
							),
						90_000,
					);
					view!.onFirstRendering = () => {
						window.clearTimeout(t);
						resolve();
					};
				});

				if (cancelled) {
					view.dispose();
					return;
				}

				core =
					(
						AvatarSDK as unknown as {
							getAvatarCore?: () => AvatarCoreLike | null;
						}
					).getAvatarCore?.() ?? core;
				{
					const deadline = performance.now() + 5_000;
					let lastErr: unknown;
					while (performance.now() < deadline) {
						try {
							await view.renderFlame(
								cloneKeyframe(baseline),
								false,
							);
							lastErr = null;
							break;
						} catch (e) {
							lastErr = e;
							await new Promise((r) => window.setTimeout(r, 16));
						}
					}
					if (lastErr) throw lastErr;
				}

				if (cancelled) return;

				viewReady.current = true;

				// AvatarView starts its own idle RAF which also calls
				// getCurrentFrameParams — concurrent WASM reads cause
				// "memory access out of bounds". Take exclusive ownership.
				view.stopRenderLoop?.();

				if (!core?.loadAdditionalAnimation) {
					throw new Error(
						"AvatarCore.loadAdditionalAnimation missing",
					);
				}
				const idleRes = await fetch(
					`/optimodel/${asset.dir}/idle.pb`,
				);
				if (!idleRes.ok) {
					throw new Error(
						`Failed to fetch idle.pb (${idleRes.status})`,
					);
				}
				const idleInfo = await core.loadAdditionalAnimation(
					await idleRes.arrayBuffer(),
				);
				if (cancelled) return;
				if (
					!idleInfo?.totalFrames ||
					!Number.isFinite(idleInfo.totalFrames)
				) {
					throw new Error("idle.pb reported 0 frames");
				}

				startIdle(idleInfo, view.characterId);
				raf = requestAnimationFrame(driveLoop);
				onStatusRef.current?.(`ready · idle ${idleInfo.totalFrames}f`);
			} catch (e) {
				if (!cancelled) {
					const message = e instanceof Error ? e.message : String(e);
					console.error(e);
					onStatusRef.current?.(`renderer failed: ${message}`);
				}
			}
		})();

		return () => {
			cancelled = true;
			viewReady.current = false;
			overlay.reset();
			stopIdle();
			cancelAnimationFrame(raf);
			view?.dispose();
			view = null;
			core = null;
		};
	}, [asset.dir, avatarId, characterId]);

	return (
		<div
			className={["gsplat-viewport h-full w-full", className]
				.filter(Boolean)
				.join(" ")}
		>
			<div ref={containerRef} className="gsplat-viewport-stage h-full w-full" />
		</div>
	);
}
