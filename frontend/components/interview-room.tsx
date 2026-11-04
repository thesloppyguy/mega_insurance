"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useLocalParticipant,
  useRoomContext,
} from "@livekit/components-react"
import { ConnectionState, RoomEvent, type RpcInvocationData } from "livekit-client"
import { toast } from "sonner"
import "@livekit/components-styles"

import { AadhaarOtpPopover } from "@/components/capture/aadhaar-otp-popover"
import { BodyCaptureOverlay } from "@/components/capture/body-capture-overlay"
import { FaceCaptureOverlay } from "@/components/capture/face-capture-overlay"
import { IdCaptureOverlay } from "@/components/capture/id-capture-overlay"
import { LocalCamera } from "@/components/local-camera"
import { OptiModelViewport } from "@/components/optimodel-avatar/OptiModelViewport"
import { useGsplatLipsync } from "@/hooks/useGsplatLipsync"
import {
  ocrIdCard,
  requestAadhaarOtp,
  uploadAsset,
  verifyAadhaarOtp,
} from "@/lib/api"
import {
  createPoseLandmarker,
  evaluateBodyFraming,
} from "@/lib/body-detect"
import type { CaptureStatus } from "@/lib/capture-guides"
import {
  createFaceLandmarker,
  evaluateFaceVisible,
} from "@/lib/face-detect"
import { addContext, captureVideoFrame } from "@/lib/rpc"

const OTP_RESEND_COOLDOWN_MS = 30_000
/** Consecutive good frames before auto-submit. */
const REQUIRED_STABLE_FRAMES = 5
/** Give up and show retry if framing never locks. */
const CAPTURE_TIMEOUT_MS = 90_000
const CAPTURE_TICK_MS = 150

type Props = {
  token: string
  serverUrl: string
  sessionId: string
  onLeave: () => void
}

type OverlayKind = "face" | "id" | "body" | "otp" | null

export function InterviewRoom(props: Props) {
  const leftRef = useRef(false)
  const onLeaveRef = useRef(props.onLeave)
  onLeaveRef.current = props.onLeave

  const leave = useCallback(() => {
    if (leftRef.current) return
    leftRef.current = true
    onLeaveRef.current()
  }, [])

  return (
    <LiveKitRoom
      token={props.token}
      serverUrl={props.serverUrl}
      connect
      video
      audio
      className="flex min-h-svh flex-col bg-zinc-100"
      onDisconnected={leave}
      onError={(err) => {
        const msg = err?.message?.toLowerCase?.() ?? ""
        if (
          msg.includes("closed") ||
          msg.includes("disconnect") ||
          msg.includes("pc connection")
        ) {
          leave()
          return
        }
        console.error(err)
      }}
    >
      <RoomAudioRenderer />
      <InterviewInner sessionId={props.sessionId} onLeave={leave} />
    </LiveKitRoom>
  )
}

function InterviewInner({
  sessionId,
  onLeave,
}: {
  sessionId: string
  onLeave: () => void
}) {
  const room = useRoomContext()
  const { localParticipant } = useLocalParticipant()
  const { flameFeed } = useGsplatLipsync(room)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const leavingRef = useRef(false)
  const captureInFlight = useRef(false)

  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [overlay, setOverlay] = useState<OverlayKind>(null)
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>("idle")
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [captureHint, setCaptureHint] = useState<string | null>(null)
  const [captureFramed, setCaptureFramed] = useState(false)
  const captureAttemptRef = useRef(0)
  const [otpCode, setOtpCode] = useState("")
  const [otpSubmitting, setOtpSubmitting] = useState(false)
  const [otpRequesting, setOtpRequesting] = useState(false)
  const [otpRequested, setOtpRequested] = useState(false)
  const [otpRequestError, setOtpRequestError] = useState<string | null>(null)
  const [otpResending, setOtpResending] = useState(false)
  const [otpResendAvailableAt, setOtpResendAvailableAt] = useState(0)
  const [otpNow, setOtpNow] = useState(() => Date.now())
  const otpSubmitInFlight = useRef(false)
  const otpResendInFlight = useRef(false)
  const otpRequestInFlight = useRef(false)
  const [otpMeta, setOtpMeta] = useState<{
    length: number
    hint: string
    aadhaar_number?: string
  } | null>(null)
  const [avatarStatus, setAvatarStatus] = useState("loading…")

  const setLocalVideoEl = useCallback((el: HTMLVideoElement | null) => {
    localVideoRef.current = el
  }, [])

  const clearOverlay = useCallback(() => {
    captureAttemptRef.current += 1
    setOverlay(null)
    setCaptureStatus("idle")
    setCaptureError(null)
    setCaptureHint(null)
    setCaptureFramed(false)
  }, [])

  const cancelIdCapture = useCallback(() => {
    clearOverlay()
    toast.message("ID capture cancelled")
  }, [clearOverlay])

  const endCall = useCallback(async () => {
    if (leavingRef.current) return
    leavingRef.current = true
    try {
      await localParticipant.setMicrophoneEnabled(false).catch(() => undefined)
      await localParticipant.setCameraEnabled(false).catch(() => undefined)
      await room.disconnect(true)
    } catch {
      // Already disconnected
    } finally {
      onLeave()
    }
  }, [localParticipant, onLeave, room])

  useEffect(() => {
    const onConn = (conn: ConnectionState) => {
      if (conn === ConnectionState.Disconnected) void endCall()
    }
    const onDisconnected = () => {
      void endCall()
    }
    room.on(RoomEvent.ConnectionStateChanged, onConn)
    room.on(RoomEvent.Disconnected, onDisconnected)
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onConn)
      room.off(RoomEvent.Disconnected, onDisconnected)
    }
  }, [endCall, room])

  const captureAndUpload = useCallback(
    async (kind: string, filename: string, meta?: Record<string, unknown>) => {
      const el = localVideoRef.current
      if (!el) throw new Error("Local camera preview not ready")
      const { blob } = await captureVideoFrame(el)
      await uploadAsset(sessionId, kind, blob, filename, meta)
      return blob
    },
    [sessionId]
  )

  const finishCapture = useCallback(
    async (
      type: "face_captured" | "id_captured" | "body_captured",
      kind: string,
      filename: string,
      state: string,
      details?: Record<string, unknown>
    ) => {
      if (captureInFlight.current) {
        return JSON.stringify({ ok: false, error: "busy" })
      }
      captureInFlight.current = true
      setCaptureStatus("uploading")
      setCaptureError(null)
      try {
        await captureAndUpload(kind, filename)
        setCaptureStatus("captured")
        await addContext(room, {
          type,
          state,
          action: "generate_reply",
          details,
        })
        const successLabel =
          type === "face_captured"
            ? "Face captured"
            : type === "body_captured"
              ? "Body captured"
              : "ID captured"
        toast.success(successLabel)
        // Brief “captured” beat so the UI can show success before closing.
        await new Promise((r) => setTimeout(r, 450))
        clearOverlay()
        return JSON.stringify({ ok: true, type })
      } catch (err) {
        const message = err instanceof Error ? err.message : "capture failed"
        setCaptureError(message)
        setCaptureStatus("failed")
        toast.error(message)
        return JSON.stringify({ ok: false, error: message })
      } finally {
        captureInFlight.current = false
      }
    },
    [captureAndUpload, clearOverlay, room]
  )

  const startValidatedCapture = useCallback(
    (
      kind: "face" | "body",
      type: "face_captured" | "body_captured",
      filename: string,
      state: string,
      details?: Record<string, unknown>
    ) => {
      captureAttemptRef.current += 1
      const attempt = captureAttemptRef.current
      setOverlay(kind)
      setCaptureStatus("scanning")
      setCaptureError(null)
      setCaptureHint(
        kind === "face"
          ? "Center your face in the oval"
          : "Stand back so your full body is in the silhouette"
      )
      setCaptureFramed(false)

      // Fire-and-forget: MediaPipe framing + upload must NOT block the LiveKit
      // RPC response (default ~10s). Completion is signaled via add_context.
      void (async () => {
        const startedAt = Date.now()
        let stableFrames = 0
        let landmarker: { close: () => void } | null = null

        try {
          if (kind === "face") {
            landmarker = await createFaceLandmarker()
          } else {
            landmarker = await createPoseLandmarker()
          }

          while (attempt === captureAttemptRef.current) {
            if (Date.now() - startedAt > CAPTURE_TIMEOUT_MS) {
              setCaptureError(
                kind === "face"
                  ? "We could not get a clear photo of your face. Please try again."
                  : "We could not get a clear photo of your body. Step back so shoulders and hips are visible, then try again."
              )
              setCaptureStatus("failed")
              setCaptureFramed(false)
              return
            }

            const video = localVideoRef.current
            if (
              video &&
              video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              video.videoWidth > 0
            ) {
              const ts = performance.now()
              if (kind === "face") {
                const faceLm = landmarker as Awaited<
                  ReturnType<typeof createFaceLandmarker>
                >
                const framing = evaluateFaceVisible(
                  faceLm.detectForVideo(video, ts)
                )
                setCaptureHint(framing.hint)
                setCaptureFramed(framing.faceVisible)
                stableFrames = framing.faceVisible ? stableFrames + 1 : 0
              } else {
                const poseLm = landmarker as Awaited<
                  ReturnType<typeof createPoseLandmarker>
                >
                const framing = evaluateBodyFraming(
                  poseLm.detectForVideo(video, ts)
                )
                setCaptureHint(framing.hintText)
                setCaptureFramed(framing.detected)
                stableFrames = framing.detected ? stableFrames + 1 : 0
              }

              if (stableFrames >= REQUIRED_STABLE_FRAMES) {
                if (attempt !== captureAttemptRef.current) return
                await finishCapture(type, kind, filename, state, details)
                return
              }
            }

            await new Promise((r) => setTimeout(r, CAPTURE_TICK_MS))
          }
        } catch (err) {
          if (attempt !== captureAttemptRef.current) return
          const message =
            err instanceof Error
              ? err.message
              : "Capture could not start. Please try again."
          setCaptureError(message)
          setCaptureStatus("failed")
          setCaptureFramed(false)
        }
      })()
    },
    [finishCapture]
  )

  const startValidatedCaptureRef = useRef(startValidatedCapture)
  startValidatedCaptureRef.current = startValidatedCapture

  // Warm MediaPipe so the first capture RPC doesn't stall on model download.
  useEffect(() => {
    void createFaceLandmarker().catch(() => undefined)
    void createPoseLandmarker().catch(() => undefined)
  }, [])

  useEffect(() => {
    // Stable handlers (refs) so we don't unregister/re-register RPCs on every
    // render — that gap is a common cause of "Response timeout".
    const onFace = async () => {
      startValidatedCaptureRef.current(
        "face",
        "face_captured",
        "face.jpg",
        "Face capture completed successfully."
      )
      return JSON.stringify({ ok: true, started: true, kind: "face" })
    }

    const onId = async () => {
      setOverlay("id")
      setCaptureStatus("scanning")
      setCaptureError(null)
      setCaptureHint(null)
      setCaptureFramed(false)
      toast.message("Hold your ID in the frame, then capture")
      return JSON.stringify({ ok: true, waiting: true })
    }

    const onBody = async () => {
      startValidatedCaptureRef.current(
        "body",
        "body_captured",
        "body.jpg",
        "Full body capture completed successfully.",
        { view: "front" }
      )
      return JSON.stringify({ ok: true, started: true, kind: "body" })
    }

    const onOtp = async (data: RpcInvocationData) => {
      let payload: {
        length?: number
        hint?: string
        aadhaar_number?: string
        aadhaarNumber?: string
      } = {}
      try {
        payload = JSON.parse(data.payload || "{}")
      } catch {
        /* empty */
      }
      const rawAadhaar =
        typeof payload.aadhaar_number === "string"
          ? payload.aadhaar_number
          : typeof payload.aadhaarNumber === "string"
            ? payload.aadhaarNumber
            : ""
      const aadhaarNumber = rawAadhaar.replace(/\s+/g, "").trim()
      if (!/^\d{12}$/.test(aadhaarNumber)) {
        return JSON.stringify({
          started: false,
          error: "aadhaar_number required (12 digits)",
        })
      }

      const length =
        typeof payload.length === "number" &&
        Number.isFinite(payload.length) &&
        payload.length >= 4 &&
        payload.length <= 12
          ? Math.floor(payload.length)
          : 6

      otpSubmitInFlight.current = false
      otpResendInFlight.current = false
      otpRequestInFlight.current = true
      setOtpMeta({
        length,
        hint:
          (typeof payload.hint === "string" && payload.hint.trim()) ||
          "Enter the Aadhaar OTP sent to your registered mobile",
        aadhaar_number: aadhaarNumber,
      })
      setOtpCode("")
      setOtpSubmitting(false)
      setOtpResending(false)
      setOtpRequestError(null)
      setOtpRequested(false)
      setOtpResendAvailableAt(0)
      setOtpRequesting(true)
      setOverlay("otp")

      void (async () => {
        try {
          await requestAadhaarOtp(sessionId, aadhaarNumber)
          setOtpRequested(true)
          setOtpResendAvailableAt(Date.now() + OTP_RESEND_COOLDOWN_MS)
          toast.success("Aadhaar OTP sent")
        } catch (err) {
          const detail =
            err instanceof Error ? err.message : "Could not request Aadhaar OTP"
          setOtpRequestError(detail)
          toast.error(detail)
        } finally {
          otpRequestInFlight.current = false
          setOtpRequesting(false)
        }
      })()

      return JSON.stringify({ started: true })
    }

    room.registerRpcMethod("start_face_capture", onFace)
    room.registerRpcMethod("start_id_capture", onId)
    room.registerRpcMethod("start_body_capture", onBody)
    room.registerRpcMethod("start_aadhaar_otp_input", onOtp)
    return () => {
      room.unregisterRpcMethod("start_face_capture")
      room.unregisterRpcMethod("start_id_capture")
      room.unregisterRpcMethod("start_body_capture")
      room.unregisterRpcMethod("start_aadhaar_otp_input")
    }
  }, [room, sessionId])

  const submitIdCapture = async () => {
    if (captureInFlight.current) return
    captureInFlight.current = true
    setCaptureStatus("uploading")
    setCaptureError(null)
    try {
      await captureAndUpload("id", "id.jpg")
      const ocr = await ocrIdCard(sessionId)
      setCaptureStatus("captured")
      await addContext(room, {
        type: "id_captured",
        state: ocr
          ? "ID card capture completed successfully. OCR results for the scanned document are included in the details for your reference. Confirm the document type matches what you requested, then continue."
          : "Identity document capture completed.",
        action: "generate_reply",
        details: ocr ? { ocr } : {},
      })
      toast.success("ID captured")
      await new Promise((r) => setTimeout(r, 450))
      clearOverlay()
    } catch (err) {
      const message = err instanceof Error ? err.message : "capture failed"
      setCaptureError(message)
      setCaptureStatus("failed")
      toast.error(message)
    } finally {
      captureInFlight.current = false
    }
  }

  const retryFace = () => {
    startValidatedCapture(
      "face",
      "face_captured",
      "face.jpg",
      "Face capture completed successfully."
    )
  }

  const retryBody = () => {
    startValidatedCapture(
      "body",
      "body_captured",
      "body.jpg",
      "Full body capture completed successfully.",
      { view: "front" }
    )
  }

  const retryId = () => {
    setCaptureStatus("scanning")
    setCaptureError(null)
  }

  useEffect(() => {
    if (otpResendAvailableAt <= Date.now()) return
    const timer = setInterval(() => setOtpNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [otpResendAvailableAt])

  const otpResendCooldownSeconds = Math.max(
    0,
    Math.ceil((otpResendAvailableAt - otpNow) / 1000)
  )
  const canResendOtp =
    otpResendCooldownSeconds === 0 &&
    !otpResending &&
    !otpRequesting &&
    Boolean(otpMeta?.aadhaar_number)

  const closeOtp = useCallback(() => {
    otpSubmitInFlight.current = false
    otpResendInFlight.current = false
    otpRequestInFlight.current = false
    setOverlay(null)
    setOtpMeta(null)
    setOtpCode("")
    setOtpSubmitting(false)
    setOtpResending(false)
    setOtpRequesting(false)
    setOtpRequestError(null)
    setOtpRequested(false)
  }, [])

  const submitOtp = async () => {
    const code = otpCode.trim()
    if (
      !code ||
      !otpMeta ||
      otpSubmitInFlight.current ||
      !otpRequested ||
      otpRequesting ||
      code.length !== otpMeta.length
    ) {
      return
    }

    otpSubmitInFlight.current = true
    setOtpSubmitting(true)
    try {
      const result = await verifyAadhaarOtp(sessionId, code)
      if (result.verified) {
        try {
          await addContext(room, {
            type: "aadhaar_otp_verified",
            state:
              "Aadhaar OTP verification succeeded. The candidate's Aadhaar has been verified. You may continue the conversation.",
            action: "generate_reply",
            details: {
              verifiedAt: Date.now(),
              aadhaarLast4: otpMeta.aadhaar_number?.slice(-4),
            },
          })
        } catch (err) {
          console.error("add_context after Aadhaar verify failed", err)
        }
        toast.success("Aadhaar verified")
        closeOtp()
        return
      }

      try {
        await addContext(room, {
          type: "aadhaar_otp_failed",
          state:
            "Aadhaar OTP verification failed. Ask the candidate to try again or request a new OTP.",
          action: "generate_reply",
          details: {
            failedAt: Date.now(),
            code: result.code ?? null,
          },
        })
      } catch (err) {
        console.error("add_context after Aadhaar verify failure failed", err)
      }
      toast.error("Invalid Aadhaar OTP. Please try again.")
      setOtpCode("")
    } catch (err) {
      const detail =
        err instanceof Error
          ? err.message
          : "Could not verify the code. Please try again."
      toast.error(detail)
      try {
        await addContext(room, {
          type: "aadhaar_otp_failed",
          state:
            "Aadhaar OTP verification failed. Ask the candidate to try again or request a new OTP.",
          action: "generate_reply",
          details: { failedAt: Date.now(), error: detail },
        })
      } catch (rpcErr) {
        console.error("add_context after Aadhaar verify error failed", rpcErr)
      }
    } finally {
      otpSubmitInFlight.current = false
      setOtpSubmitting(false)
    }
  }

  const resendOtp = async () => {
    const aadhaarNumber = otpMeta?.aadhaar_number
    const nowMs = Date.now()
    if (
      !aadhaarNumber ||
      otpResendInFlight.current ||
      otpRequestInFlight.current ||
      nowMs < otpResendAvailableAt
    ) {
      return
    }
    otpResendInFlight.current = true
    setOtpResending(true)
    setOtpRequestError(null)
    try {
      await requestAadhaarOtp(sessionId, aadhaarNumber)
      setOtpRequested(true)
      setOtpCode("")
      setOtpResendAvailableAt(nowMs + OTP_RESEND_COOLDOWN_MS)
      toast.success("Aadhaar OTP resent")
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : "Could not resend Aadhaar OTP"
      setOtpRequestError(detail)
      toast.error(detail)
    } finally {
      otpResendInFlight.current = false
      setOtpResending(false)
    }
  }

  return (
    <div className="relative flex min-h-svh flex-col bg-zinc-100 text-zinc-900">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-zinc-900">
        <LocalCamera
          onVideoEl={setLocalVideoEl}
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-white/90 px-2 py-1 text-xs font-medium text-zinc-700 shadow-sm">
          You
        </div>

        <div className="absolute right-3 bottom-24 z-10 w-[34vw] max-w-[280px] min-w-[140px] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg sm:bottom-28 sm:w-[26vw] sm:max-w-[320px]">
          <div className="relative aspect-[3/4] w-full bg-white">
            <OptiModelViewport
              flameFeed={flameFeed}
              avatarId="sanjay"
              onStatus={setAvatarStatus}
              className="absolute inset-0"
            />
            <div className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 shadow-sm">
              Sanjay · {avatarStatus}
            </div>
          </div>
        </div>

        {overlay === "face" ? (
          <FaceCaptureOverlay
            status={captureStatus}
            error={captureError}
            hint={captureHint ?? undefined}
            framed={captureFramed}
            onRetry={retryFace}
          />
        ) : null}

        {overlay === "body" ? (
          <BodyCaptureOverlay
            status={captureStatus}
            error={captureError}
            hint={captureHint ?? undefined}
            framed={captureFramed}
            onRetry={retryBody}
          />
        ) : null}

        {overlay === "id" ? (
          <IdCaptureOverlay
            status={captureStatus}
            error={captureError}
            onCapture={() => void submitIdCapture()}
            onCancel={cancelIdCapture}
            onRetry={retryId}
          />
        ) : null}

        {overlay === "otp" && otpMeta ? (
          <AadhaarOtpPopover
            meta={otpMeta}
            code={otpCode}
            onCodeChange={setOtpCode}
            submitting={otpSubmitting}
            requesting={otpRequesting}
            requestError={otpRequestError}
            otpRequested={otpRequested}
            resending={otpResending}
            resendCooldownSeconds={otpResendCooldownSeconds}
            canResend={canResendOtp}
            onSubmit={() => void submitOtp()}
            onResend={() => void resendOtp()}
            onCancel={closeOtp}
          />
        ) : null}
      </div>

      <div className="flex items-center justify-center gap-3 border-t border-zinc-200 bg-white/95 px-4 py-4 backdrop-blur">
        <button
          type="button"
          aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
          className={`rounded-full px-5 py-3 text-sm font-semibold transition ${
            micOn
              ? "bg-zinc-100 text-zinc-800 hover:bg-zinc-200"
              : "bg-rose-500 text-white hover:bg-rose-600"
          }`}
          onClick={async () => {
            const next = !micOn
            await localParticipant.setMicrophoneEnabled(next)
            setMicOn(next)
            toast.message(next ? "Microphone on" : "Microphone muted")
          }}
        >
          {micOn ? "Mic" : "Unmute"}
        </button>
        <button
          type="button"
          aria-label={camOn ? "Turn camera off" : "Turn camera on"}
          className={`rounded-full px-5 py-3 text-sm font-semibold transition ${
            camOn
              ? "bg-zinc-100 text-zinc-800 hover:bg-zinc-200"
              : "bg-rose-500 text-white hover:bg-rose-600"
          }`}
          onClick={async () => {
            const next = !camOn
            await localParticipant.setCameraEnabled(next)
            setCamOn(next)
            toast.message(next ? "Camera on" : "Camera off")
          }}
        >
          {camOn ? "Cam" : "Cam on"}
        </button>
        <button
          type="button"
          aria-label="End call"
          className="rounded-full bg-rose-500 px-6 py-3 text-sm font-semibold text-white hover:bg-rose-600"
          onClick={() => {
            toast.message("Ending session…")
            void endCall()
          }}
        >
          End
        </button>
      </div>
    </div>
  )
}
