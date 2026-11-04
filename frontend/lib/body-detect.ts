/**
 * MediaPipe PoseLandmarker for body-capture gating.
 * Loaded from CDN at runtime (same pattern as face-detect.ts).
 */

const MEDIAPIPE_VERSION = "0.10.14"
const VISION_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`
const WASM_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"

/** BlazePose landmark indices. */
const NOSE = 0
const LEFT_SHOULDER = 11
const RIGHT_SHOULDER = 12
const LEFT_HIP = 23
const RIGHT_HIP = 24
const LEFT_KNEE = 25
const RIGHT_KNEE = 26
const LEFT_ANKLE = 27
const RIGHT_ANKLE = 28

const MIN_VISIBILITY = 0.55
/** Nose must sit in the upper portion of the frame (forces step-back). */
const MAX_NOSE_Y = 0.34
/** Minimum vertical span from nose → hips (rejects face-only hallucinations). */
const MIN_TORSO_SPAN = 0.32
/** Minimum shoulder width as a fraction of frame width. */
const MIN_SHOULDER_WIDTH = 0.14
/** Detected body bbox must fill this much of frame height. */
const MIN_BODY_HEIGHT = 0.45
const MAX_BODY_HEIGHT = 0.95
const CENTER_TOLERANCE = 0.22

export type BodyCaptureHint =
  | "no_body"
  | "multiple_people"
  | "move_closer"
  | "move_back"
  | "center"
  | "hold_steady"

export type BodyFramingResult = {
  detected: boolean
  bodyFound: boolean
  hint: BodyCaptureHint
  hintText: string
  confidence: number
}

export type PoseLandmarkerHandle = {
  detectForVideo: (
    video: HTMLVideoElement,
    timestamp: number
  ) => {
    landmarks?: Array<Array<{ x: number; y: number; visibility?: number }>>
  }
  close: () => void
}

const HINT_TEXT: Record<BodyCaptureHint, string> = {
  no_body: "Stand back so your head, shoulders, and hips are in frame",
  multiple_people: "Only one person should be visible",
  move_closer: "Step a little closer so your body fills more of the frame",
  move_back: "Step farther back — face-only is not enough for body capture",
  center: "Center your body in the silhouette",
  hold_steady: "Hold steady…",
}

function importVisionBundle(): Promise<{
  FilesetResolver: {
    forVisionTasks: (path: string) => Promise<unknown>
  }
  PoseLandmarker: {
    createFromOptions: (
      vision: unknown,
      options: Record<string, unknown>
    ) => Promise<PoseLandmarkerHandle>
  }
}> {
  const dynamicImport = new Function("url", "return import(url)") as (
    url: string
  ) => Promise<{
    FilesetResolver: {
      forVisionTasks: (path: string) => Promise<unknown>
    }
    PoseLandmarker: {
      createFromOptions: (
        vision: unknown,
        options: Record<string, unknown>
      ) => Promise<PoseLandmarkerHandle>
    }
  }>
  return dynamicImport(VISION_BUNDLE_URL)
}

let posePromise: Promise<PoseLandmarkerHandle> | null = null

/**
 * Shared PoseLandmarker singleton. Caller `.close()` is a no-op so Soft-nav
 * between pages cannot leave a dead cached instance.
 */
export async function createPoseLandmarker(): Promise<PoseLandmarkerHandle> {
  if (!posePromise) {
    posePromise = (async () => {
      const vision = await importVisionBundle()
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_ROOT)
      const create = (delegate: "GPU" | "CPU") =>
        vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: POSE_MODEL_URL,
            delegate,
          },
          runningMode: "VIDEO",
          numPoses: 2,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        })
      let inner: PoseLandmarkerHandle
      try {
        inner = await create("GPU")
      } catch {
        inner = await create("CPU")
      }
      return {
        detectForVideo: (video: HTMLVideoElement, timestamp: number) =>
          inner.detectForVideo(video, timestamp),
        close: () => undefined,
      }
    })().catch((err) => {
      posePromise = null
      throw err
    })
  }
  return posePromise
}

function visible(
  point: { x: number; y: number; visibility?: number } | undefined,
  min = MIN_VISIBILITY
): point is { x: number; y: number; visibility?: number } {
  if (!point) return false
  const v = typeof point.visibility === "number" ? point.visibility : 1
  return v >= min
}

function fail(hint: BodyCaptureHint): BodyFramingResult {
  return {
    detected: false,
    bodyFound: hint !== "no_body" && hint !== "multiple_people",
    hint,
    hintText: HINT_TEXT[hint],
    confidence: 0,
  }
}

/**
 * Gate body capture so a face close-up cannot pass.
 * Requires torso geometry (nose → shoulders → hips) plus at least one
 * knee/ankle so PoseLandmarker hallucinations from face-only shots fail.
 */
export function evaluateBodyFraming(result: {
  landmarks?: Array<Array<{ x: number; y: number; visibility?: number }>>
} | null | undefined): BodyFramingResult {
  const poses = result?.landmarks ?? []
  if (poses.length === 0) return fail("no_body")
  if (poses.length > 1) return fail("multiple_people")

  const landmarks = poses[0]
  if (!landmarks?.length) return fail("no_body")

  const nose = landmarks[NOSE]
  const leftShoulder = landmarks[LEFT_SHOULDER]
  const rightShoulder = landmarks[RIGHT_SHOULDER]
  const leftHip = landmarks[LEFT_HIP]
  const rightHip = landmarks[RIGHT_HIP]
  const leftKnee = landmarks[LEFT_KNEE]
  const rightKnee = landmarks[RIGHT_KNEE]
  const leftAnkle = landmarks[LEFT_ANKLE]
  const rightAnkle = landmarks[RIGHT_ANKLE]

  const shouldersOk =
    visible(leftShoulder) && visible(rightShoulder)
  const hipsOk = visible(leftHip) && visible(rightHip)
  const noseOk = visible(nose)
  if (!shouldersOk || !hipsOk || !noseOk) return fail("no_body")

  // Pose often invents hips under a face close-up; knees/ankles stay invisible.
  const lowerLimbOk =
    visible(leftKnee) ||
    visible(rightKnee) ||
    visible(leftAnkle) ||
    visible(rightAnkle)
  if (!lowerLimbOk) return fail("move_back")

  const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2
  const hipMidY = (leftHip.y + rightHip.y) / 2
  const shoulderWidth = Math.abs(leftShoulder.x - rightShoulder.x)
  const torsoSpan = hipMidY - nose.y

  // Anatomical order with real vertical gaps (face hallucinations collapse).
  if (!(nose.y < shoulderMidY && shoulderMidY < hipMidY)) {
    return fail("no_body")
  }
  if (shoulderMidY - nose.y < 0.06 || hipMidY - shoulderMidY < 0.1) {
    return fail("move_back")
  }
  if (nose.y > MAX_NOSE_Y) return fail("move_back")
  if (torsoSpan < MIN_TORSO_SPAN) return fail("move_back")
  if (shoulderWidth < MIN_SHOULDER_WIDTH) return fail("move_closer")

  const points = [
    nose,
    leftShoulder,
    rightShoulder,
    leftHip,
    rightHip,
    leftKnee,
    rightKnee,
    leftAnkle,
    rightAnkle,
  ].filter((p) => visible(p))

  let minX = 1
  let minY = 1
  let maxX = 0
  let maxY = 0
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const boxH = maxY - minY
  const boxW = maxX - minX
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2

  if (boxH < MIN_BODY_HEIGHT) return fail("move_closer")
  if (boxH > MAX_BODY_HEIGHT || boxW > 0.85) return fail("move_back")
  if (
    Math.abs(cx - 0.5) > CENTER_TOLERANCE ||
    Math.abs(cy - 0.5) > CENTER_TOLERANCE
  ) {
    return fail("center")
  }

  const visScores = [
    nose,
    leftShoulder,
    rightShoulder,
    leftHip,
    rightHip,
  ].map((p) => (typeof p.visibility === "number" ? p.visibility : 1))
  const confidence =
    visScores.reduce((a, b) => a + b, 0) / Math.max(visScores.length, 1)

  return {
    detected: true,
    bodyFound: true,
    hint: "hold_steady",
    hintText: HINT_TEXT.hold_steady,
    confidence,
  }
}
