import type { Room } from "livekit-client"
import { RoomEvent, ParticipantKind } from "livekit-client"

export type AddContextPayload = {
  type: string
  state: string
  action: "generate_reply" | "say"
  details?: Record<string, unknown>
}

export function findAgentIdentity(room: Room): string | null {
  for (const p of room.remoteParticipants.values()) {
    const attrs = p.attributes || {}
    if (p.kind === ParticipantKind.AGENT && !attrs["lk.publish_on_behalf"]) {
      return p.identity
    }
  }
  // Fallback: any remote that looks like the worker (not avatar)
  for (const p of room.remoteParticipants.values()) {
    const id = p.identity || ""
    if (!id.includes("anam") && !attrsHasBehalf(p.attributes)) {
      if (p.kind === ParticipantKind.AGENT) return p.identity
    }
  }
  return null
}

function attrsHasBehalf(attrs: Record<string, string> | undefined) {
  return Boolean(attrs?.["lk.publish_on_behalf"])
}

export async function waitForAgent(room: Room, timeoutMs = 20000): Promise<string> {
  const existing = findAgentIdentity(room)
  if (existing) return existing
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("Timed out waiting for agent"))
    }, timeoutMs)
    const onParticipant = () => {
      const id = findAgentIdentity(room)
      if (id) {
        cleanup()
        resolve(id)
      }
    }
    const cleanup = () => {
      clearTimeout(timer)
      room.off(RoomEvent.ParticipantConnected, onParticipant)
    }
    room.on(RoomEvent.ParticipantConnected, onParticipant)
  })
}

export async function addContext(room: Room, payload: AddContextPayload) {
  const agentId = await waitForAgent(room)
  await room.localParticipant.performRpc({
    destinationIdentity: agentId,
    method: "add_context",
    payload: JSON.stringify(payload),
  })
}

export type PoseContextPayload = {
  stage: string
  status: string
  score: number
  tips: string[]
  metrics: Record<string, number | boolean | null>
  pose_ok: boolean
  action?: "generate_reply" | "silent" | "context_only"
}

/** Push MediaPipe pose assessment to the worker so the agent can coach without being asked. */
export async function sendPoseContext(room: Room, payload: PoseContextPayload) {
  const agentId = await waitForAgent(room)
  return room.localParticipant.performRpc({
    destinationIdentity: agentId,
    method: "pose_context",
    payload: JSON.stringify(payload),
    responseTimeout: 8000,
  })
}

export async function captureVideoFrame(
  videoEl: HTMLVideoElement
): Promise<{ blob: Blob; dataUrl: string }> {
  const canvas = document.createElement("canvas")
  canvas.width = videoEl.videoWidth || 1280
  canvas.height = videoEl.videoHeight || 720
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("canvas unsupported")
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height)
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92)
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      0.92
    )
  })
  return { blob, dataUrl }
}
