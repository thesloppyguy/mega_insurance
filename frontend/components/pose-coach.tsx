"use client"

import { useEffect, useRef, useState } from "react"
import type { Room } from "livekit-client"

import {
  assessPose,
  createPoseLandmarker,
  drawPoseOverlay,
  nextPoseTimestamp,
  recoverPoseLandmarkerOnCpu,
  releasePoseLandmarker,
  type PoseAssessment,
  type PoseLandmarker,
  type PoseLandmarkerResult,
  type PoseStatus,
} from "@/lib/pose"
import { sendPoseContext } from "@/lib/rpc"
import type { StageId } from "@/lib/stages"

type Props = {
  room: Room
  stage: StageId
  videoEl: HTMLVideoElement | null
  enabled?: boolean
  onAssessment?: (assessment: PoseAssessment) => void
}

const SEND_MIN_INTERVAL_MS = 2200
const OK_STABLE_MS = 1100
const ADJUST_RESEND_MS = 4500

export function PoseCoach({
  room,
  stage,
  videoEl,
  enabled = true,
  onAssessment,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastVideoTime = useRef(-1)
  const noseHistory = useRef<Array<{ t: number; x: number; y: number }>>([])
  const lastSentKey = useRef<string>("")
  const lastSentAt = useRef(0)
  const okSince = useRef<number | null>(null)
  const okNotifiedForStage = useRef<StageId | null>(null)
  const stageRef = useRef(stage)
  stageRef.current = stage
  const onAssessmentRef = useRef(onAssessment)
  onAssessmentRef.current = onAssessment

  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState<PoseStatus>("missing")
  const [tip, setTip] = useState("Loading pose tracker…")

  useEffect(() => {
    okSince.current = null
    okNotifiedForStage.current = null
    lastSentKey.current = ""
  }, [stage])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      try {
        const landmarker = await createPoseLandmarker()
        if (cancelled) {
          releasePoseLandmarker()
          return
        }
        landmarkerRef.current = landmarker
        setReady(true)
        setTip("Pose tracker ready")
      } catch (err) {
        console.error(err)
        setTip("Pose tracker unavailable — agent will rely on camera only")
      }
    })()
    return () => {
      cancelled = true
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      landmarkerRef.current = null
      setReady(false)
      releasePoseLandmarker()
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || !ready || !videoEl) return
    if (!landmarkerRef.current) return
    let recovering = false

    const tick = () => {
      rafRef.current = requestAnimationFrame(tick)
      const landmarker = landmarkerRef.current
      const canvas = canvasRef.current
      // Wait for a real decoded frame with intrinsic size — detecting earlier
      // triggers MediaPipe's NORM_RECT / IMAGE_DIMENSIONS warning.
      if (
        !landmarker ||
        !canvas ||
        videoEl.readyState < 2 ||
        videoEl.videoWidth < 16 ||
        videoEl.videoHeight < 16
      ) {
        return
      }
      if (videoEl.currentTime === lastVideoTime.current) return
      lastVideoTime.current = videoEl.currentTime

      const w = videoEl.clientWidth || videoEl.videoWidth
      const h = videoEl.clientHeight || videoEl.videoHeight
      if (w < 16 || h < 16) return
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }

      let result: PoseLandmarkerResult | null = null
      try {
        result = landmarker.detectForVideo(videoEl, nextPoseTimestamp())
      } catch (err) {
        console.warn("pose detect failed", err)
        // GPU graph can fatal mid-session; swap to CPU once and continue.
        if (!recovering) {
          recovering = true
          void recoverPoseLandmarkerOnCpu().then((recovered) => {
            recovering = false
            if (recovered) landmarkerRef.current = recovered
          })
        }
        return
      }

      const nose = result.landmarks?.[0]?.[0]
      const now = performance.now()
      if (nose) {
        noseHistory.current.push({ t: now, x: nose.x, y: nose.y })
        noseHistory.current = noseHistory.current.filter((p) => now - p.t < 900)
      }
      const hist = noseHistory.current
      let noseDelta = 0
      if (hist.length >= 2) {
        const first = hist[0]
        const last = hist[hist.length - 1]
        noseDelta = Math.hypot(last.x - first.x, last.y - first.y)
      }
      const stillFrames = hist.filter((p, i) => {
        if (i === 0) return true
        const prev = hist[i - 1]
        return Math.hypot(p.x - prev.x, p.y - prev.y) < 0.008
      }).length

      const currentStage = stageRef.current
      const assessment = assessPose(currentStage, result, {
        noseDelta,
        stillFrames,
      })
      setStatus(assessment.status)
      setTip(assessment.tips[0] || (assessment.status === "ok" ? "Pose looks good" : "Adjust your pose"))
      onAssessmentRef.current?.(assessment)

      const ctx = canvas.getContext("2d")
      if (ctx) drawPoseOverlay(ctx, canvas.width, canvas.height, result, assessment.status)

      void maybeSend(room, assessment, {
        lastSentKey,
        lastSentAt,
        okSince,
        okNotifiedForStage,
      })
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [enabled, ready, room, videoEl])

  if (!enabled) return null

  return (
    <>
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden
      />
      <div className="absolute top-3 right-3 max-w-[70%] rounded-md bg-black/55 px-2 py-1 text-[11px] text-zinc-100">
        <span
          className={
            status === "ok"
              ? "text-teal-300"
              : status === "adjust"
                ? "text-amber-200"
                : "text-rose-200"
          }
        >
          Pose · {status}
        </span>
        <span className="text-zinc-400"> · {tip}</span>
      </div>
    </>
  )
}

async function maybeSend(
  room: Room,
  assessment: PoseAssessment,
  refs: {
    lastSentKey: { current: string }
    lastSentAt: { current: number }
    okSince: { current: number | null }
    okNotifiedForStage: { current: StageId | null }
  }
) {
  if (assessment.stage === "done" || assessment.stage === "kyc") {
    // KYC needs ID readability; don't auto-spam pose_ok.
    if (assessment.stage === "kyc") {
      const key = `kyc:${assessment.status}:${assessment.tips[0] || ""}`
      const now = Date.now()
      if (key !== refs.lastSentKey.current && now - refs.lastSentAt.current > SEND_MIN_INTERVAL_MS) {
        refs.lastSentKey.current = key
        refs.lastSentAt.current = now
        await sendPoseContext(room, {
          stage: assessment.stage,
          status: assessment.status,
          score: assessment.score,
          tips: assessment.tips,
          metrics: assessment.metrics,
          pose_ok: false,
          action: "generate_reply",
        }).catch(() => undefined)
      }
    }
    return
  }

  const now = Date.now()
  if (assessment.status === "ok") {
    if (refs.okSince.current == null) refs.okSince.current = now
    const stable = now - refs.okSince.current >= OK_STABLE_MS
    if (
      stable &&
      refs.okNotifiedForStage.current !== assessment.stage &&
      now - refs.lastSentAt.current > SEND_MIN_INTERVAL_MS
    ) {
      refs.okNotifiedForStage.current = assessment.stage
      refs.lastSentAt.current = now
      refs.lastSentKey.current = `ok:${assessment.stage}`
      // Context only — agent decides when to call request_capture.
      await sendPoseContext(room, {
        stage: assessment.stage,
        status: "ok",
        score: assessment.score,
        tips: [],
        metrics: assessment.metrics,
        pose_ok: true,
        action: "context_only",
      }).catch(() => undefined)
    }
    return
  }

  refs.okSince.current = null
  const tip = assessment.tips[0] || assessment.status
  const key = `${assessment.stage}:${assessment.status}:${tip}`
  const due =
    key !== refs.lastSentKey.current
      ? now - refs.lastSentAt.current > SEND_MIN_INTERVAL_MS
      : now - refs.lastSentAt.current > ADJUST_RESEND_MS
  if (!due) return
  refs.lastSentKey.current = key
  refs.lastSentAt.current = now
  await sendPoseContext(room, {
    stage: assessment.stage,
    status: assessment.status,
    score: assessment.score,
    tips: assessment.tips.slice(0, 3),
    metrics: assessment.metrics,
    pose_ok: false,
    action: "generate_reply",
  }).catch(() => undefined)
}
