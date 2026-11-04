const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "/api"

export type CreateSessionResponse = {
  session_id: string
  room_name: string
  join_path: string
  report_path: string
}

export type TokenResponse = {
  serverUrl: string
  participantToken: string
  participantName: string
  roomName: string
  sessionId: string
}

export type EgressFile = {
  role?: string
  egress_id?: string | null
  filepath?: string
  status?: string
  error?: string
  detail?: string
  playableUrl?: string | null
  downloadUrl?: string | null
  available?: boolean
  sizeBytes?: number | null
  contentType?: string | null
}

export type SessionReport = {
  session_id: string
  status?: string
  participant_name?: string
  end_reason?: string | null
  created_at?: string
  updated_at?: string
  id_card_ocr?: {
    idType?: string
    extracted?: Record<string, string>
    confidence?: number
    summary?: string
  } | null
  livekit_report?: Record<string, unknown> | null
  underwriting_report?: UnderwritingReport | null
  assets?: Array<Record<string, unknown>>
  events?: Array<Record<string, unknown>>
  egress?: EgressFile[]
}

export type SamValidation = {
  status?: string
  person_coverage?: number
  face_coverage?: number
  id_card_frames?: number
  multiple_persons?: boolean
  flags?: string[]
  presence_ok?: boolean
  liveness_proxy_ok?: boolean
}

export type UnderwritingReport = {
  session_id: string
  disclosure?: string
  engine?: { wonder?: string; sam?: string; sam_source?: string }
  identity_liveness?: Section & {
    sam_person_coverage?: number
    sam_face_coverage?: number
  }
  face_matching?: Section & { match_score?: number | null; matched?: boolean | null }
  kyc?: Section & {
    document_type?: string | null
    extracted_fields?: Record<string, unknown>
    face_match_score?: number | null
    sam_id_card_frames?: number
  }
  body_scan?: Section & {
    view?: string
    physical_conditions?: string[]
    estimates?: Record<string, unknown>
  }
  proctoring?: Section & {
    summary?: string
    timeline?: Array<Record<string, unknown>>
    sam_validation?: SamValidation | null
  }
  audio?: Section & { transcript_excerpt?: string | null }
  underwriting_outcome?: {
    recommendation?: string
    risk_indicators?: string[]
    exception_flags?: string[]
    notes?: string
    disclosure?: string
  }
  sam_summary?: {
    skipped?: boolean
    reason?: string
    source?: string
    engine?: string
    overlay_asset_id?: string
    clip_asset_id?: string
    overlay_video?: string
    video?: string
    validation?: SamValidation
    concepts?: Array<Record<string, unknown>>
    [key: string]: unknown
  }
}

type Section = {
  status?: string
  scores?: Record<string, number>
  findings?: Array<{ code: string; severity: string; message: string }>
  estimates?: Record<string, unknown>
  disclosure?: string
  evidence_asset_ids?: string[]
}

export async function createSession(callerName: string) {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      caller_name: callerName,
      participant_name: callerName,
      use_avatar: true,
      recording_enabled: true,
      background_audio_enabled: false,
    }),
  })
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()) as CreateSessionResponse
}

export async function fetchToken(sessionId: string, callerName?: string) {
  const res = await fetch(`${API_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      caller_name: callerName,
      participant_name: callerName,
    }),
  })
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()) as TokenResponse
}

export async function fetchReport(sessionId: string) {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/report`, {
    cache: "no-store",
  })
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()) as SessionReport
}

export async function uploadAsset(
  sessionId: string,
  kind: string,
  blob: Blob,
  filename: string,
  meta?: Record<string, unknown>
) {
  const form = new FormData()
  form.append("kind", kind)
  form.append("file", blob, filename)
  if (meta) form.append("meta_json", JSON.stringify(meta))
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/assets`, {
    method: "POST",
    body: form,
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export type IdCardOcrResult = {
  idType: string
  extracted: Record<string, string>
  confidence: number
  summary: string
  model: string
}

/** OCR the latest uploaded ID asset via Muse Spark. Returns null on soft failure. */
export async function ocrIdCard(
  sessionId: string
): Promise<IdCardOcrResult | null> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/id-card-ocr`, {
    method: "POST",
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    console.error("ID capture: OCR failed", res.status, detail)
    return null
  }
  const body = (await res.json()) as { ocr?: IdCardOcrResult }
  return body.ocr ?? null
}

async function readApiError(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => "")
  if (!text.trim()) return fallback
  try {
    const data = JSON.parse(text) as { detail?: unknown }
    if (typeof data.detail === "string" && data.detail.trim()) {
      return data.detail.trim()
    }
  } catch {
    /* plain text body */
  }
  return text.trim()
}

export async function requestAadhaarOtp(
  sessionId: string,
  aadhaarNumber: string
) {
  const res = await fetch(
    `${API_BASE}/sessions/${sessionId}/aadhaar/okyc/otp`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aadhaar_number: aadhaarNumber }),
    }
  )
  if (!res.ok) {
    throw new Error(await readApiError(res, "Could not request Aadhaar OTP"))
  }
  return (await res.json()) as { requested: true }
}

export async function verifyAadhaarOtp(sessionId: string, otp: string) {
  const res = await fetch(
    `${API_BASE}/sessions/${sessionId}/aadhaar/okyc/otp/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ otp }),
    }
  )
  if (!res.ok) {
    throw new Error(await readApiError(res, "Could not verify Aadhaar OTP"))
  }
  return (await res.json()) as { verified: boolean; code?: number }
}

export { API_BASE }
