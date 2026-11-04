/** FLAME keyframe shape (SpatialReal / Spatius KeyframeData). */
export type FlameKeyframe = {
	translation: number[];
	rotation: number[];
	neckPose: number[];
	jawPose: number[];
	eyePose: number[];
	eyeLid: number[];
	expression: number[];
};

export type FlameField = keyof FlameKeyframe;

export const FLAME_FIELDS: {
	key: FlameField;
	label: string;
	dims: number;
}[] = [
	{ key: "translation", label: "Translation", dims: 3 },
	{ key: "rotation", label: "Rotation", dims: 3 },
	{ key: "neckPose", label: "Neck pose", dims: 3 },
	{ key: "jawPose", label: "Jaw pose", dims: 3 },
	{ key: "eyePose", label: "Eye pose", dims: 6 },
	{ key: "eyeLid", label: "Eye lid", dims: 2 },
	{ key: "expression", label: "Expression", dims: 100 },
];

export function zeroKeyframe(): FlameKeyframe {
	return {
		translation: [0, 0, 0],
		rotation: [0, 0, 0],
		neckPose: [0, 0, 0],
		jawPose: [0, 0, 0],
		eyePose: [0, 0, 0, 0, 0, 0],
		eyeLid: [0, 0],
		expression: Array.from({ length: 100 }, () => 0),
	};
}

export function cloneKeyframe(src: FlameKeyframe): FlameKeyframe {
	return {
		translation: [...src.translation],
		rotation: [...src.rotation],
		neckPose: [...src.neckPose],
		jawPose: [...src.jawPose],
		eyePose: [...src.eyePose],
		eyeLid: [...src.eyeLid],
		expression: [...src.expression],
	};
}

export function normalizeKeyframe(raw: Partial<FlameKeyframe>): FlameKeyframe {
	const base = zeroKeyframe();
	for (const { key, dims } of FLAME_FIELDS) {
		const arr = raw[key];
		if (!Array.isArray(arr)) continue;
		const next = [...base[key]];
		for (let i = 0; i < dims; i++) {
			const v = arr[i];
			if (typeof v === "number" && Number.isFinite(v)) next[i] = v;
		}
		base[key] = next;
	}
	return base;
}

/** WASM frame params from AvatarCore.getCurrentFrameParams (snake_case). */
export type WasmFrameParams = {
	translation?: number[];
	rotation?: number[];
	neck_pose?: number[];
	jaw_pose?: number[];
	eyes_pose?: number[];
	eyelid?: number[];
	expr_params?: number[];
};

function copyDims(src: number[] | undefined, dims: number): number[] {
	const out = Array.from({ length: dims }, () => 0);
	if (!Array.isArray(src)) return out;
	for (let i = 0; i < dims; i++) {
		const v = src[i];
		if (typeof v === "number" && Number.isFinite(v)) out[i] = v;
	}
	return out;
}

/** Map AvatarCore idle-frame params into the FLAME keyframe shape. */
export function wasmParamsToKeyframe(params: WasmFrameParams): FlameKeyframe {
	return {
		translation: copyDims(params.translation, 3),
		rotation: copyDims(params.rotation, 3),
		neckPose: copyDims(params.neck_pose, 3),
		jawPose: copyDims(params.jaw_pose, 3),
		eyePose: copyDims(params.eyes_pose, 6),
		eyeLid: copyDims(params.eyelid, 2),
		expression: copyDims(params.expr_params, 100),
	};
}
