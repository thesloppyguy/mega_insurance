import { cloneKeyframe, type FlameKeyframe } from "@/lib/arkit-flame";

/** Default ease-out from speech pose back to idle after talk ends. */
export const DEFAULT_SPEECH_RELEASE_MS = 450;
/** Default ease-in from idle into first speech frame (hard-capped at 100ms). */
export const DEFAULT_SPEECH_ATTACK_MS = 100;

/** Speech overlay replaces expression + jawPose only; idle keeps the rest. */
export type SpeechOverlay = {
	expression: number[];
	jawPose: number[];
};

type SpeechFade = {
	mode: "in" | "out";
	from: SpeechOverlay;
	startMs: number;
	durationMs: number;
};

export type SpeechOverlayControllerOptions = {
	attackMs?: number;
	releaseMs?: number;
};

function smoothstep(t: number): number {
	const x = Math.min(1, Math.max(0, t));
	return x * x * (3 - 2 * x);
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

export function cloneSpeechOverlay(src: SpeechOverlay): SpeechOverlay {
	return {
		expression: src.expression.slice(0, 100),
		jawPose: [
			src.jawPose[0] ?? 0,
			src.jawPose[1] ?? 0,
			src.jawPose[2] ?? 0,
		],
	};
}

export function speechOverlayFromIdle(idle: FlameKeyframe): SpeechOverlay {
	return {
		expression: idle.expression.slice(0, 100),
		jawPose: [...idle.jawPose],
	};
}

export function speechOverlayFromFlame(kf: FlameKeyframe): SpeechOverlay {
	return {
		expression: kf.expression.slice(0, 100),
		jawPose: [kf.jawPose[0] ?? 0, kf.jawPose[1] ?? 0, kf.jawPose[2] ?? 0],
	};
}

export function applySpeechOverlay(
	idle: FlameKeyframe,
	speech: SpeechOverlay,
): FlameKeyframe {
	const out = cloneKeyframe(idle);
	const expr = speech.expression ?? [];
	out.expression = Array.from({ length: 100 }, (_, i) =>
		typeof expr[i] === "number" && Number.isFinite(expr[i]) ? expr[i] : 0,
	);
	const jaw = speech.jawPose ?? [];
	out.jawPose = [
		typeof jaw[0] === "number" && Number.isFinite(jaw[0]) ? jaw[0] : 0,
		typeof jaw[1] === "number" && Number.isFinite(jaw[1]) ? jaw[1] : 0,
		typeof jaw[2] === "number" && Number.isFinite(jaw[2]) ? jaw[2] : 0,
	];
	return out;
}

function blendOverlays(
	from: SpeechOverlay,
	to: SpeechOverlay,
	u: number,
): SpeechOverlay {
	const t = smoothstep(u);
	return {
		expression: Array.from({ length: 100 }, (_, i) =>
			lerp(from.expression[i] ?? 0, to.expression[i] ?? 0, t),
		),
		jawPose: [
			lerp(from.jawPose[0] ?? 0, to.jawPose[0] ?? 0, t),
			lerp(from.jawPose[1] ?? 0, to.jawPose[1] ?? 0, t),
			lerp(from.jawPose[2] ?? 0, to.jawPose[2] ?? 0, t),
		],
	};
}

function sampleFade(
	fade: SpeechFade,
	to: SpeechOverlay,
	nowMs: number,
): { overlay: SpeechOverlay; done: boolean } {
	const u = (nowMs - fade.startMs) / Math.max(1, fade.durationMs);
	if (u >= 1) return { overlay: cloneSpeechOverlay(to), done: true };
	return { overlay: blendOverlays(fade.from, to, u), done: false };
}

/**
 * Composites speech expression+jawPose onto idle FLAME with attack/release fades.
 * Idle always owns neck/eyes/body; speech only overrides mouth channels.
 */
export class SpeechOverlayController {
	private speech: SpeechOverlay | null = null;
	private lastSpeech: SpeechOverlay | null = null;
	private lastIdle: SpeechOverlay | null = null;
	private fade: SpeechFade | null = null;
	private attackMs: number;
	private releaseMs: number;

	constructor(options: SpeechOverlayControllerOptions = {}) {
		this.attackMs = Math.min(
			100,
			Math.max(0, options.attackMs ?? DEFAULT_SPEECH_ATTACK_MS),
		);
		this.releaseMs = Math.max(
			0,
			options.releaseMs ?? DEFAULT_SPEECH_RELEASE_MS,
		);
	}

	setTiming(options: SpeechOverlayControllerOptions): void {
		if (options.attackMs != null) {
			this.attackMs = Math.min(100, Math.max(0, options.attackMs));
		}
		if (options.releaseMs != null) {
			this.releaseMs = Math.max(0, options.releaseMs);
		}
	}

	reset(): void {
		this.speech = null;
		this.lastSpeech = null;
		this.lastIdle = null;
		this.fade = null;
	}

	setSpeech(overlay: SpeechOverlay | null): void {
		const now = performance.now();
		if (overlay) {
			const next = cloneSpeechOverlay(overlay);
			const starting = !this.speech && this.fade?.mode !== "in";
			this.speech = next;
			this.lastSpeech = next;

			if (starting) {
				let from: SpeechOverlay;
				if (this.fade?.mode === "out") {
					const idleTo = this.lastIdle ?? next;
					from = sampleFade(this.fade, idleTo, now).overlay;
				} else {
					from = this.lastIdle
						? cloneSpeechOverlay(this.lastIdle)
						: cloneSpeechOverlay(next);
				}
				if (this.attackMs <= 0) {
					this.fade = null;
				} else {
					this.fade = {
						mode: "in",
						from,
						startMs: now,
						durationMs: this.attackMs,
					};
				}
			}
			return;
		}

		let from = this.lastSpeech ?? this.speech;
		if (this.fade?.mode === "in" && from) {
			from = sampleFade(this.fade, from, now).overlay;
		}
		this.speech = null;
		if (!from) {
			this.fade = null;
			return;
		}
		if (this.releaseMs <= 0) {
			this.fade = null;
			this.lastSpeech = null;
			return;
		}
		this.fade = {
			mode: "out",
			from: cloneSpeechOverlay(from),
			startMs: now,
			durationMs: this.releaseMs,
		};
	}

	composite(idle: FlameKeyframe, nowMs = performance.now()): FlameKeyframe {
		const idleOverlay = speechOverlayFromIdle(idle);
		const fade = this.fade;
		const speech = this.speech;

		if (fade?.mode === "in" && speech) {
			const sample = sampleFade(fade, speech, nowMs);
			if (sample.done) this.fade = null;
			return applySpeechOverlay(idle, sample.overlay);
		}

		if (fade?.mode === "out") {
			const sample = sampleFade(fade, idleOverlay, nowMs);
			if (sample.done) {
				this.fade = null;
				this.lastSpeech = null;
				this.lastIdle = idleOverlay;
				return idle;
			}
			this.lastIdle = idleOverlay;
			return applySpeechOverlay(idle, sample.overlay);
		}

		if (speech) {
			return applySpeechOverlay(idle, speech);
		}

		this.lastIdle = idleOverlay;
		return idle;
	}
}
