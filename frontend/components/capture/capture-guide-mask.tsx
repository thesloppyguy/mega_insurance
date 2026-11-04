"use client"

import { useId } from "react"

import type { GuideRect } from "@/lib/capture-guides"

export type GuideTone = "idle" | "adjusting" | "ready"

const TONE_STROKE: Record<GuideTone, string> = {
  idle: "rgba(255,255,255,0.92)",
  adjusting: "rgb(251, 191, 36)",
  ready: "rgb(52, 211, 153)",
}

/** Egg-shaped face oval in a 100×130 box. */
const FACE_PATH =
  "M50 3 C74 3 93 22 93 52 C93 70 88 88 78 104 C70 117 60 127 50 127 C40 127 30 117 22 104 C12 88 7 70 7 52 C7 22 26 3 50 3 Z"

/**
 * Full-body silhouette in a 100×220 box.
 * Head, neck, shoulders, arms slightly away from torso, legs with a gap.
 */
const BODY_PATH = [
  "M50 7",
  "C58 7 64 14 64 24",
  "C64 32 60 38 57 42",
  "L57 50",
  "C57 54 64 56 71 58",
  "C80 60 86 67 87 78",
  "L91 108",
  "C92 114 91 119 87 121",
  "C83 123 80 120 80 115",
  "L75 88",
  "L71 92",
  "L69 108",
  "C69 116 72 120 72 128",
  "L71 204",
  "C71 211 70 215 66 215",
  "L56 215",
  "C53 215 53 212 53 209",
  "L53 138",
  "C53 132 51 128 50 128",
  "C49 128 47 132 47 138",
  "L47 209",
  "C47 212 47 215 44 215",
  "L34 215",
  "C30 215 29 211 29 204",
  "L28 128",
  "C28 120 31 116 31 108",
  "L29 92",
  "L25 88",
  "L20 115",
  "C20 120 17 123 13 121",
  "C9 119 8 114 9 108",
  "L13 78",
  "C14 67 20 60 29 58",
  "C36 56 43 54 43 50",
  "L43 42",
  "C40 38 36 32 36 24",
  "C36 14 42 7 50 7",
  "Z",
].join(" ")

const SHAPES = {
  face: {
    path: FACE_PATH,
    viewBox: "0 0 100 130",
  },
  body: {
    path: BODY_PATH,
    viewBox: "0 0 100 220",
  },
} as const

const pct = (value: number) => `${value * 100}%`

function GuideMask({
  kind,
  guide,
  tone,
  dim = 0.5,
}: {
  kind: keyof typeof SHAPES
  guide: GuideRect
  tone: GuideTone
  dim?: number
}) {
  const maskId = `guide-mask-${useId().replace(/:/g, "")}`
  const { path, viewBox } = SHAPES[kind]

  const placement = {
    x: pct(guide.x),
    y: pct(guide.y),
    width: pct(guide.width),
    height: pct(guide.height),
    viewBox,
    preserveAspectRatio: "xMidYMid meet",
    overflow: "visible",
  } as const

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <defs>
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="100%"
          height="100%"
        >
          <rect width="100%" height="100%" fill="white" />
          <svg {...placement}>
            <path d={path} fill="black" />
          </svg>
        </mask>
      </defs>

      <rect
        width="100%"
        height="100%"
        fill="black"
        fillOpacity={dim}
        mask={`url(#${maskId})`}
      />

      <svg {...placement}>
        <path
          d={path}
          fill="none"
          stroke={TONE_STROKE[tone]}
          strokeWidth={2.75}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          style={{ transition: "stroke 200ms ease" }}
        />
      </svg>
    </svg>
  )
}

export function FaceGuideMask(props: { guide: GuideRect; tone: GuideTone }) {
  return <GuideMask kind="face" {...props} />
}

export function BodyGuideMask(props: { guide: GuideRect; tone: GuideTone }) {
  return <GuideMask kind="body" {...props} />
}

export function captureGuideTone(args: {
  detected?: boolean
  found?: boolean
}): GuideTone {
  if (args.detected) return "ready"
  if (args.found) return "adjusting"
  return "idle"
}
