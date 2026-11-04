/**
 * Prefetch OptiModel packs + warm AvatarKit before Join — fully offline.
 * Assets are served from `/optimodel/*` + `/avatar-api/*`.
 *
 * Lobby flow:
 * 1. Patch fetch: local packs + rewrite/stub vendor CDN calls
 * 2. Prefetch shape / ply / idle / flame template into memory + Cache API
 * 3. `AvatarSDK.initialize` in host mode (`region` pinned, local endpoint)
 * 4. `AvatarManager.load` from `/avatar-api`
 *
 * Join then awaits {@link waitForOptiModelWarmupIdle} so the viewport only
 * mounts AvatarView on already-cached bytes.
 */

import { getOptiModelAsset } from "@/lib/stock-avatars";

/** Bump when cached API JSON may still embed unreachable localhost remotes. */
const OPTIMODEL_CACHE_NAME = "mavrik-optimodel-assets-v3";
const LOCAL_API = "/avatar-api";
const LOCAL_TOKEN = "local-offline";
const LOCAL_APP_ID = "local-offline";
/** Pin region so AvatarKit skips `global.spatialwalk.top/bootstrap`. */
const LOCAL_REGION = "us-west";

/** AvatarKit hardcodes these hosts for `unified_model_body.pb.gz` (COEP blocks them). */
const SPATIALWALK_CDN_HOSTS = new Set([
	"cdn.spatialwalk.cloud",
	"cdn.spatialwalk.top",
]);

/** Docker / misconfigured SITE_URL origins that must never be fetched from the browser. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** Same-origin stand-in for vendor CDN `/public/...` assets. */
const LOCAL_FLAME_SDK_BASE = "/optimodel/sdk";
const UNIFIED_MODEL_PATH = "unified_model_body.pb.gz";

/** Pack files shared by every OptiModel avatar (compressed GS is per-avatar). */
const PREFETCH_FILES = [
	"character.json",
	"model_info.json",
	"shape.pb",
	"idle.pb",
	"idle.frame0.json",
	"point_cloud_low.ply",
] as const;

type SpatiusAvatarKit = typeof import("@spatius/avatarkit");

let sdkPromise: Promise<SpatiusAvatarKit> | null = null;
/** Serializes preload work so Join can wait until it settles. */
let warmupGate: Promise<void> = Promise.resolve();
/** Dedupes AvatarSDK.initialize / AvatarManager.load across remounts. */
let runtimeWarmPromise: Promise<void> | null = null;
let runtimeWarmKey: string | null = null;
/** AvatarSDK.initialize may only run once per page — shared by lobby warm + viewport. */
let sdkInitPromise: Promise<SpatiusAvatarKit> | null = null;

let fetchCacheInstalled = false;
let nativeFetch: typeof fetch | null = null;
const memoryBytes = new Map<string, ArrayBuffer>();
const memoryInflight = new Map<string, Promise<ArrayBuffer>>();

function resolveRequestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function pathnameOf(url: string): string {
	try {
		return new URL(url, window.location.origin).pathname;
	} catch {
		return url;
	}
}

function isOptiModelAssetUrl(url: string): boolean {
	const path = pathnameOf(url);
	return (
		path.startsWith("/optimodel/") || path.startsWith("/avatar-api/")
	);
}

/**
 * Normalize OptiModel asset URLs onto the page origin:
 * - vendor flame CDN → `/optimodel/sdk/*` (COEP require-corp)
 * - `https://localhost:3000/optimodel/...` from stale API/cache → same-origin
 *
 * Absolute localhost remotes must be rewritten: `new URL(absolute)` ignores
 * the page origin, so fetch would hit the user's machine (ERR_CONNECTION_REFUSED).
 */
function rewriteOptiModelUrl(url: string): string {
	try {
		const parsed = new URL(url, window.location.origin);
		if (
			SPATIALWALK_CDN_HOSTS.has(parsed.hostname) &&
			parsed.pathname.startsWith("/public/")
		) {
			const file = parsed.pathname.slice("/public/".length);
			return `${window.location.origin}${LOCAL_FLAME_SDK_BASE}/${file}`;
		}
		const path = parsed.pathname;
		if (
			LOOPBACK_HOSTS.has(parsed.hostname) &&
			(path.startsWith("/optimodel/") ||
				path.startsWith("/avatar-api/"))
		) {
			return `${window.location.origin}${path}${parsed.search}`;
		}
	} catch {
		/* keep original */
	}
	return url;
}

function hostnameOf(url: string): string | null {
	try {
		return new URL(url, window.location.origin).hostname;
	} catch {
		return null;
	}
}

/** Region / clock-sync bootstrap — stubbed so OptiModel never needs SpatialWalk. */
function isSpatialWalkBootstrapUrl(url: string): boolean {
	const host = hostnameOf(url);
	if (!host) return false;
	return (
		(host === "global.spatialwalk.top" ||
			host === "global.spatialwalk.cloud" ||
			host.endsWith(".spatialwalk.top") ||
			host.endsWith(".spatialwalk.cloud")) &&
		pathnameOf(url) === "/bootstrap"
	);
}

/** OTel / metrics / traces — optional; fail closed locally under COEP. */
function isSpatialWalkTelemetryUrl(url: string): boolean {
	const host = hostnameOf(url);
	if (!host) return false;
	return (
		host === "t.spatialwalk.top" ||
		host === "t.spatialwalk.cloud" ||
		(host.startsWith("t.") &&
			(host.endsWith(".spatialwalk.top") ||
				host.endsWith(".spatialwalk.cloud")))
	);
}

function spatialWalkBootstrapResponse(): Response {
	const now = Date.now();
	return new Response(
		JSON.stringify({
			region: {
				current: LOCAL_REGION,
				candidates: [LOCAL_REGION],
			},
			time_sync: {
				server_receive_ms: now,
				server_send_ms: now,
				version: 1,
			},
		}),
		{
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			},
		},
	);
}

function cacheKeyFor(url: string): string {
	try {
		return new URL(rewriteOptiModelUrl(url), window.location.origin).href;
	} catch {
		return url;
	}
}

function arrayBufferResponse(bytes: ArrayBuffer, url: string): Response {
	const path = pathnameOf(url);
	const contentType = path.endsWith(".json")
		? "application/json"
		: path.endsWith(".pb")
			? "application/octet-stream"
			: path.endsWith(".ply")
				? "application/octet-stream"
				: path.endsWith(".gz")
					? "application/gzip"
					: "application/octet-stream";
	return new Response(bytes.slice(0), {
		status: 200,
		headers: {
			"Content-Type": contentType,
			"Cache-Control": "public, max-age=3600",
		},
	});
}

async function readCache(url: string): Promise<ArrayBuffer | null> {
	const key = cacheKeyFor(url);
	const hit = memoryBytes.get(key);
	if (hit) return hit;
	if (typeof caches === "undefined") return null;
	try {
		const cache = await caches.open(OPTIMODEL_CACHE_NAME);
		const response = await cache.match(key);
		if (!response) return null;
		const bytes = await response.arrayBuffer();
		memoryBytes.set(key, bytes);
		return bytes;
	} catch {
		return null;
	}
}

async function writeCache(url: string, bytes: ArrayBuffer): Promise<void> {
	const key = cacheKeyFor(url);
	memoryBytes.set(key, bytes);
	if (typeof caches === "undefined") return;
	try {
		const cache = await caches.open(OPTIMODEL_CACHE_NAME);
		await cache.put(key, arrayBufferResponse(bytes, key));
	} catch {
		/* private mode / quota */
	}
}

async function loadOptiModelBytes(
	url: string,
	init?: RequestInit,
): Promise<ArrayBuffer> {
	const key = cacheKeyFor(url);
	const cached = await readCache(key);
	if (cached) return cached;

	const inflight = memoryInflight.get(key);
	if (inflight) return inflight;

	const fetchImpl = nativeFetch ?? fetch;
	const promise = (async () => {
		const response = await fetchImpl(key, {
			...init,
			credentials: "same-origin",
		});
		if (!response.ok) {
			throw new Error(
				`Failed to download OptiModel asset (${response.status}) ${key}`,
			);
		}
		const bytes = await response.arrayBuffer();
		await writeCache(key, bytes);
		return bytes;
	})().finally(() => {
		memoryInflight.delete(key);
	});

	memoryInflight.set(key, promise);
	return promise;
}

/**
 * Patch window.fetch for OptiModel offline mode:
 * - `/optimodel/*` + `/avatar-api/*` → memory + Cache API
 * - vendor flame CDN → `/optimodel/sdk/*`
 * - vendor bootstrap / telemetry → local stubs (no cloud, COEP-safe)
 */
export function installOptiModelAssetCache(): void {
	if (fetchCacheInstalled || typeof window === "undefined") return;
	fetchCacheInstalled = true;
	nativeFetch = window.fetch.bind(window);

	window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const raw = resolveRequestUrl(input);
		if (isSpatialWalkBootstrapUrl(raw)) {
			return Promise.resolve(spatialWalkBootstrapResponse());
		}
		if (isSpatialWalkTelemetryUrl(raw)) {
			return Promise.resolve(new Response(null, { status: 204 }));
		}

		const url = rewriteOptiModelUrl(raw);
		if (!isOptiModelAssetUrl(url)) {
			return nativeFetch!(input, init);
		}
		return loadOptiModelBytes(url, init).then((bytes) =>
			arrayBufferResponse(bytes, url),
		);
	};
}

/** Shared AvatarSDK.initialize options for OptiModel host / offline mode. */
export function getOptiModelSdkInitConfig(kit: SpatiusAvatarKit) {
	return {
		drivingServiceMode: kit.DrivingServiceMode.backend,
		logLevel: kit.LogLevel.warning,
		region: LOCAL_REGION,
		customEndpoint: `${window.location.origin}${LOCAL_API}`,
	} as const;
}

export function getOptiModelLocalAppId(): string {
	return LOCAL_APP_ID;
}

export function getOptiModelLocalToken(): string {
	return LOCAL_TOKEN;
}

export function preloadOptiModelSdk(): Promise<SpatiusAvatarKit> {
	if (!sdkPromise) {
		sdkPromise = import("@spatius/avatarkit");
	}
	return sdkPromise;
}

/**
 * Load AvatarKit and call `AvatarSDK.initialize` at most once.
 * Lobby warmup and OptiModelViewport both go through this — a second
 * initialize() only logs a Spatius warning and does not reset state.
 */
export function ensureOptiModelSdkInitialized(): Promise<SpatiusAvatarKit> {
	if (!sdkInitPromise) {
		sdkInitPromise = (async () => {
			const kit = await preloadOptiModelSdk();
			await kit.AvatarSDK.initialize(
				LOCAL_APP_ID,
				getOptiModelSdkInitConfig(kit),
			);
			kit.AvatarSDK.setSessionToken(LOCAL_TOKEN);
			return kit;
		})().catch((error) => {
			sdkInitPromise = null;
			throw error;
		});
	}
	return sdkInitPromise;
}

function assetUrlsFor(avatarId: string | null | undefined): string[] {
	const asset = getOptiModelAsset(avatarId);
	const base = `/optimodel/${asset.dir}`;
	const urls = PREFETCH_FILES.map((file) => `${base}/${file}`);
	// Only the format that exists for this pack (samira: csplat.gz, sanjay: ply.gz).
	urls.push(`${base}/${asset.compressedGs}`);
	urls.push(`/avatar-api/v2/avatar/${asset.characterId}`);
	// Required by AvatarSDK.initialize (flame template) — must be same-origin.
	urls.push(`${LOCAL_FLAME_SDK_BASE}/${UNIFIED_MODEL_PATH}`);
	return urls;
}

/** Best-effort pack download (does not fail the warm if optional files 404). */
export async function prefetchOptiModelAssets(
	avatarId: string | null | undefined,
): Promise<void> {
	installOptiModelAssetCache();
	await Promise.all(
		assetUrlsFor(avatarId).map((url) =>
			loadOptiModelBytes(url).catch(() => null),
		),
	);
}

/**
 * Initialize AvatarKit host mode + cache the character via AvatarManager.load.
 * Safe to call from the lobby — does not create AvatarView / LiveKit sessions.
 */
export function warmOptiModelRuntime(
	avatarId: string | null | undefined,
): Promise<void> {
	if (!avatarId) return Promise.resolve();
	const asset = getOptiModelAsset(avatarId);
	const key = asset.characterId;

	if (runtimeWarmPromise && runtimeWarmKey === key) {
		return runtimeWarmPromise;
	}

	runtimeWarmKey = key;
	runtimeWarmPromise = (async () => {
		installOptiModelAssetCache();
		// Kick pack downloads immediately; SDK init can overlap.
		const assetsPromise = prefetchOptiModelAssets(avatarId);
		const [kit] = await Promise.all([
			ensureOptiModelSdkInitialized(),
			import("@/lib/arkit-flame").catch(() => null),
		]);

		await assetsPromise;

		try {
			await kit.AvatarManager.shared.load(asset.characterId, () => {
				/* progress ignored during lobby warm */
			});
		} catch {
			// Live OptiModelViewport will load again; pack cache still helps.
		}
	})().catch((error) => {
		if (runtimeWarmKey === key) {
			runtimeWarmPromise = null;
			runtimeWarmKey = null;
		}
		throw error;
	});

	return runtimeWarmPromise;
}

/** Run work on the warmup gate so Join can wait until it settles. */
export function runOptiModelWarmup(work: () => Promise<void>): Promise<void> {
	const run = warmupGate.then(work, work);
	warmupGate = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** Await any in-flight OptiModel warmup before mounting the live viewport. */
export function waitForOptiModelWarmupIdle(): Promise<void> {
	return warmupGate;
}

/** Fire-and-forget lobby warm (assets + SDK + AvatarManager.load). */
export function warmGsplatAvatar(avatarId: string | null | undefined): void {
	if (!avatarId) return;
	void runOptiModelWarmup(async () => {
		await warmOptiModelRuntime(avatarId);
	});
}

/** @deprecated Prefer {@link prefetchOptiModelAssets}. */
export function prefetchGsplatAvatarZip(
	avatarId: string | null | undefined,
): void {
	void prefetchOptiModelAssets(avatarId);
}

/** @deprecated Prefer {@link installOptiModelAssetCache}. */
export function installGsplatZipCache(): void {
	installOptiModelAssetCache();
}

/** @deprecated OptiModel no longer uses the LAM gsplat zip renderer. */
export function preloadGsplatRenderer(): Promise<null> {
	return preloadOptiModelSdk().then(() => null);
}
