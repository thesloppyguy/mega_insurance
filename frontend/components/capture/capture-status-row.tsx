"use client"

import type { CaptureStatus } from "@/lib/capture-guides"

type Props = {
  status: CaptureStatus
  error?: string | null
  hint?: string
  uploadingLabel: string
  capturedLabel: string
  onRetry?: () => void
}

export function CaptureStatusRow({
  status,
  error,
  hint,
  uploadingLabel,
  capturedLabel,
  onRetry,
}: Props) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-4">
      <p
        aria-live="polite"
        className={`flex items-center gap-2 text-sm ${
          status === "failed" ? "text-rose-600" : "text-zinc-600"
        }`}
      >
        {(status === "uploading" || status === "captured") && (
          <span
            aria-hidden
            className="inline-block size-4 animate-spin rounded-full border-2 border-teal-500/30 border-t-teal-600"
          />
        )}
        {status === "uploading"
          ? uploadingLabel
          : status === "captured"
            ? capturedLabel
            : status === "failed"
              ? error || "Capture failed"
              : hint}
      </p>
      {status === "failed" && onRetry ? (
        <button
          type="button"
          className="shrink-0 rounded-lg bg-teal-500 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-600"
          onClick={onRetry}
        >
          Try again
        </button>
      ) : null}
    </div>
  )
}
