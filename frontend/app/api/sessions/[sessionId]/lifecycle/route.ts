import { requireWorker } from "@/lib/server/auth"
import { updateSession } from "@/lib/server/store"

type Params = { params: Promise<{ sessionId: string }> }

export async function PATCH(req: Request, { params }: Params) {
  const denied = requireWorker(req)
  if (denied) return denied

  const { sessionId } = await params
  const body = (await req.json().catch(() => ({}))) as {
    status?: string
    livekit_job_id?: string | null
    end_reason?: string | null
  }

  if (!body.status) {
    return Response.json({ detail: "status required" }, { status: 400 })
  }

  const patch: Record<string, unknown> = { status: body.status }
  if (body.livekit_job_id !== undefined) patch.livekit_job_id = body.livekit_job_id
  if (body.end_reason !== undefined) patch.end_reason = body.end_reason

  const session = await updateSession(sessionId, patch)
  if (!session) {
    return Response.json({ detail: "session not found" }, { status: 404 })
  }
  return Response.json({ ok: true, status: session.status })
}
