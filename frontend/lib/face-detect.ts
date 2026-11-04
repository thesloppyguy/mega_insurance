/**
 * MediaPipe FaceLandmarker for prejoin face-visible gating.
 * Loaded from CDN at runtime to avoid Turbopack bundling issues.
 */

const MEDIAPIPE_VERSION = "0.10.14"
const VISION_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`
const WASM_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`
const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"

export type FaceVisibleResult = {
  faceVisible: boolean
  faceCount: number
  hint: string
}

export type FaceLandmarkerHandle = {
  detectForVideo: (
    video: HTMLVideoElement,
    timestamp: number
  ) => { faceLandmarks?: unknown[][] }
  close: () => void
}

function importVisionBundle(): Promise<{
  FilesetResolver: {
    forVisionTasks: (path: string) => Promise<unknown>
  }
  FaceLandmarker: {
    createFromOptions: (
      vision: unknown,
      options: Record<string, unknown>
    ) => Promise<FaceLandmarkerHandle>
  }
}> {
  const dynamicImport = new Function("url", "return import(url)") as (
    url: string
  ) => Promise<{
    FilesetResolver: {
      forVisionTasks: (path: string) => Promise<unknown>
    }
    FaceLandmarker: {
      createFromOptions: (
        vision: unknown,
        options: Record<string, unknown>
      ) => Promise<FaceLandmarkerHandle>
    }
  }>
  return dynamicImport(VISION_BUNDLE_URL)
}

let landmarkerPromise: Promise<FaceLandmarkerHandle> | null = null

/**
 * Shared FaceLandmarker singleton. Do NOT call `.close()` from UI code —
 * that kills the cached instance and the next page (interview) crashes on
 * detectForVideo. Caller `.close()` is a no-op.
 */
export async function createFaceLandmarker(): Promise<FaceLandmarkerHandle> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await importVisionBundle()
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_ROOT)
      const inner = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: FACE_MODEL_URL,
          delegate: "CPU",
        },
        runningMode: "VIDEO",
        numFaces: 2,
      })
      return {
        detectForVideo: (video: HTMLVideoElement, timestamp: number) =>
          inner.detectForVideo(video, timestamp),
        // Keep WASM alive across prejoin → interview Soft-nav.
        close: () => undefined,
      }
    })().catch((err) => {
      landmarkerPromise = null
      throw err
    })
  }
  return landmarkerPromise
}

/** Simple gate: exactly one face with a reasonable landmark box. */
export function evaluateFaceVisible(
  result: { faceLandmarks?: unknown[][] } | null | undefined
): FaceVisibleResult {
  const faces = result?.faceLandmarks ?? []
  if (faces.length === 0) {
    return {
      faceVisible: false,
      faceCount: 0,
      hint: "Position your face in the camera",
    }
  }
  if (faces.length > 1) {
    return {
      faceVisible: false,
      faceCount: faces.length,
      hint: "Only one face should be visible",
    }
  }
  const landmarks = faces[0] as Array<{ x: number; y: number }> | undefined
  if (!landmarks?.length) {
    return {
      faceVisible: false,
      faceCount: 0,
      hint: "Position your face in the camera",
    }
  }
  let minX = 1
  let minY = 1
  let maxX = 0
  let maxY = 0
  for (const p of landmarks) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const width = maxX - minX
  const height = maxY - minY
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  if (width < 0.12 || height < 0.14) {
    return {
      faceVisible: false,
      faceCount: 1,
      hint: "Move a little closer",
    }
  }
  if (width > 0.75 || height > 0.9) {
    return {
      faceVisible: false,
      faceCount: 1,
      hint: "Move a little farther back",
    }
  }
  if (cx < 0.2 || cx > 0.8 || cy < 0.15 || cy > 0.85) {
    return {
      faceVisible: false,
      faceCount: 1,
      hint: "Center your face in the frame",
    }
  }
  return {
    faceVisible: true,
    faceCount: 1,
    hint: "Face detected — ready to start",
  }
}
