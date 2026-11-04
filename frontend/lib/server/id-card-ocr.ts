import { readFileSync } from "fs"
import path from "path"

import {
  META_API_BASE,
  MODEL_API_KEY,
  MUSE_OCR_MODEL,
} from "@/lib/server/config"
import { getSession, updateSession } from "@/lib/server/store"

export const ID_CARD_OCR_MODEL = MUSE_OCR_MODEL

export const ID_CARD_OCR_PROMPT = `You are reading a government or photo identity document from a camera capture.
Return JSON only with this shape:
{"idType":string,"extracted":{"fullName":string,"documentNumber":string,"dateOfBirth":string,"expiryDate":string,"issueDate":string,"nationality":string,"address":string,"sex":string,"fatherName":string,"additionalFields":object},"confidence":number,"summary":string}

Rules:
- idType: short document type label, e.g. "Aadhaar", "PAN", "Passport", "Driver License", "Voter ID", "National ID", "Residence Permit", "Other". Prefer the specific type over "ID Card".
- extracted: fill what you can read; use empty string for unread fields
- extracted.additionalFields: optional map of other labeled fields you can read (string values only)
- confidence: 0..1 overall OCR quality
- summary: one short sentence naming the document type and readability
- Do not invent values you cannot see`

export type IdCardOcrResult = {
  idType: string
  extracted: Record<string, string>
  confidence: number
  summary: string
  model: string
}

type SessionAsset = {
  asset_id?: string
  kind?: string
  filename?: string
  path?: string
  created_at?: string
}

export function hasMuseApiKey(): boolean {
  return Boolean(MODEL_API_KEY)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value)
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (key === "additionalFields") {
      const nested = asRecord(item)
      for (const [nestedKey, nestedValue] of Object.entries(nested)) {
        if (typeof nestedValue === "string") {
          out[nestedKey] = nestedValue
        } else if (nestedValue != null) {
          out[nestedKey] = String(nestedValue)
        }
      }
      continue
    }
    if (typeof item === "string") {
      out[key] = item
    } else if (item == null) {
      out[key] = ""
    } else if (typeof item === "number" || typeof item === "boolean") {
      out[key] = String(item)
    }
  }
  return out
}

export function parseIdCardOcr(raw: unknown, model: string): IdCardOcrResult {
  const data = asRecord(raw)
  const extracted = asStringRecord(data.extracted)
  const idType =
    asString(data.idType).trim() ||
    asString(extracted.documentType).trim() ||
    asString(extracted.idType).trim() ||
    "Unknown"

  return {
    idType,
    extracted,
    confidence: Math.min(1, Math.max(0, asNumber(data.confidence) ?? 0)),
    summary: asString(data.summary, "No summary provided."),
    model,
  }
}

function pickIdCardAsset(assets: SessionAsset[]): SessionAsset | null {
  const idAssets = assets.filter((a) => {
    const kind = String(a.kind || "").toLowerCase()
    const name = String(a.filename || "").toLowerCase()
    return kind === "id" || name.startsWith("id.") || name.startsWith("id-card")
  })
  if (idAssets.length === 0) return null
  // Prefer newest (assets are appended chronologically).
  return idAssets[idAssets.length - 1] ?? null
}

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".png") return "image/png"
  if (ext === ".webp") return "image/webp"
  if (ext === ".gif") return "image/gif"
  return "image/jpeg"
}

function extractResponseText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text
  }

  const output = data.output
  if (Array.isArray(output)) {
    const parts: string[] = []
    for (const item of output) {
      const rec = asRecord(item)
      const content = rec.content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        const p = asRecord(part)
        if (typeof p.text === "string") parts.push(p.text)
        else if (typeof p.output_text === "string") parts.push(p.output_text)
      }
    }
    if (parts.length) return parts.join("\n")
  }

  const choices = data.choices
  if (Array.isArray(choices) && choices[0]) {
    const message = asRecord(asRecord(choices[0]).message)
    const content = message.content
    if (typeof content === "string") return content
  }

  return ""
}

function parseJsonFromText(text: string): unknown {
  const cleaned = text.trim()
  if (!cleaned) return null
  try {
    if (cleaned.startsWith("```")) {
      let body = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "")
      body = body.trim()
      return JSON.parse(body)
    }
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf("{")
    const end = cleaned.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

async function callMuseOcr(args: {
  imageBytes: Buffer
  mimeType: string
}): Promise<unknown> {
  const apiKey = MODEL_API_KEY
  if (!apiKey) {
    throw new Error("MODEL_API_KEY / META_API_KEY is not configured")
  }

  const dataUrl = `data:${args.mimeType};base64,${args.imageBytes.toString("base64")}`
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  }

  const responsesBody = {
    model: ID_CARD_OCR_MODEL,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: ID_CARD_OCR_PROMPT },
          { type: "input_image", image_url: dataUrl },
        ],
      },
    ],
    // Fast mid-session OCR — keep reasoning light.
    reasoning: { effort: "low" },
  }

  let response = await fetch(`${META_API_BASE}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(responsesBody),
  })

  if (!response.ok) {
    const chatBody = {
      model: ID_CARD_OCR_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: ID_CARD_OCR_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      reasoning_effort: "low",
    }
    response = await fetch(`${META_API_BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(chatBody),
    })
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(
      `Muse OCR failed (${response.status}): ${detail.slice(0, 300)}`
    )
  }

  const data = (await response.json()) as Record<string, unknown>
  const text = extractResponseText(data)
  const parsed = parseJsonFromText(text)
  if (parsed == null) {
    throw new Error("Muse OCR returned non-JSON output")
  }
  return parsed
}

/**
 * OCR the latest ID card capture for a live session using Muse Spark.
 */
export async function ocrSessionIdCard(
  sessionId: string
): Promise<IdCardOcrResult> {
  if (!hasMuseApiKey()) {
    throw new Error("MODEL_API_KEY / META_API_KEY is not configured")
  }

  const session = await getSession(sessionId)
  if (!session) {
    throw new Error("Session not found")
  }

  const assets = (session.assets || []) as SessionAsset[]
  const idAsset = pickIdCardAsset(assets)
  if (!idAsset?.path) {
    throw new Error("No ID card image found for this session")
  }

  const imageBytes = readFileSync(idAsset.path)
  const mimeType = mimeFromPath(idAsset.path)
  const raw = await callMuseOcr({ imageBytes, mimeType })
  const result = parseIdCardOcr(raw, ID_CARD_OCR_MODEL)

  try {
    const config =
      session.config &&
      typeof session.config === "object" &&
      !Array.isArray(session.config)
        ? { ...session.config }
        : {}
    await updateSession(sessionId, {
      config: {
        ...config,
        idCardOcr: {
          ...result,
          assetId: idAsset.asset_id,
          filename: idAsset.filename,
          capturedAt: new Date().toISOString(),
        },
      },
    })
  } catch (error) {
    console.warn("Failed to persist mid-session ID OCR result", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return result
}
