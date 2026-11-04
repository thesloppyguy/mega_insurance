/**
 * Map cached character.json onto the `/v2/avatar/{id}` shape that
 * `@spatius/avatarkit` expects (models.gs + compatibilityFlags).
 */

type ResourceNode = {
	local?: string;
	remote?: string;
	type?: string;
};

type ResourceHolder = {
	resource?: ResourceNode;
	xrResource?: ResourceHolder["resource"];
	xr_resource?: ResourceHolder["resource"];
};

export function toAvatarAsset(
	meta: Record<string, unknown>,
	publicDir: string,
): Record<string, unknown> {
	const models = (meta.models ?? {}) as Record<string, ResourceHolder>;
	const animations = (meta.animations ?? {}) as Record<
		string,
		ResourceHolder
	>;
	const settings = (meta.character_settings ??
		meta.characterSettings ??
		{}) as Record<string, unknown>;
	const inlineCamera =
		(meta.camera &&
		typeof meta.camera === "object" &&
		!("resource" in (meta.camera as object))
			? meta.camera
			: null) ??
		settings.camera ??
		null;

	const shape = models.shape;
	const gs =
		models.gs ??
		models.gsStandard ??
		(models.gs_standard as ResourceHolder | undefined);

	const frameIdle =
		animations.frameIdle ??
		(animations.frame_idle as ResourceHolder | undefined);
	const frameFallback =
		animations.frameFallback ??
		(animations.frame_fallback as ResourceHolder | undefined) ??
		(animations.frame_mono as ResourceHolder | undefined) ??
		frameIdle;

	const flags = (meta.compatibilityFlags ??
		meta.compatibility_flags ??
		[]) as string[];

	const holder = (h: ResourceHolder | undefined) => {
		if (!h?.resource) return undefined;
		const xr = h.xrResource ?? h.xr_resource;
		return {
			resource: h.resource,
			...(xr ? { xrResource: xr } : {}),
		};
	};

	return {
		version: meta.version ?? "2.1.1",
		compatibilityFlags: flags,
		updatedAt: meta.updatedAt ?? meta.updated_at ?? null,
		models: {
			...(shape ? { shape: holder(shape) } : {}),
			...(gs ? { gs: holder(gs) } : {}),
		},
		animations: {
			...(frameIdle ? { frameIdle: holder(frameIdle) } : {}),
			...(frameFallback ? { frameFallback: holder(frameFallback) } : {}),
			customAnimations:
				meta.customAnimations ?? meta.custom_animations ?? [],
		},
		camera: inlineCamera,
		transform: meta.transform ?? settings.transform ?? null,
		_localDir: publicDir,
	};
}

/**
 * Force remotes to path-absolute `/spatialreal/...` so the browser always
 * resolves against the page origin (never Docker/`NEXT_PUBLIC_SITE_URL`
 * localhost, which becomes ERR_CONNECTION_REFUSED in production).
 */
export function relativizeRemotes(node: unknown): unknown {
	if (!node || typeof node !== "object") return node;
	if (Array.isArray(node)) return node.map((n) => relativizeRemotes(n));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
		if (k === "remote" && typeof v === "string") {
			out[k] = toPathAbsoluteRemote(v);
		} else {
			out[k] = relativizeRemotes(v);
		}
	}
	return out;
}

function toPathAbsoluteRemote(remote: string): string {
	if (remote.startsWith("/")) return remote;
	try {
		const parsed = new URL(remote);
		if (
			parsed.pathname.startsWith("/spatialreal/") ||
			parsed.pathname.startsWith("/avatar-api/")
		) {
			return `${parsed.pathname}${parsed.search}`;
		}
	} catch {
		/* keep original */
	}
	return remote;
}

/** @deprecated Prefer path-absolute remotes via {@link relativizeRemotes}. */
export function absolutizeRemotes(node: unknown, origin: string): unknown {
	if (!node || typeof node !== "object") return node;
	if (Array.isArray(node))
		return node.map((n) => absolutizeRemotes(n, origin));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
		if (k === "remote" && typeof v === "string" && v.startsWith("/")) {
			out[k] = `${origin}${v}`;
		} else {
			out[k] = absolutizeRemotes(v, origin);
		}
	}
	return out;
}
