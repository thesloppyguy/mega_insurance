"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useLocalParticipant,
  useRoomContext,
  useVoiceAssistant,
  VideoTrack,
} from "@livekit/components-react"
import "@livekit/components-styles"

import { LocalCamera } from "@/components/local-camera"
import { addContext, captureVideoFrame } from "@/lib/rpc"
import { uploadAsset } from "@/lib/api"

const STEPS = [
  { id: "precheck", label: "Lighting" },
  { id: "face", label: "Face" },
  { id: "liveness", label: "Liveness" },
  { id: "kyc", label: "KYC ID" },
  { id: "body_front", label: "Body front" },
  { id: "body_back", label: "Body back" },
  { id: "done", label: "Done" },
] as const

type StepId = (typeof STEPS)[number]["id"]

const DISCLOSURE =
  "AI estimates only — not clinical measurements, medical advice, or a diagnosis."

type Props = {
  token: string
  serverUrl: string
  sessionId: string
  onLeave: () => void
}

export function InterviewRoom(props: Props) {
  return (
    <LiveKitRoom
      token={props.token}
      serverUrl={props.serverUrl}
      connect
      video
      audio
      className="flex min-h-svh flex-col"
      onDisconnected={props.onLeave}
    >
      <RoomAudioRenderer />
      <InterviewInner sessionId={props.sessionId} onLeave={props.onLeave} />
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
  const { state, videoTrack } = useVoiceAssistant()
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("Connecting…")
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)

  const step = STEPS[stepIndex]

  useEffect(() => {
    setStatus(state ? `Agent: ${state}` : "Waiting for agent…")
  }, [state])

  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        void addContext(room, {
          type: "proctor_signal",
          state: "Candidate switched away from the interview tab.",
          action: "generate_reply",
          details: {
            looking_away: true,
            severity: "medium",
            message: "Tab hidden / focus lost",
          },
        }).catch(() => undefined)
      }
    }
    document.addEventListener("visibilitychange", onVis)
    return () => document.removeEventListener("visibilitychange", onVis)
  }, [room])

  const captureNow = useCallback(async () => {
    const el = localVideoRef.current
    if (!el) throw new Error("Local camera preview not ready")
    return captureVideoFrame(el)
  }, [])

  const runStepCapture = useCallback(async () => {
    if (!step || step.id === "done") return
    setBusy(true)
    try {
      if (step.id === "liveness") {
        const frames: string[] = []
        for (let i = 0; i < 4; i++) {
          const { dataUrl, blob } = await captureNow()
          frames.push(dataUrl)
          await uploadAsset(sessionId, "liveness", blob, `liveness_${i}.jpg`)
          await new Promise((r) => setTimeout(r, 350))
        }
        await addContext(room, {
          type: "liveness_captured",
          state: "Liveness frame sequence captured.",
          action: "generate_reply",
          details: { images_base64: frames },
        })
      } else {
        const { dataUrl, blob } = await captureNow()
        const map: Record<
          string,
          { type: string; kind: string; state: string; view?: string }
        > = {
          precheck: {
            type: "precheck",
            kind: "precheck",
            state: "Lighting and framing precheck frame captured.",
          },
          face: {
            type: "face_captured",
            kind: "face",
            state: "Face enrollment capture completed.",
          },
          kyc: {
            type: "id_captured",
            kind: "kyc_id",
            state: "KYC identity document captured.",
          },
          body_front: {
            type: "body_captured",
            kind: "body_front",
            state: "Full body front capture completed.",
            view: "front",
          },
          body_back: {
            type: "body_captured",
            kind: "body_back",
            state: "Full body back capture completed.",
            view: "back",
          },
        }
        const cfg = map[step.id]
        if (!cfg) return
        await uploadAsset(sessionId, cfg.kind, blob, `${cfg.kind}.jpg`, {
          view: cfg.view,
        })
        await addContext(room, {
          type: cfg.type,
          state: cfg.state,
          action: "generate_reply",
          details: {
            image_base64: dataUrl,
            view: cfg.view,
          },
        })
      }
      setStepIndex((i) => Math.min(i + 1, STEPS.length - 1))
      setStatus(`Captured ${step.label}`)
    } catch (err) {
      console.error(err)
      setStatus(err instanceof Error ? err.message : "Capture failed")
    } finally {
      setBusy(false)
    }
  }, [captureNow, room, sessionId, step])

  const stepHint = useMemo(() => {
    switch (step?.id as StepId) {
      case "precheck":
        return "Sit in good light, face the camera, shoulders visible."
      case "face":
        return "Hold still for a clear frontal selfie."
      case "liveness":
        return "Blink and slowly turn your head while we capture a few frames."
      case "kyc":
        return "Hold your government ID steady in frame."
      case "body_front":
        return "Stand back so your full body is visible from the front."
      case "body_back":
        return "Turn around for a full-body back view."
      default:
        return "Interview steps complete. You can end the call and view the report."
    }
  }, [step])

  return (
    <div className="grid min-h-svh grid-rows-[auto_1fr_auto] bg-[radial-gradient(ellipse_at_top,_#1a2332_0%,_#0b0f14_55%)] text-zinc-100">
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <p className="text-xs tracking-[0.2em] text-teal-300/80 uppercase">Mavrik</p>
          <h1 className="font-serif text-xl text-zinc-50">Underwriting interview</h1>
        </div>
        <div className="text-right text-xs text-zinc-400">
          <div>{status}</div>
          <div className="mt-1 max-w-xs text-[10px] leading-snug text-amber-200/70">
            {DISCLOSURE}
          </div>
        </div>
      </header>

      <main className="grid gap-4 p-4 lg:grid-cols-[1.2fr_1fr]">
        <section className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/40">
          {videoTrack ? (
            <VideoTrack
              trackRef={videoTrack}
              className="h-full max-h-[70vh] w-full object-cover"
            />
          ) : (
            <div className="flex h-[50vh] items-center justify-center text-zinc-500">
              Waiting for Anam avatar…
            </div>
          )}
          <div className="absolute bottom-3 left-3 rounded-md bg-black/50 px-2 py-1 text-xs">
            Avatar
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/40">
            <LocalCamera onVideoEl={(el) => (localVideoRef.current = el)} />
            <div className="absolute bottom-3 left-3 rounded-md bg-black/50 px-2 py-1 text-xs">
              You
            </div>
          </div>

          <ol className="flex flex-wrap gap-2">
            {STEPS.map((s, idx) => (
              <li
                key={s.id}
                className={`rounded-full px-3 py-1 text-xs ${
                  idx === stepIndex
                    ? "bg-teal-500 text-black"
                    : idx < stepIndex
                      ? "bg-teal-500/20 text-teal-200"
                      : "bg-white/5 text-zinc-400"
                }`}
              >
                {s.label}
              </li>
            ))}
          </ol>

          <p className="text-sm text-zinc-300">{stepHint}</p>

          <div className="mt-auto flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || step?.id === "done"}
              onClick={() => void runStepCapture()}
              className="rounded-lg bg-teal-400 px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
            >
              {busy ? "Working…" : step?.id === "done" ? "Complete" : `Capture ${step?.label}`}
            </button>
            <button
              type="button"
              className="rounded-lg border border-white/15 px-4 py-2 text-sm"
              onClick={async () => {
                await localParticipant.setMicrophoneEnabled(!micOn)
                setMicOn(!micOn)
              }}
            >
              {micOn ? "Mute" : "Unmute"}
            </button>
            <button
              type="button"
              className="rounded-lg border border-white/15 px-4 py-2 text-sm"
              onClick={async () => {
                await localParticipant.setCameraEnabled(!camOn)
                setCamOn(!camOn)
              }}
            >
              {camOn ? "Camera off" : "Camera on"}
            </button>
            <a
              href={`/report/${sessionId}`}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm"
            >
              Report
            </a>
            <button
              type="button"
              className="rounded-lg border border-rose-400/40 px-4 py-2 text-sm text-rose-200"
              onClick={() => {
                void room.disconnect()
                onLeave()
              }}
            >
              End
            </button>
          </div>
        </section>
      </main>
    </div>
  )
}
