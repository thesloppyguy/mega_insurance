/** Normalized guide rectangle as fractions of frame width/height. */
export type GuideRect = {
  x: number
  y: number
  width: number
  height: number
}

/** Defaults matching optimind-deployement proctoring config. */
const FACE_GUIDE_WIDTH = 0.36
const FACE_ASPECT = 1.3
const BODY_GUIDE_WIDTH = 0.28
const BODY_ASPECT = 2.15
const ID_GUIDE_WIDTH = 0.7
const ID_ASPECT = 85.6 / 54

function centeredGuide(
  frameWidth: number,
  frameHeight: number,
  guideWidthRatio: number,
  aspectRatio: number,
  maxHeight: number
): GuideRect {
  const frameAspect = frameWidth / Math.max(frameHeight, 1)
  let width = guideWidthRatio
  let height = width * frameAspect * aspectRatio
  if (height > maxHeight) {
    height = maxHeight
    width = height / (frameAspect * aspectRatio)
  }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height }
}

export function faceGuideRect(
  frameWidth: number,
  frameHeight: number
): GuideRect {
  return centeredGuide(
    frameWidth,
    frameHeight,
    FACE_GUIDE_WIDTH,
    FACE_ASPECT,
    0.78
  )
}

export function bodyGuideRect(
  frameWidth: number,
  frameHeight: number
): GuideRect {
  return centeredGuide(
    frameWidth,
    frameHeight,
    BODY_GUIDE_WIDTH,
    BODY_ASPECT,
    0.92
  )
}

/** ID-1 card guide (width/height uses card aspect differently from face/body). */
export function idGuideRect(
  frameWidth: number,
  frameHeight: number
): GuideRect {
  const frameAspect = frameWidth / Math.max(frameHeight, 1)
  let width = ID_GUIDE_WIDTH
  let height = (width * frameAspect) / ID_ASPECT
  if (height > 0.85) {
    height = 0.85
    width = (height * ID_ASPECT) / frameAspect
  }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height }
}

export type CaptureStatus =
  | "idle"
  | "scanning"
  | "uploading"
  | "captured"
  | "failed"
