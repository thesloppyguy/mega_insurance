/**
 * MediaPipe Pose helpers.
 *
 * Loaded from CDN at runtime — Turbopack cannot analyze
 * `@mediapipe/tasks-vision`'s dynamic `import(t.toString())`.
 */

import type { StageId } from "@/lib/stages"

export type PoseStatus = "missing" | "adjust" | "ok"

export type PoseAssessment = {
  stage: StageId
  status: PoseStatus
  score: number
  tips: string[]
  metrics: Record<string, number | boolean | null>
}

/** Minimal landmark shape used by assessment + overlay (MediaPipe-compatible). */
export type NormalizedLandmark = {
  x: number
  y: number
  z?: number
  visibility?: number
  presence?: number
}

export type PoseLandmarkerResult = {
  landmarks: NormalizedLandmark[][]
}

export type PoseLandmarker = {
  detectForVideo: (
    video: HTMLVideoElement,
    timestamp: number
  ) => PoseLandmarkerResult
  close: () => void
}

const MEDIAPIPE_VERSION = "1.2.0"
const VISION_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`
const WASM_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"

/** CPU is the reliable default — GPU often fatals with `delegate_graph_context`. */
type PoseDelegate = "CPU" | "GPU"
let forceCpuDelegate = false

function preferredDelegate(): PoseDelegate {
  if (forceCpuDelegate) return "CPU"
  if (
    typeof process !== "undefined" &&
    process.env.NEXT_PUBLIC_MEDIAPIPE_DELEGATE?.toUpperCase() === "GPU"
  ) {
    return "GPU"
  }
  return "CPU"
}

// MediaPipe Pose landmark indices
const NOSE = 0
const L_SHOULDER = 11
const R_SHOULDER = 12
const L_HIP = 23
const R_HIP = 24
const L_ANKLE = 27
const R_ANKLE = 28

function visible(lm: NormalizedLandmark | undefined, min = 0.5): boolean {
  if (!lm) return false
  const v = lm.visibility ?? lm.presence ?? 1
  return v >= min
}

function mid(
  a: NormalizedLandmark | undefined,
  b: NormalizedLandmark | undefined
): { x: number; y: number } | null {
  if (!a || !b) return null
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** Bypass the bundler so Turbopack never sees MediaPipe's internal dynamic import. */
function importVisionBundle(): Promise<{
  FilesetResolver: {
    forVisionTasks: (path: string) => Promise<unknown>
  }
  PoseLandmarker: {
    createFromOptions: (
      vision: unknown,
      options: Record<string, unknown>
    ) => Promise<PoseLandmarker>
  }
}> {
  // new Function keeps the URL import opaque to static analysis.
  const dynamicImport = new Function(
    "url",
    "return import(url)"
  ) as (url: string) => Promise<Record<string, unknown>>
  return dynamicImport(VISION_BUNDLE_URL) as ReturnType<typeof importVisionBundle>
}

let landmarkerPromise: Promise<PoseLandmarker> | null = null
let landmarkerRefCount = 0
let releaseTimer: ReturnType<typeof setTimeout> | null = null
let activeDelegate: PoseDelegate | null = null
/** VIDEO mode requires strictly increasing timestamps across the landmarker lifetime. */
let nextDetectTs = 1

function landmarkerOptions(delegate: PoseDelegate) {
  return {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate,
    },
    runningMode: "VIDEO" as const,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  }
}

async function buildLandmarker(
  visionMod: Awaited<ReturnType<typeof importVisionBundle>>,
  fileset: unknown,
  delegate: PoseDelegate
): Promise<PoseLandmarker> {
  const lm = await visionMod.PoseLandmarker.createFromOptions(
    fileset,
    landmarkerOptions(delegate)
  )
  activeDelegate = delegate
  nextDetectTs = 1
  return lm
}

/**
 * Shared PoseLandmarker (one WASM instance per tab).
 * Defaults to CPU — GPU WebGL fatals (`gl_context.cc delegate_graph_context`)
 * are common on remote desktops / multi-context tabs and abort the page.
 */
export async function createPoseLandmarker(): Promise<PoseLandmarker> {
  if (typeof window === "undefined") {
    throw new Error("Pose landmarker is browser-only")
  }
  if (releaseTimer != null) {
    clearTimeout(releaseTimer)
    releaseTimer = null
  }
  landmarkerRefCount += 1
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const visionMod = await importVisionBundle()
      const fileset = await visionMod.FilesetResolver.forVisionTasks(WASM_ROOT)
      const preferred = preferredDelegate()
      const order: PoseDelegate[] =
        preferred === "GPU" ? ["GPU", "CPU"] : ["CPU"]
      let lastErr: unknown
      for (const delegate of order) {
        try {
          return await buildLandmarker(visionMod, fileset, delegate)
        } catch (err) {
          lastErr = err
          console.warn(`PoseLandmarker ${delegate} init failed; trying next`, err)
        }
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error("PoseLandmarker init failed")
    })().catch((err) => {
      landmarkerPromise = null
      activeDelegate = null
      throw err
    })
  }
  return landmarkerPromise
}

/** Monotonic timestamp for detectForVideo (MediaPipe VIDEO mode requirement). */
export function nextPoseTimestamp(): number {
  const ts = nextDetectTs
  nextDetectTs += 1
  return ts
}

export function releasePoseLandmarker() {
  landmarkerRefCount = Math.max(0, landmarkerRefCount - 1)
  // Debounce teardown so Strict Mode remounts reuse the same instance.
  if (landmarkerRefCount > 0) return
  if (releaseTimer != null) clearTimeout(releaseTimer)
  releaseTimer = setTimeout(() => {
    releaseTimer = null
    if (landmarkerRefCount > 0 || !landmarkerPromise) return
    const pending = landmarkerPromise
    landmarkerPromise = null
    activeDelegate = null
    void pending
      .then((lm) => {
        try {
          lm.close()
        } catch {
          /* already closed */
        }
      })
      .catch(() => undefined)
  }, 1500)
}

/**
 * Close a broken GPU landmarker and recreate on CPU.
 * Returns the new instance, or null if already on CPU / recovery failed.
 */
export async function recoverPoseLandmarkerOnCpu(): Promise<PoseLandmarker | null> {
  if (activeDelegate === "CPU") return null
  forceCpuDelegate = true
  const keptRefs = landmarkerRefCount
  const pending = landmarkerPromise
  landmarkerPromise = null
  activeDelegate = null
  if (pending) {
    try {
      const lm = await pending
      try {
        lm.close()
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  }
  if (keptRefs <= 0) return null
  landmarkerRefCount = Math.max(0, keptRefs - 1)
  try {
    return await createPoseLandmarker()
  } catch (err) {
    console.warn("PoseLandmarker CPU recovery failed", err)
    return null
  }
}

export function assessPose(
  stage: StageId,
  result: PoseLandmarkerResult | null,
  motion: { noseDelta: number; stillFrames: number }
): PoseAssessment {
  const tips: string[] = []
  const landmarks = result?.landmarks?.[0]
  if (!landmarks || stage === "done") {
    return {
      stage,
      status: stage === "done" ? "ok" : "missing",
      score: 0,
      tips: stage === "done" ? [] : ["Step into frame so your body is visible."],
      metrics: { detected: false },
    }
  }

  const nose = landmarks[NOSE]
  const lShoulder = landmarks[L_SHOULDER]
  const rShoulder = landmarks[R_SHOULDER]
  const lHip = landmarks[L_HIP]
  const rHip = landmarks[R_HIP]
  const lAnkle = landmarks[L_ANKLE]
  const rAnkle = landmarks[R_ANKLE]
  const shoulders = mid(lShoulder, rShoulder)
  const hips = mid(lHip, rHip)

  const faceVisible = visible(nose, 0.45)
  const shouldersVisible = visible(lShoulder, 0.4) && visible(rShoulder, 0.4)
  const hipsVisible = visible(lHip, 0.35) && visible(rHip, 0.35)
  const anklesVisible = visible(lAnkle, 0.3) && visible(rAnkle, 0.3)
  const torsoHeight =
    shoulders && hips ? Math.abs(hips.y - shoulders.y) : null
  const fullHeight =
    nose && anklesVisible
      ? Math.abs(
          (landmarks[L_ANKLE].y + landmarks[R_ANKLE].y) / 2 - nose.y
        )
      : null

  const metrics: Record<string, number | boolean | null> = {
    detected: true,
    face_visible: faceVisible,
    shoulders_visible: shouldersVisible,
    hips_visible: hipsVisible,
    ankles_visible: anklesVisible,
    nose_x: nose?.x ?? null,
    nose_y: nose?.y ?? null,
    torso_height: torsoHeight,
    full_height: fullHeight,
    nose_delta: motion.noseDelta,
    still_frames: motion.stillFrames,
  }

  if (stage === "precheck" || stage === "face") {
    if (!faceVisible) tips.push("Look at the camera so your face is visible.")
    if (!shouldersVisible) tips.push("Move back a little so shoulders are in frame.")
    if (nose && (nose.y < 0.12 || nose.y > 0.55)) {
      tips.push("Center your face in the oval.")
    }
    if (nose && (nose.x < 0.25 || nose.x > 0.75)) {
      tips.push("Move toward the center of the frame.")
    }
    if (stage === "face" && motion.noseDelta > 0.035) {
      tips.push("Hold still for a clear selfie.")
    }
    const ok =
      tips.length === 0 &&
      faceVisible &&
      shouldersVisible &&
      (stage !== "face" || motion.stillFrames >= 8)
    return {
      stage,
      status: ok ? "ok" : tips.length ? "adjust" : "missing",
      score: ok ? 0.9 : tips.length ? 0.45 : 0.1,
      tips,
      metrics,
    }
  }

  if (stage === "liveness") {
    if (!faceVisible || !shouldersVisible) {
      tips.push("Keep your face and shoulders visible.")
    }
    const moving = motion.noseDelta > 0.012
    if (!moving) tips.push("Blink and slowly turn your head.")
    const ok = faceVisible && shouldersVisible && moving
    return {
      stage,
      status: ok ? "ok" : "adjust",
      score: ok ? 0.85 : 0.4,
      tips,
      metrics,
    }
  }

  if (stage === "kyc") {
    // Pose only verifies upper body presence; ID quality is visual/agent-side.
    if (!faceVisible && !shouldersVisible) {
      tips.push("Stay in frame while holding your ID.")
    } else if (!shouldersVisible) {
      tips.push("Hold the ID up near chest height.")
    } else {
      tips.push("Hold your ID steady inside the dashed frame.")
    }
    // Don't auto-ok KYC from pose alone — agent confirms ID is readable.
    const ready = shouldersVisible || faceVisible
    return {
      stage,
      status: ready ? "adjust" : "missing",
      score: ready ? 0.55 : 0.15,
      tips,
      metrics: { ...metrics, pose_ready_for_id: ready },
    }
  }

  if (stage === "body_front" || stage === "body_back") {
    if (!shouldersVisible) tips.push("Step back so your shoulders are visible.")
    if (!hipsVisible) tips.push("Move farther so your hips are in frame.")
    if (!anklesVisible) tips.push("Step back until your feet are visible.")
    if (fullHeight != null && fullHeight < 0.55) {
      tips.push("Stand farther from the camera for a full-body view.")
    }
    if (shoulders && (shoulders.x < 0.2 || shoulders.x > 0.8)) {
      tips.push("Center yourself in the frame.")
    }
    if (stage === "body_front" && motion.noseDelta > 0.04) {
      tips.push("Hold still facing the camera.")
    }
    if (stage === "body_back" && faceVisible && (nose?.visibility ?? 0) > 0.75) {
      tips.push("Turn around so your back faces the camera.")
    }
    const ok =
      tips.length === 0 &&
      shouldersVisible &&
      hipsVisible &&
      anklesVisible &&
      (fullHeight == null || fullHeight >= 0.55)
    return {
      stage,
      status: ok ? "ok" : tips.length ? "adjust" : "missing",
      score: ok ? 0.9 : 0.4,
      tips,
      metrics,
    }
  }

  return {
    stage,
    status: "ok",
    score: 1,
    tips: [],
    metrics,
  }
}

/** Skeleton connections for overlay drawing (subset). */
export const POSE_CONNECTIONS: Array<[number, number]> = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
  [0, 11],
  [0, 12],
]

export function drawPoseOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  result: PoseLandmarkerResult | null,
  status: PoseStatus
) {
  ctx.clearRect(0, 0, width, height)
  const landmarks = result?.landmarks?.[0]
  if (!landmarks) return

  const color =
    status === "ok"
      ? "rgba(45,212,191,0.95)"
      : status === "adjust"
        ? "rgba(251,191,36,0.95)"
        : "rgba(251,113,133,0.9)"

  ctx.lineWidth = 3
  ctx.strokeStyle = color
  for (const [a, b] of POSE_CONNECTIONS) {
    const pa = landmarks[a]
    const pb = landmarks[b]
    if (!visible(pa, 0.25) || !visible(pb, 0.25)) continue
    ctx.beginPath()
    ctx.moveTo(pa.x * width, pa.y * height)
    ctx.lineTo(pb.x * width, pb.y * height)
    ctx.stroke()
  }

  for (const lm of landmarks) {
    if (!visible(lm, 0.3)) continue
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(lm.x * width, lm.y * height, 3.5, 0, Math.PI * 2)
    ctx.fill()
  }
}
