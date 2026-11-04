import { createReadStream, existsSync, statSync } from "fs"
import path from "path"
import { Readable } from "stream"

import { ASSETS_DIR } from "@/lib/server/config"
import { getSession } from "@/lib/server/store"

type Params = { params: Promise<{ sessionId: string; assetId: string }> }

function contentTypeFor(filename: string) {
  const ext = path.extname(filename).toLowerCase()
  if (ext === ".mp4") return "video/mp4"
  if (ext === ".webm") return "video/webm"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".png") return "image/png"
  if (ext === ".json") return "application/json"
  return "application/octet-stream"
}

/** Stream a saved session asset for report / capture previews. */
export async function GET(_req: Request, { params }: Params) {
  const { sessionId, assetId } = await params
  const session = await getSession(sessionId)
  if (!session) {
    return Response.json({ detail: "session not found" }, { status: 404 })
  }

  const asset = (session.assets || []).find(
    (row) => String(row.asset_id || "") === assetId
  )
  if (!asset) {
    return Response.json({ detail: "asset not found" }, { status: 404 })
  }

  const storedPath = typeof asset.path === "string" ? asset.path : ""
  const filename =
    typeof asset.filename === "string" && asset.filename
      ? asset.filename
      : `${assetId}.bin`

  // Prefer the recorded path; fall back to assets/<session>/<assetId>.*
  let filePath = storedPath
  if (!filePath || !existsSync(filePath)) {
    const dir = path.join(ASSETS_DIR, sessionId)
    const ext = path.extname(filename) || path.extname(storedPath) || ""
    const candidate = path.join(dir, `${assetId}${ext}`)
    if (existsSync(candidate)) {
      filePath = candidate
    }
  }
  if (!filePath || !existsSync(filePath)) {
    return Response.json({ detail: "asset file missing" }, { status: 404 })
  }

  const stat = statSync(filePath)
  const stream = createReadStream(filePath)
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream

  return new Response(webStream, {
    headers: {
      "Content-Type": contentTypeFor(filename),
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=60",
      "Content-Disposition": `inline; filename="${filename.replace(/"/g, "")}"`,
    },
  })
}
