"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useLocalParticipant,
  useRoomContext,
  useVoiceAssistant,
  VideoTrack,
} from "@livekit/components-react"
import { ConnectionState, RoomEvent, type RpcInvocationData } from "livekit-client"
import "@livekit/components-styles"

import { LocalCamera } from "@/components/local-camera"
import { uploadAsset } from "@/lib/api"
import { captureVideoFrame } from "@/lib/rpc"
import {
  assetKindForStage,
  isStageId,
  type StageId,
} from "@/lib/stages"

type Props = {
  token: string
  serverUrl: string
  sessionId: string
  onLeave: () => void
}

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
      className="flex min-h-svh flex-col bg-[#0b0f14]"
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
  const { state, videoTrack } = useVoiceAssistant()
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const leavingRef = useRef(false)
  const captureInFlight = useRef(false)

  const [stage, setStage] = useState<StageId>("precheck")
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)

  const hasAgentVideo = Boolean(videoTrack)
  const agentListening = state === "listening" || state === "thinking"

  const setLocalVideoEl = useCallback((el: HTMLVideoElement | null) => {
    localVideoRef.current = el
  }, [])

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

  const captureNow = useCallback(async () => {
    const el = localVideoRef.current
    if (!el) throw new Error("Local camera preview not ready")
    return captureVideoFrame(el)
  }, [])

  const runStageCapture = useCallback(async () => {
    if (stage === "done") {
      return { ok: true, stage, skipped: true }
    }
    if (leavingRef.current || room.state === ConnectionState.Disconnected) {
      return { ok: false, error: "disconnected" }
    }
    if (captureInFlight.current) {
      return { ok: false, error: "busy" }
    }
    captureInFlight.current = true
    try {
      const kind = assetKindForStage(stage)
      if (!kind) return { ok: true, stage, skipped: true }

      if (stage === "liveness") {
        for (let i = 0; i < 4; i++) {
          const { blob } = await captureNow()
          await uploadAsset(sessionId, "liveness", blob, `liveness_${i}.jpg`)
          await new Promise((r) => setTimeout(r, 300))
        }
      } else {
        const { blob } = await captureNow()
        const meta =
          stage === "body_front"
            ? { view: "front" }
            : stage === "body_back"
              ? { view: "back" }
              : undefined
        await uploadAsset(sessionId, kind, blob, `${kind}.jpg`, meta)
      }

      return { ok: true, stage, kind }
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message : "Capture failed"
      return { ok: false, error: message }
    } finally {
      captureInFlight.current = false
    }
  }, [captureNow, room.state, sessionId, stage])

  const runStageCaptureRef = useRef(runStageCapture)
  runStageCaptureRef.current = runStageCapture

  useEffect(() => {
    const onSetStage = async (data: RpcInvocationData) => {
      try {
        const payload = JSON.parse(data.payload || "{}") as {
          stage?: string
          guidance?: string
        }
        const next = payload.stage || ""
        if (!isStageId(next)) {
          return JSON.stringify({ ok: false, error: `invalid stage: ${next}` })
        }
        setStage(next)
        return JSON.stringify({ ok: true, stage: next })
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : "set_stage failed",
        })
      }
    }

    const onPrepareCapture = async (data: RpcInvocationData) => {
      try {
        const payload = JSON.parse(data.payload || "{}") as { stage?: string }
        await new Promise((r) => setTimeout(r, 450))
        return JSON.stringify({
          ok: true,
          prepared: true,
          stage: payload.stage || stage,
        })
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : "prepare_capture failed",
        })
      }
    }

    const onRequestCapture = async (data: RpcInvocationData) => {
      try {
        const payload = JSON.parse(data.payload || "{}") as {
          message?: string
          source?: string
        }
        if (payload.source && payload.source !== "agent") {
          return JSON.stringify({
            ok: false,
            error: "capture_not_agent_initiated",
          })
        }
        await new Promise((r) => setTimeout(r, 250))
        const result = await runStageCaptureRef.current()
        return JSON.stringify(result)
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : "request_capture failed",
        })
      }
    }

    room.registerRpcMethod("set_stage", onSetStage)
    room.registerRpcMethod("prepare_capture", onPrepareCapture)
    room.registerRpcMethod("request_capture", onRequestCapture)
    return () => {
      room.unregisterRpcMethod("set_stage")
      room.unregisterRpcMethod("prepare_capture")
      room.unregisterRpcMethod("request_capture")
    }
  }, [room, stage])

  return (
    <div className="relative flex min-h-svh flex-col bg-[#0b0f14] text-zinc-100">
      {/* Primary: local user camera (Meet-style main tile) */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <LocalCamera
          onVideoEl={setLocalVideoEl}
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-black/55 px-2 py-1 text-xs text-zinc-200">
          You
        </div>

        {/* Secondary: agent avatar / video PiP */}
        <div className="absolute right-3 bottom-24 z-10 w-[28vw] max-w-[220px] min-w-[120px] overflow-hidden rounded-xl border border-white/15 bg-[#151a22] shadow-lg sm:bottom-28 sm:w-[22vw] sm:max-w-[260px]">
          <div className="relative aspect-video w-full">
            {hasAgentVideo ? (
              <VideoTrack
                trackRef={videoTrack}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[#151a22]">
                <div
                  className={`flex h-14 w-14 items-center justify-center rounded-full border ${
                    agentListening
                      ? "animate-pulse border-teal-300/60 bg-teal-400/15"
                      : "border-white/15 bg-white/5"
                  }`}
                >
                  <span className="font-serif text-lg text-teal-100">M</span>
                </div>
              </div>
            )}
            <div className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-zinc-200">
              Interviewer
            </div>
          </div>
        </div>
      </div>

      {/* Controls: Mic · Cam · End only */}
      <div className="flex items-center justify-center gap-3 border-t border-white/10 bg-[#0b0f14]/95 px-4 py-4 backdrop-blur">
        <button
          type="button"
          aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
          className={`rounded-full px-5 py-3 text-sm font-medium transition ${
            micOn
              ? "bg-white/10 text-zinc-100 hover:bg-white/15"
              : "bg-rose-500/90 text-white hover:bg-rose-500"
          }`}
          onClick={async () => {
            await localParticipant.setMicrophoneEnabled(!micOn)
            setMicOn(!micOn)
          }}
        >
          {micOn ? "Mic" : "Unmute"}
        </button>
        <button
          type="button"
          aria-label={camOn ? "Turn camera off" : "Turn camera on"}
          className={`rounded-full px-5 py-3 text-sm font-medium transition ${
            camOn
              ? "bg-white/10 text-zinc-100 hover:bg-white/15"
              : "bg-rose-500/90 text-white hover:bg-rose-500"
          }`}
          onClick={async () => {
            await localParticipant.setCameraEnabled(!camOn)
            setCamOn(!camOn)
          }}
        >
          {camOn ? "Cam" : "Cam on"}
        </button>
        <button
          type="button"
          aria-label="End call"
          className="rounded-full bg-rose-600 px-6 py-3 text-sm font-medium text-white hover:bg-rose-500"
          onClick={() => void endCall()}
        >
          End
        </button>
      </div>
    </div>
  )
}
