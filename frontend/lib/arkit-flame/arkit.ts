/** Standard ARKit 52 facial blendshape names. */
export const ARKIT_BLENDSHAPES = [
	"browDownLeft",
	"browDownRight",
	"browInnerUp",
	"browOuterUpLeft",
	"browOuterUpRight",
	"cheekPuff",
	"cheekSquintLeft",
	"cheekSquintRight",
	"eyeBlinkLeft",
	"eyeBlinkRight",
	"eyeLookDownLeft",
	"eyeLookDownRight",
	"eyeLookInLeft",
	"eyeLookInRight",
	"eyeLookOutLeft",
	"eyeLookOutRight",
	"eyeLookUpLeft",
	"eyeLookUpRight",
	"eyeSquintLeft",
	"eyeSquintRight",
	"eyeWideLeft",
	"eyeWideRight",
	"jawForward",
	"jawLeft",
	"jawOpen",
	"jawRight",
	"mouthClose",
	"mouthDimpleLeft",
	"mouthDimpleRight",
	"mouthFrownLeft",
	"mouthFrownRight",
	"mouthFunnel",
	"mouthLeft",
	"mouthLowerDownLeft",
	"mouthLowerDownRight",
	"mouthPressLeft",
	"mouthPressRight",
	"mouthPucker",
	"mouthRight",
	"mouthRollLower",
	"mouthRollUpper",
	"mouthShrugLower",
	"mouthShrugUpper",
	"mouthSmileLeft",
	"mouthSmileRight",
	"mouthStretchLeft",
	"mouthStretchRight",
	"mouthUpperUpLeft",
	"mouthUpperUpRight",
	"noseSneerLeft",
	"noseSneerRight",
	"tongueOut",
] as const;

export type ARKitBlendshape = (typeof ARKIT_BLENDSHAPES)[number];

export const ARKIT_COUNT = ARKIT_BLENDSHAPES.length;

export const ARKIT_INDEX: Readonly<Record<ARKitBlendshape, number>> =
	Object.fromEntries(ARKIT_BLENDSHAPES.map((name, i) => [name, i])) as Record<
		ARKitBlendshape,
		number
	>;

/** Blendshapes typically driven by speech (not expression/gaze). */
export const SPEECH_BLENDSHAPES: readonly ARKitBlendshape[] = [
	"jawForward",
	"jawLeft",
	"jawOpen",
	"jawRight",
	"mouthClose",
	"mouthDimpleLeft",
	"mouthDimpleRight",
	"mouthFrownLeft",
	"mouthFrownRight",
	"mouthFunnel",
	"mouthLeft",
	"mouthLowerDownLeft",
	"mouthLowerDownRight",
	"mouthPressLeft",
	"mouthPressRight",
	"mouthPucker",
	"mouthRight",
	"mouthRollLower",
	"mouthRollUpper",
	"mouthShrugLower",
	"mouthShrugUpper",
	"mouthSmileLeft",
	"mouthSmileRight",
	"mouthStretchLeft",
	"mouthStretchRight",
	"mouthUpperUpLeft",
	"mouthUpperUpRight",
	"cheekPuff",
	"tongueOut",
];

export const SPEECH_BLENDSHAPE_SET = new Set<string>(SPEECH_BLENDSHAPES);

export function clamp01(v: number): number {
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

export function weightsToRecord(
	weights: Float32Array | number[],
): Partial<Record<ARKitBlendshape, number>> {
	const out: Partial<Record<ARKitBlendshape, number>> = {};
	for (let i = 0; i < ARKIT_COUNT; i++) {
		const w = weights[i];
		if (w !== undefined && w > 1e-4) out[ARKIT_BLENDSHAPES[i]] = clamp01(w);
	}
	return out;
}

export function recordToWeights(
	record: Partial<Record<ARKitBlendshape, number>>,
	out?: Float32Array,
): Float32Array {
	const buf = out ?? new Float32Array(ARKIT_COUNT);
	buf.fill(0);
	for (const [name, value] of Object.entries(record)) {
		const idx = ARKIT_INDEX[name as ARKitBlendshape];
		if (idx !== undefined && value !== undefined) buf[idx] = clamp01(value);
	}
	return buf;
}
