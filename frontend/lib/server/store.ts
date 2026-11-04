import { randomBytes } from "crypto"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs"
import path from "path"

import { ASSETS_DIR, SESSIONS_DIR, ensureDirs } from "./config"

export type AadhaarOkycState = {
  referenceId: string
  aadhaarLast4: string
  requestedAt: number
  verifiedAt?: number
  ekyc?: {
    name?: string
    dateOfBirth?: string
    gender?: string
    maskedNumber?: string
  }
}

export type SessionRecord = {
  session_id: string
  organization_id: string
  campaign_id: string | null
  participant_name: string
  room_name: string
  status: string
  livekit_job_id: string | null
  end_reason: string | null
  config: Record<string, unknown>
  /** Deepvue Aadhaar OKYC state (reference_id for OTP verify). */
  aadhaar_okyc?: AadhaarOkycState | null
  assets: Array<Record<string, unknown>>
  events: Array<Record<string, unknown>>
  egress: Array<Record<string, unknown>>
  livekit_report: Record<string, unknown> | null
  underwriting_report: Record<string, unknown> | null
  usage: unknown
  metrics: Array<Record<string, unknown>>
  created_at: string
  updated_at: string
}

let chain: Promise<unknown> = Promise.resolve()

function withLock<T>(fn: () => T): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function now() {
  return new Date().toISOString()
}

function sessionPath(sessionId: string) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`)
}

function shortId(bytes = 8) {
  return randomBytes(bytes).toString("hex")
}

export async function createSession(input: {
  organization_id: string
  campaign_id: string | null
  participant_name: string
  config: Record<string, unknown>
}): Promise<SessionRecord> {
  return withLock(() => {
    ensureDirs()
    const session_id = `sess_${shortId(8)}`
    const room_name = `mavrik-${session_id}`
    const record: SessionRecord = {
      session_id,
      organization_id: input.organization_id,
      campaign_id: input.campaign_id,
      participant_name: input.participant_name,
      room_name,
      status: "created",
      livekit_job_id: null,
      end_reason: null,
      config: input.config,
      assets: [],
      events: [],
      egress: [],
      livekit_report: null,
      underwriting_report: null,
      usage: null,
      metrics: [],
      created_at: now(),
      updated_at: now(),
    }
    writeFileSync(sessionPath(session_id), JSON.stringify(record, null, 2), "utf-8")
    return record
  })
}

export async function getSession(
  sessionId: string
): Promise<SessionRecord | null> {
  return withLock(() => {
    const file = sessionPath(sessionId)
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, "utf-8")) as SessionRecord
  })
}

export async function updateSession(
  sessionId: string,
  patch: Record<string, unknown>
): Promise<SessionRecord | null> {
  return withLock(() => {
    const file = sessionPath(sessionId)
    if (!existsSync(file)) return null
    const record = JSON.parse(readFileSync(file, "utf-8")) as SessionRecord
    Object.assign(record, patch, { updated_at: now() })
    writeFileSync(file, JSON.stringify(record, null, 2), "utf-8")
    return record
  })
}

export async function appendEvent(
  sessionId: string,
  event: Record<string, unknown>
): Promise<SessionRecord | null> {
  return withLock(() => {
    const file = sessionPath(sessionId)
    if (!existsSync(file)) return null
    const record = JSON.parse(readFileSync(file, "utf-8")) as SessionRecord
    record.events = record.events || []
    record.events.push({ ...event, at: now() })
    record.updated_at = now()
    writeFileSync(file, JSON.stringify(record, null, 2), "utf-8")
    return record
  })
}

export async function saveAsset(
  sessionId: string,
  input: {
    kind: string
    filename: string
    content: Buffer
    meta?: Record<string, unknown>
  }
): Promise<Record<string, unknown> | null> {
  return withLock(() => {
    ensureDirs()
    const file = sessionPath(sessionId)
    if (!existsSync(file)) return null

    const asset_id = `asset_${shortId(6)}`
    const ext = path.extname(input.filename) || ".bin"
    const destDir = path.join(ASSETS_DIR, sessionId)
    mkdirSync(destDir, { recursive: true })
    const dest = path.join(destDir, `${asset_id}${ext}`)
    writeFileSync(dest, input.content)

    const asset = {
      asset_id,
      kind: input.kind,
      filename: input.filename,
      path: dest,
      meta: input.meta || {},
      created_at: now(),
    }

    const record = JSON.parse(readFileSync(file, "utf-8")) as SessionRecord
    record.assets = record.assets || []
    record.assets.push(asset)
    record.updated_at = now()
    writeFileSync(file, JSON.stringify(record, null, 2), "utf-8")
    return asset
  })
}
