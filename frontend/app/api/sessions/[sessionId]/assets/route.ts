import { getSession, saveAsset } from "@/lib/server/store"

type Params = { params: Promise<{ sessionId: string }> }

export async function POST(req: Request, { params }: Params) {
  const { sessionId } = await params
  if (!(await getSession(sessionId))) {
    return Response.json({ detail: "session not found" }, { status: 404 })
  }

  const form = await req.formData()
  const kind = String(form.get("kind") || "")
  const file = form.get("file")
  const metaJson = form.get("meta_json")

  if (!kind || !(file instanceof File)) {
    return Response.json(
      { detail: "kind and file are required" },
      { status: 400 }
    )
  }

  let meta: Record<string, unknown> = {}
  if (typeof metaJson === "string" && metaJson) {
    try {
      meta = JSON.parse(metaJson) as Record<string, unknown>
    } catch {
      meta = { raw_meta: metaJson }
    }
  }

  const content = Buffer.from(await file.arrayBuffer())
  const asset = await saveAsset(sessionId, {
    kind,
    filename: file.name || `${kind}.bin`,
    content,
    meta,
  })

  if (!asset) {
    return Response.json({ detail: "asset save failed" }, { status: 500 })
  }
  return Response.json(asset)
}
