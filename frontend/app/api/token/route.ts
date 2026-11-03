import { LIVEKIT_URL } from "@/lib/server/config"
import { buildAgentDispatchMetadata } from "@/lib/server/dispatch"
import { mintToken } from "@/lib/server/livekit"
import { getSession } from "@/lib/server/store"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    session_id?: string
    participant_name?: string
  }

  if (!body.session_id) {
    return Response.json({ detail: "session_id required" }, { status: 400 })
  }

  const session = await getSession(body.session_id)
  if (!session) {
    return Response.json({ detail: "session not found" }, { status: 404 })
  }

  const name =
    body.participant_name || session.participant_name || "Candidate"
  const identity = `user_${session.session_id}`
  const metadata = buildAgentDispatchMetadata(session)

  try {
    const token = await mintToken({
      room_name: session.room_name,
      identity,
      name,
      metadata,
    })
    return Response.json({
      serverUrl: LIVEKIT_URL,
      participantToken: token,
      participantName: name,
      roomName: session.room_name,
      sessionId: session.session_id,
    })
  } catch (err) {
    console.error("token mint failed", err)
    return Response.json(
      { detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
