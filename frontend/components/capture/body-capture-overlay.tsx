"use client"

import {
  CaptureCameraPreview,
  useCaptureFrameSize,
} from "@/components/capture/capture-camera-preview"
import {
  BodyGuideMask,
  captureGuideTone,
} from "@/components/capture/capture-guide-mask"
import { CaptureStatusRow } from "@/components/capture/capture-status-row"
import { bodyGuideRect, type CaptureStatus } from "@/lib/capture-guides"

type Props = {
  status: CaptureStatus
  error?: string | null
  hint?: string
  /** Live MediaPipe framing ready (green guide). */
  framed?: boolean
  onRetry?: () => void
}

/** Modal with body silhouette guide — light UI matching optimind. */
export function BodyCaptureOverlay({
  status,
  error,
  hint = "Stand so your full body lines up with the silhouette.",
  framed = false,
  onRetry,
}: Props) {
  const { width, height } = useCaptureFrameSize()
  const guide = bodyGuideRect(width, height)
  const tone = captureGuideTone({
    detected:
      framed || status === "uploading" || status === "captured",
    found: status === "scanning" && !framed,
  })

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="body-capture-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/85 p-4 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-2xl flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-xl">
        <div>
          <h2
            id="body-capture-title"
            className="text-lg font-semibold text-zinc-900"
          >
            Verify your body position
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            Stand so your full body lines up with the silhouette. We capture and
            submit automatically once you hold still.
          </p>
        </div>

        <CaptureCameraPreview>
          <BodyGuideMask guide={guide} tone={tone} />
        </CaptureCameraPreview>

        <CaptureStatusRow
          status={status}
          error={error}
          hint={hint}
          uploadingLabel="Uploading your photo…"
          capturedLabel="Photo captured. Continuing…"
          onRetry={onRetry}
        />
      </div>
    </div>
  )
}
