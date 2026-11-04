"use client"

import {
  CaptureCameraPreview,
  useCaptureFrameSize,
} from "@/components/capture/capture-camera-preview"
import {
  captureGuideTone,
  FaceGuideMask,
} from "@/components/capture/capture-guide-mask"
import { CaptureStatusRow } from "@/components/capture/capture-status-row"
import { faceGuideRect, type CaptureStatus } from "@/lib/capture-guides"

type Props = {
  status: CaptureStatus
  error?: string | null
  hint?: string
  /** Live MediaPipe framing ready (green guide). */
  framed?: boolean
  onRetry?: () => void
}

/** Modal with face oval guide — light UI matching optimind. */
export function FaceCaptureOverlay({
  status,
  error,
  hint = "Center your face in the oval and hold still.",
  framed = false,
  onRetry,
}: Props) {
  const { width, height } = useCaptureFrameSize()
  const guide = faceGuideRect(width, height)
  const tone = captureGuideTone({
    detected:
      framed || status === "uploading" || status === "captured",
    found: status === "scanning" && !framed,
  })

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="face-capture-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/85 p-4 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-2xl flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-xl">
        <div>
          <h2
            id="face-capture-title"
            className="text-lg font-semibold text-zinc-900"
          >
            Verify your face
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            Center your face in the oval. We capture and submit automatically
            once you hold still.
          </p>
        </div>

        <CaptureCameraPreview>
          <FaceGuideMask guide={guide} tone={tone} />
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
