const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ||
  "http://127.0.0.1:8000"

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

export type SessionReport = {
  session_id: string
  status?: string
  livekit_report?: Record<string, unknown> | null
  underwriting_report?: UnderwritingReport | null
  assets?: Array<Record<string, unknown>>
  events?: Array<Record<string, unknown>>
  egress?: Array<Record<string, unknown>>
}

export type UnderwritingReport = {
  session_id: string
  disclosure?: string
  identity_liveness?: Section
  face_matching?: Section & { match_score?: number | null; matched?: boolean | null }
  kyc?: Section & {
    document_type?: string | null
    extracted_fields?: Record<string, unknown>
    face_match_score?: number | null
  }
  body_scan?: Section & {
    view?: string
    physical_conditions?: string[]
    estimates?: Record<string, unknown>
  }
  proctoring?: Section & { summary?: string; timeline?: Array<Record<string, unknown>> }
  audio?: Section & { transcript_excerpt?: string | null }
  underwriting_outcome?: {
    recommendation?: string
    risk_indicators?: string[]
    exception_flags?: string[]
    notes?: string
    disclosure?: string
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

export async function createSession(participantName: string) {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      participant_name: participantName,
      use_avatar: true,
      recording_enabled: true,
      background_audio_enabled: true,
    }),
  })
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()) as CreateSessionResponse
}

export async function fetchToken(sessionId: string, participantName?: string) {
  const res = await fetch(`${API_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      participant_name: participantName,
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

export { API_BASE }
