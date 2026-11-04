/**
 * OptiModel catalog ids → SpatialReal character packs under
 * `public/optimodel/avatars/`.
 */
export type OptiModelAsset = {
	/** Spatius / SpatialReal character UUID (AvatarManager.load id). */
	characterId: string;
	/** Path under `/optimodel/` (no leading slash on dir). */
	dir: string;
	preview: string;
	/**
	 * Compressed GS file under the avatar dir (xr_resource).
	 * Samira ships csplat.gz; Sanjay ships ply.gz — do not prefetch both.
	 */
	compressedGs: string;
};

const OPTIMODEL_ASSET_BY_ID: Record<string, OptiModelAsset> = {
	samira: {
		characterId: "a0a234f5-0e04-483c-9cf1-3d5bd88b4442",
		dir: "avatars/samira-a0a234f5",
		preview: "/images/gsplat/samira.png",
		compressedGs: "point_cloud_low.csplat.gz",
	},
	sanjay: {
		characterId: "3c409ac5-2637-4dd6-9c0c-c47c4b085966",
		dir: "avatars/sanjay-3c409ac5",
		preview: "/images/gsplat/sanjay.png",
		compressedGs: "point_cloud_low.ply.gz",
	},
};

const DEFAULT_OPTIMODEL_ID = "sanjay";

export function getOptiModelAsset(
	externalAvatarId: string | null | undefined,
): OptiModelAsset {
	if (externalAvatarId && OPTIMODEL_ASSET_BY_ID[externalAvatarId]) {
		return OPTIMODEL_ASSET_BY_ID[externalAvatarId];
	}
	return OPTIMODEL_ASSET_BY_ID[DEFAULT_OPTIMODEL_ID];
}

export function getOptiModelCharacterId(
	externalAvatarId: string | null | undefined,
): string {
	return getOptiModelAsset(externalAvatarId).characterId;
}

/** @deprecated Prefer getOptiModelAsset — OptiModel no longer uses LAM zip packs. */
export function getGsplatAvatarZipUrl(
	externalAvatarId: string | null | undefined,
): string {
	const asset = getOptiModelAsset(externalAvatarId);
	return `/optimodel/${asset.dir}/character.json`;
}

export function getAvatarPreviewUrl(
	externalAvatarId: string | null | undefined,
	providerId?: string | null,
): string | null {
	if (!externalAvatarId) {
		return null;
	}

	const optimodel = OPTIMODEL_ASSET_BY_ID[externalAvatarId];
	if (providerId === "arkit" || optimodel) {
		return (
			optimodel?.preview ??
			OPTIMODEL_ASSET_BY_ID[DEFAULT_OPTIMODEL_ID].preview
		);
	}

	return `/images/avatar/${externalAvatarId}.png`;
}
