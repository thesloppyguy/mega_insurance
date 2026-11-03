import { requireWorker } from "@/lib/server/auth"
import { appendEvent } from "@/lib/server/store"

type Params = { params: Promise<{ sessionId: string }> }

export async function POST(req: Request, { params }: Params) {
  const denied = requireWorker(req)
  if (denied) return denied

  const { sessionId } = await params
  const body = (await req.json().catch(() => ({}))) as {
    event_type?: string
    actor?: string
    payload?: Record<string, unknown>
  }

  if (!body.event_type) {
    return Response.json({ detail: "event_type required" }, { status: 400 })
  }

  const updated = await appendEvent(sessionId, {
    event_type: body.event_type,
    actor: body.actor || "WORKER",
    payload: body.payload || {},
  })
  if (!updated) {
    return Response.json({ detail: "session not found" }, { status: 404 })
  }
  return Response.json({ ok: true })
}
