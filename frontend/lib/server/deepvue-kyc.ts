const DEFAULT_BASE_URL = "https://production.deepvue.tech"
const DEFAULT_ORIGIN = "mavrik-web"
/** Match Deepvue docs examples; override with DEEPVUE_AADHAAR_PURPOSE. */
const DEFAULT_PURPOSE = "lending"

const TRANSIENT_SUB_CODES = new Set([
  "SOURCE_FAILURE",
  "SOURCE_UNAVAILABLE",
  "TIMEOUT",
])

export type DeepvueKycConfig = {
  baseUrl: string
  clientId: string
  apiKey: string
  origin: string
  purpose: string
}

export function getDeepvueKycConfig(
  env: NodeJS.ProcessEnv = process.env
): DeepvueKycConfig | null {
  const clientId = env.DEEPVUE_ID?.trim()
  const apiKey = env.DEEPVUE_SECRET?.trim()
  if (!clientId || !apiKey) return null
  const baseUrl = (env.DEEPVUE_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/,
    ""
  )
  const origin = env.DEEPVUE_ORIGIN?.trim() || DEFAULT_ORIGIN
  const purpose = env.DEEPVUE_AADHAAR_PURPOSE?.trim() || DEFAULT_PURPOSE
  return { baseUrl, clientId, apiKey, origin, purpose }
}

type DeepvueJson = Record<string, unknown>

function deepvueHeaders(config: DeepvueKycConfig): HeadersInit {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Deepvue-Origin": config.origin,
    "x-api-key": config.apiKey,
    "client-id": config.clientId,
  }
}

async function deepvuePost(
  path: string,
  query: Record<string, string>,
  config: DeepvueKycConfig
): Promise<{ ok: boolean; status: number; data: DeepvueJson }> {
  const url = new URL(
    `${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`
  )
  for (const [key, value] of Object.entries(query)) {
    if (value !== "") url.searchParams.set(key, value)
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: deepvueHeaders(config),
  })

  const text = await response.text()
  let data: DeepvueJson = {}
  if (text) {
    try {
      data = JSON.parse(text) as DeepvueJson
    } catch {
      data = { raw: text }
    }
  }

  return { ok: response.ok, status: response.status, data }
}

function readReferenceId(data: DeepvueJson): string | null {
  const top = data.reference_id
  if (typeof top === "string" && top.trim()) return top.trim()
  if (typeof top === "number" && Number.isFinite(top)) {
    return String(Math.trunc(top))
  }
  const nested =
    data.data && typeof data.data === "object" && !Array.isArray(data.data)
      ? (data.data as DeepvueJson)
      : null
  const fromNested = nested?.reference_id
  if (typeof fromNested === "string" && fromNested.trim()) {
    return fromNested.trim()
  }
  if (typeof fromNested === "number" && Number.isFinite(fromNested)) {
    return String(Math.trunc(fromNested))
  }
  return null
}

function readCode(data: DeepvueJson): number | null {
  if (typeof data.code === "number" && Number.isFinite(data.code)) {
    return data.code
  }
  return null
}

function readSubCode(data: DeepvueJson): string {
  return typeof data.sub_code === "string" ? data.sub_code.toUpperCase() : ""
}

function readMessage(data: DeepvueJson): string | undefined {
  if (typeof data.message === "string" && data.message.trim()) {
    return data.message.trim()
  }
  if (typeof data.detail === "string" && data.detail.trim()) {
    return data.detail.trim()
  }
  return undefined
}

function readTransactionId(data: DeepvueJson): string | undefined {
  return typeof data.transaction_id === "string"
    ? data.transaction_id
    : undefined
}

function isTransientFailure(status: number, data: DeepvueJson): boolean {
  if (status === 503 || status === 502 || status === 500) return true
  const sub = readSubCode(data)
  if (TRANSIENT_SUB_CODES.has(sub)) return true
  const message = (readMessage(data) ?? "").toLowerCase()
  return (
    message.includes("temporarily unavailable") ||
    message.includes("source unavailable") ||
    message.includes("try again shortly")
  )
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function deepvuePostWithRetry(
  path: string,
  query: Record<string, string>,
  config: DeepvueKycConfig,
  opts?: { attempts?: number; label?: string }
): Promise<{ ok: boolean; status: number; data: DeepvueJson }> {
  const attempts = opts?.attempts ?? 3
  let last: { ok: boolean; status: number; data: DeepvueJson } | null = null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await deepvuePost(path, query, config)
    last = result

    if (result.ok && readCode(result.data) === 200) return result

    const transient = isTransientFailure(result.status, result.data)
    if (!transient || attempt === attempts) return result

    const delayMs = 800 * 2 ** (attempt - 1)
    console.warn("[deepvue] transient failure; retrying", {
      label: opts?.label,
      attempt,
      attempts,
      delayMs,
      status: result.status,
      code: readCode(result.data),
      subCode: readSubCode(result.data),
      transactionId: readTransactionId(result.data),
      message: readMessage(result.data),
    })
    await sleep(delayMs)
  }

  return last ?? { ok: false, status: 500, data: {} }
}

function normalizeIndianMobile(
  phone: string | null | undefined
): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, "")
  if (digits.length === 10) return digits
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2)
  if (digits.length > 10) return digits.slice(-10)
  return null
}

function formatDeepvueError(
  data: DeepvueJson,
  status: number,
  fallback: string
): string {
  const message = readMessage(data)
  const sub = readSubCode(data)
  const tx = readTransactionId(data)

  if (sub === "SOURCE_FAILURE" || isTransientFailure(status, data)) {
    const base =
      "UIDAI/Deepvue source is temporarily unavailable. Please try again in a minute."
    return tx ? `${base} (tx: ${tx})` : base
  }
  if (sub === "VERIFICATION_PENDING") {
    return (
      message ??
      "An OTP was already sent for this Aadhaar. Please wait and try again."
    )
  }
  if (message) return message.slice(0, 300)
  return `${fallback} (${status}${sub ? `, ${sub}` : ""})`
}

export async function requestAadhaarOkycOtp(args: {
  aadhaarNumber: string
  purpose?: string
  config?: DeepvueKycConfig
}): Promise<{ referenceId: string }> {
  const config = args.config ?? getDeepvueKycConfig()
  if (!config) {
    throw new Error("DEEPVUE_ID and DEEPVUE_SECRET must be set")
  }

  const { ok, status, data } = await deepvuePostWithRetry(
    "/v2/ekyc/aadhaar/generate-otp",
    {
      aadhaar_number: args.aadhaarNumber,
      consent: "Y",
      purpose: args.purpose ?? config.purpose,
    },
    config,
    { label: "generate-otp", attempts: 3 }
  )

  const referenceId = readReferenceId(data)
  const code = readCode(data)
  if (!ok || code !== 200 || !referenceId) {
    console.error("[deepvue] Aadhaar OTP request failed", {
      status,
      code,
      subCode: data.sub_code,
      transactionId: readTransactionId(data),
      message: readMessage(data),
    })
    throw new Error(
      formatDeepvueError(data, status, "Aadhaar OTP request failed")
    )
  }

  return { referenceId }
}

export async function verifyAadhaarOkycOtp(args: {
  referenceId: string
  otp: string
  mobileNumber?: string | null
  purpose?: string
  generatePdf?: boolean
  config?: DeepvueKycConfig
}): Promise<{
  verified: boolean
  code: number | null
  data?: DeepvueJson
}> {
  const config = args.config ?? getDeepvueKycConfig()
  if (!config) {
    throw new Error("DEEPVUE_ID and DEEPVUE_SECRET must be set")
  }

  const query: Record<string, string> = {
    otp: args.otp,
    reference_id: args.referenceId,
    consent: "Y",
    purpose: args.purpose ?? config.purpose,
    generate_pdf: args.generatePdf ? "true" : "false",
  }
  const mobile = normalizeIndianMobile(args.mobileNumber)
  if (mobile) query.mobile_number = mobile

  const { ok, status, data } = await deepvuePostWithRetry(
    "/v2/ekyc/aadhaar/verify-otp",
    query,
    config,
    { label: "verify-otp", attempts: 2 }
  )

  const code = readCode(data)
  const subCode = readSubCode(data)
  const verified = ok && code === 200 && subCode === "SUCCESS"

  if (!verified) {
    console.warn("[deepvue] Aadhaar OTP verify unsuccessful", {
      status,
      code,
      subCode: data.sub_code,
      transactionId: readTransactionId(data),
      message: readMessage(data),
    })
    if (isTransientFailure(status, data)) {
      throw new Error(
        formatDeepvueError(data, status, "Aadhaar OTP verify failed")
      )
    }
  }

  const payload =
    data.data && typeof data.data === "object" && !Array.isArray(data.data)
      ? (data.data as DeepvueJson)
      : undefined

  return { verified, code, data: payload }
}
