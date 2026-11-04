"use client"

import {
  CaptureCameraPreview,
  useCaptureFrameSize,
} from "@/components/capture/capture-camera-preview"
import { idGuideRect, type CaptureStatus } from "@/lib/capture-guides"

type Props = {
  status: CaptureStatus
  error?: string | null
  hint?: string
  onCapture: () => void
  onCancel: () => void
  onRetry?: () => void
}

/** Modal with ID card guide — light UI matching optimind. */
export function IdCaptureOverlay({
  status,
  error,
  hint = "Hold the front of your government-issued ID up to the camera.",
  onCapture,
  onCancel,
  onRetry,
}: Props) {
  const { width, height } = useCaptureFrameSize()
  const guide = idGuideRect(width, height)
  const scanning = status === "scanning"
  const borderClass =
    status === "uploading" || status === "captured"
      ? "border-emerald-500"
      : scanning
        ? "border-white/90"
        : "border-amber-400"

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="id-capture-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/85 p-4 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-2xl flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-xl">
        <div>
          <h2
            id="id-capture-title"
            className="text-lg font-semibold text-zinc-900"
          >
            Verify your ID
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            Hold the front of your government-issued ID up to the camera, then
            capture when it is clearly in focus.
          </p>
        </div>

        <CaptureCameraPreview>
          <div
            aria-hidden
            className={`absolute rounded-[4%] border-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] transition-colors ${borderClass}`}
            style={{
              left: `${guide.x * 100}%`,
              top: `${guide.y * 100}%`,
              width: `${guide.width * 100}%`,
              height: `${guide.height * 100}%`,
            }}
          />
        </CaptureCameraPreview>

        <div className="flex min-h-9 items-center justify-between gap-4">
          <p
            aria-live="polite"
            className={`flex items-center gap-2 text-sm ${
              status === "failed" ? "text-rose-600" : "text-zinc-600"
            }`}
          >
            {status === "uploading" && (
              <span
                aria-hidden
                className="inline-block size-4 animate-spin rounded-full border-2 border-teal-500/30 border-t-teal-600"
              />
            )}
            {status === "uploading"
              ? "Uploading and reading your ID…"
              : status === "captured"
                ? "ID captured. Continuing…"
                : status === "failed"
                  ? error || "Capture failed"
                  : hint}
          </p>

          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              onClick={onCancel}
              disabled={status === "uploading"}
            >
              Cancel
            </button>
            {status === "failed" && onRetry ? (
              <button
                type="button"
                className="rounded-lg bg-teal-500 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-600"
                onClick={onRetry}
              >
                Try again
              </button>
            ) : (
              <button
                type="button"
                className="rounded-lg bg-teal-500 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-600 disabled:opacity-50"
                onClick={onCapture}
                disabled={status !== "scanning"}
              >
                Capture ID
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
