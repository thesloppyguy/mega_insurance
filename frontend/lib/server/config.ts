import { mkdirSync } from "fs"
import path from "path"

export const DATA_DIR = path.resolve(
  process.env.MAVRIK_DATA_DIR || path.join(process.cwd(), "..", "data")
)
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions")
export const ASSETS_DIR = path.join(DATA_DIR, "assets")
export const EGRESS_DIR = path.join(DATA_DIR, "egress")

export const LIVEKIT_URL = process.env.LIVEKIT_URL || ""
export const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || ""
export const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || ""

export const EGRESS_S3_ACCESS_KEY = process.env.EGRESS_S3_ACCESS_KEY || ""
export const EGRESS_S3_SECRET = process.env.EGRESS_S3_SECRET || ""
export const EGRESS_S3_BUCKET = process.env.EGRESS_S3_BUCKET || ""
export const EGRESS_S3_REGION = process.env.EGRESS_S3_REGION || ""
export const EGRESS_S3_ENDPOINT = process.env.EGRESS_S3_ENDPOINT || ""

/**
 * Neon Object Storage certs are issued for `*.storage.…neon.tech`.
 * Virtual-hosted URLs become `{bucket}.{endpoint-host}` (extra DNS label) and
 * fail TLS verification — always use path-style for Neon endpoints.
 */
function resolveEgressForcePathStyle(
  endpoint: string,
  raw: string | undefined
): boolean {
  const host = endpoint
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    ?.toLowerCase()
  if (host && /\.storage\..+\.neon\.tech$/i.test(host)) {
    return true
  }
  return ["1", "true", "yes"].includes((raw || "").toLowerCase())
}

export const EGRESS_S3_FORCE_PATH_STYLE = resolveEgressForcePathStyle(
  EGRESS_S3_ENDPOINT,
  process.env.EGRESS_S3_FORCE_PATH_STYLE
)

export const WORKER_API_KEY = process.env.WORKER_API_KEY || "dev-worker-key"
export const API_PUBLIC_BASE_URL =
  process.env.API_PUBLIC_BASE_URL || "http://127.0.0.1:3000/api"

export const META_API_BASE = (
  process.env.META_API_BASE || "https://api.meta.ai/v1"
).replace(/\/$/, "")
export const MODEL_API_KEY = (
  process.env.MODEL_API_KEY ||
  process.env.META_API_KEY ||
  ""
).trim()
export const MUSE_OCR_MODEL =
  process.env.MUSE_OCR_MODEL?.trim() ||
  process.env.MUSE_SPARK_MODEL?.trim() ||
  "muse-spark-1.3"

export const ANAM_AVATAR_ID = process.env.ANAM_AVATAR_ID || ""
export const ANAM_AVATAR_NAME =
  process.env.ANAM_AVATAR_NAME || "Mega Insurance Interviewer"

export const DEFAULT_ORG_ID = process.env.DEFAULT_ORG_ID || "org_local"
export const DEFAULT_CAMPAIGN_ID =
  process.env.DEFAULT_CAMPAIGN_ID || "campaign_local"

export function ensureDirs() {
  for (const dir of [DATA_DIR, SESSIONS_DIR, ASSETS_DIR, EGRESS_DIR]) {
    mkdirSync(dir, { recursive: true })
  }
}
