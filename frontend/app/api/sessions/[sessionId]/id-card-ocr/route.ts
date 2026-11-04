import {
  hasMuseApiKey,
  ocrSessionIdCard,
} from "@/lib/server/id-card-ocr"
import { getSession } from "@/lib/server/store"

type Params = { params: Promise<{ sessionId: string }> }

export async function POST(_req: Request, { params }: Params) {
  const { sessionId } = await params
  const session = await getSession(sessionId)
  if (!session) {
    return Response.json({ detail: "session not found" }, { status: 404 })
  }

  if (!hasMuseApiKey()) {
    return Response.json(
      { detail: "ID card OCR is not configured" },
      { status: 503 }
    )
  }

  if (session.status === "completed" || session.status === "failed") {
    return Response.json(
      { detail: `Session is no longer accepting OCR (status: ${session.status})` },
      { status: 409 }
    )
  }

  try {
    const ocr = await ocrSessionIdCard(sessionId)
    return Response.json({ ocr })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "ID card OCR failed"
    if (message.includes("No ID card image")) {
      return Response.json({ detail: message }, { status: 404 })
    }
    console.error("id-card-ocr failed", { sessionId, message })
    return Response.json({ detail: message }, { status: 502 })
  }
}
