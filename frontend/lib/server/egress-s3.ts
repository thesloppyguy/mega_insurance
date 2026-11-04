import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import {
  EGRESS_S3_ACCESS_KEY,
  EGRESS_S3_BUCKET,
  EGRESS_S3_ENDPOINT,
  EGRESS_S3_FORCE_PATH_STYLE,
  EGRESS_S3_REGION,
  EGRESS_S3_SECRET,
} from "./config"

let cachedClient: S3Client | null = null

export function egressS3Configured() {
  return Boolean(
    EGRESS_S3_ACCESS_KEY && EGRESS_S3_SECRET && EGRESS_S3_BUCKET
  )
}

export function getEgressS3Client() {
  if (!egressS3Configured()) return null
  if (cachedClient) return cachedClient
  cachedClient = new S3Client({
    region: EGRESS_S3_REGION || "auto",
    endpoint: EGRESS_S3_ENDPOINT || undefined,
    forcePathStyle: EGRESS_S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: EGRESS_S3_ACCESS_KEY,
      secretAccessKey: EGRESS_S3_SECRET,
    },
  })
  return cachedClient
}

export function normalizeEgressKey(filepath: string) {
  return filepath.replace(/^\/+/, "").split("?")[0] || ""
}

export async function headEgressObject(filepath: string) {
  const client = getEgressS3Client()
  if (!client) return null
  const key = normalizeEgressKey(filepath)
  if (!key) return null
  try {
    const out = await client.send(
      new HeadObjectCommand({
        Bucket: EGRESS_S3_BUCKET,
        Key: key,
      })
    )
    return {
      key,
      exists: true as const,
      sizeBytes:
        typeof out.ContentLength === "number" ? out.ContentLength : null,
      contentType: out.ContentType || null,
      lastModified: out.LastModified?.toISOString() || null,
    }
  } catch {
    return { key, exists: false as const }
  }
}

export async function signEgressObjectUrl(
  filepath: string,
  opts?: { expiresIn?: number; downloadName?: string }
) {
  const client = getEgressS3Client()
  if (!client) return null
  const key = normalizeEgressKey(filepath)
  if (!key) return null
  const expiresIn = opts?.expiresIn ?? 60 * 60
  const command = new GetObjectCommand({
    Bucket: EGRESS_S3_BUCKET,
    Key: key,
    ...(opts?.downloadName
      ? {
          ResponseContentDisposition: `attachment; filename="${opts.downloadName.replace(/"/g, "")}"`,
        }
      : {}),
  })
  return getSignedUrl(client, command, { expiresIn })
}

export type EgressReportRow = {
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
  [key: string]: unknown
}

/** Attach signed preview/download URLs to session egress rows when objects exist. */
export async function enrichEgressForReport(
  rows: Array<Record<string, unknown>> | undefined
): Promise<EgressReportRow[]> {
  const list = Array.isArray(rows) ? rows : []
  if (!egressS3Configured()) {
    return list.map((row) => ({
      ...row,
      playableUrl: null,
      downloadUrl: null,
      available: false,
    }))
  }

  return Promise.all(
    list.map(async (row) => {
      const filepath =
        typeof row.filepath === "string" ? row.filepath.trim() : ""
      if (!filepath || String(row.status || "").toLowerCase() === "failed") {
        return {
          ...row,
          playableUrl: null,
          downloadUrl: null,
          available: false,
        }
      }

      const head = await headEgressObject(filepath)
      if (!head?.exists) {
        return {
          ...row,
          playableUrl: null,
          downloadUrl: null,
          available: false,
          sizeBytes: null,
        }
      }

      const filename =
        filepath.split("/").pop() ||
        `${String(row.role || "egress").replace(/\s+/g, "_")}.mp4`
      const [playableUrl, downloadUrl] = await Promise.all([
        signEgressObjectUrl(filepath, { expiresIn: 60 * 60 }),
        signEgressObjectUrl(filepath, {
          expiresIn: 60 * 60,
          downloadName: filename,
        }),
      ])

      return {
        ...row,
        playableUrl,
        downloadUrl,
        available: Boolean(playableUrl),
        sizeBytes: head.sizeBytes,
        contentType: head.contentType,
      }
    })
  )
}
