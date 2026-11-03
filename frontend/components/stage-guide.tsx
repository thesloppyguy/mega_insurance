"use client"

import type { StageId } from "@/lib/stages"

type Props = {
  stage: StageId
}

/** Visual framing guides overlaid on the local camera for the active stage. */
export function StageGuide({ stage }: Props) {
  if (stage === "done") return null

  if (stage === "face" || stage === "liveness" || stage === "precheck") {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div
          className={`aspect-[3/4] h-[72%] max-h-[420px] rounded-[45%] border-2 ${
            stage === "liveness"
              ? "border-teal-300/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]"
              : "border-white/55 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]"
          }`}
        />
        {stage === "liveness" ? (
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-black/55 px-2 py-1 text-[11px] text-teal-100">
            Blink · turn head slowly
          </p>
        ) : null}
      </div>
    )
  }

  if (stage === "kyc") {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="aspect-[1.586/1] w-[72%] max-w-md rounded-xl border-2 border-dashed border-amber-200/80 bg-amber-200/5 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]" />
        <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-black/55 px-2 py-1 text-[11px] text-amber-100">
          Align ID inside the frame
        </p>
      </div>
    )
  }

  // body_front / body_back
  return (
    <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-3">
      <svg
        viewBox="0 0 120 220"
        className="h-[88%] max-h-[520px] w-auto opacity-80"
        aria-hidden
      >
        <ellipse
          cx="60"
          cy="28"
          rx="18"
          ry="22"
          fill="none"
          stroke="rgba(94,234,212,0.85)"
          strokeWidth="3"
        />
        <path
          d="M35 58 C35 48, 85 48, 85 58 L92 150 C93 168, 80 175, 60 175 C40 175, 27 168, 28 150 Z"
          fill="none"
          stroke="rgba(94,234,212,0.85)"
          strokeWidth="3"
        />
        <path
          d="M40 175 L36 210 M80 175 L84 210"
          fill="none"
          stroke="rgba(94,234,212,0.7)"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-black/55 px-2 py-1 text-[11px] text-teal-100">
        {stage === "body_back" ? "Full body · facing away" : "Full body · facing camera"}
      </p>
    </div>
  )
}
