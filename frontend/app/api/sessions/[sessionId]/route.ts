import { getSession } from "@/lib/server/store"

type Params = { params: Promise<{ sessionId: string }> }

export async function GET(_req: Request, { params }: Params) {
  const { sessionId } = await params
  const session = await getSession(sessionId)
  if (!session) {
    return Response.json({ detail: "session not found" }, { status: 404 })
  }
  return Response.json(session)
}
