import {
  getDeepvueKycConfig,
  requestAadhaarOkycOtp,
} from "@/lib/server/deepvue-kyc"
import { getSession, updateSession, type AadhaarOkycState } from "@/lib/server/store"

type Params = { params: Promise<{ sessionId: string }> }

export async function POST(req: Request, { params }: Params) {
  const { sessionId } = await params

  if (!getDeepvueKycConfig()) {
    return Response.json(
      { detail: "Aadhaar eKYC is not configured" },
      { status: 503 }
    )
  }

  const session = await getSession(sessionId)
  if (!session) {
    return Response.json({ detail: "session not found" }, { status: 404 })
  }

  let body: { aadhaar_number?: unknown }
  try {
    body = (await req.json()) as { aadhaar_number?: unknown }
  } catch {
    return Response.json({ detail: "invalid JSON body" }, { status: 400 })
  }

  const aadhaarNumber =
    typeof body.aadhaar_number === "string"
      ? body.aadhaar_number.replace(/\s+/g, "").trim()
      : ""
  if (!/^\d{12}$/.test(aadhaarNumber)) {
    return Response.json(
      { detail: "Aadhaar number must be 12 digits" },
      { status: 400 }
    )
  }

  try {
    const { referenceId } = await requestAadhaarOkycOtp({
      aadhaarNumber,
    })

    const aadhaar_okyc: AadhaarOkycState = {
      referenceId,
      aadhaarLast4: aadhaarNumber.slice(-4),
      requestedAt: Date.now(),
    }
    await updateSession(sessionId, { aadhaar_okyc })

    return Response.json({ requested: true as const })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "OTP request failed"
    return Response.json({ detail: message.slice(0, 300) }, { status: 400 })
  }
}
