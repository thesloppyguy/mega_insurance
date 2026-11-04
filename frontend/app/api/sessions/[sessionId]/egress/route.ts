import { requireWorker } from "@/lib/server/auth"
import {
  startRoomCompositeEgress,
  startTrackEgresses,
} from "@/lib/server/livekit"
import { getSession, updateSession } from "@/lib/server/store"

type Params = { params: Promise<{ sessionId: string }> }

export async function POST(req: Request, { params }: Params) {
  const denied = requireWorker(req)
  if (denied) return denied

  const { sessionId } = await params
  const session = await getSession(sessionId)
  if (!session) {
    return Response.json({ detail: "session not found" }, { status: 404 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    tracks?: Array<Record<string, unknown>>
    audio_only?: boolean
    composite?: boolean
  }

  const wantComposite =
    body.composite !== false && (!body.tracks || body.tracks.length === 0)

  try {
    let results: Array<Record<string, unknown>>
    if (wantComposite) {
      const one = await startRoomCompositeEgress({
        room_name: session.room_name,
        session_id: sessionId,
        audio_only: Boolean(body.audio_only),
      })
      results = [one]
    } else {
      results = await startTrackEgresses({
        room_name: session.room_name,
        tracks: body.tracks || [],
        audio_only: Boolean(body.audio_only),
      })
    }

    await updateSession(sessionId, {
      egress: [...(session.egress || []), ...results],
    })
    return Response.json({ ok: true, egresses: results })
  } catch (err) {
    console.error("egress start failed", err)
    return Response.json(
      { detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
