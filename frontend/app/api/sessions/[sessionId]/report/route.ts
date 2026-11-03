import { requireWorker } from "@/lib/server/auth"
import { API_PUBLIC_BASE_URL } from "@/lib/server/config"
import { getSession, updateSession } from "@/lib/server/store"

type Params = { params: Promise<{ sessionId: string }> }

export async function GET(_req: Request, { params }: Params) {
  const { sessionId } = await params
  const session = await getSession(sessionId)
  if (!session) {
    return Response.json({ detail: "session not found" }, { status: 404 })
  }
  return Response.json({
    session_id: sessionId,
    status: session.status,
    livekit_report: session.livekit_report,
    underwriting_report: session.underwriting_report,
    usage: session.usage,
    metrics: session.metrics,
    assets: session.assets,
    events: session.events,
    egress: session.egress,
    api_base: API_PUBLIC_BASE_URL,
  })
}

export async function POST(req: Request, { params }: Params) {
  const denied = requireWorker(req)
  if (denied) return denied

  const { sessionId } = await params
  const session = await getSession(sessionId)
  if (!session) {
    return Response.json({ detail: "session not found" }, { status: 404 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    report?: Record<string, unknown>
    usage?: unknown
    metrics?: Array<Record<string, unknown>>
    is_final?: boolean
    underwriting_report?: Record<string, unknown> | null
  }

  const patch: Record<string, unknown> = {
    livekit_report: body.report || {},
    usage: body.usage,
    metrics: body.metrics || [],
  }
  if (body.underwriting_report != null) {
    patch.underwriting_report = body.underwriting_report
  }

  const updated = await updateSession(sessionId, patch)
  return Response.json({
    ok: true,
    session_id: updated?.session_id || sessionId,
  })
}
