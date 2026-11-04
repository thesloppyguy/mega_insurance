import {
  getDeepvueKycConfig,
  verifyAadhaarOkycOtp,
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

  let body: { otp?: unknown; mobile_number?: unknown }
  try {
    body = (await req.json()) as {
      otp?: unknown
      mobile_number?: unknown
    }
  } catch {
    return Response.json({ detail: "invalid JSON body" }, { status: 400 })
  }

  const otp =
    typeof body.otp === "string" ? body.otp.replace(/\s+/g, "").trim() : ""
  if (!/^\d{4,12}$/.test(otp)) {
    return Response.json(
      { detail: "OTP must be 4–12 digits" },
      { status: 400 }
    )
  }

  const mobileNumber =
    typeof body.mobile_number === "string"
      ? body.mobile_number.replace(/\D/g, "").trim()
      : undefined

  const existing = session.aadhaar_okyc
  if (!existing?.referenceId) {
    return Response.json(
      { detail: "No Aadhaar OTP request found for this session" },
      { status: 400 }
    )
  }

  try {
    const result = await verifyAadhaarOkycOtp({
      referenceId: existing.referenceId,
      otp,
      mobileNumber: mobileNumber && /^\d{10}$/.test(mobileNumber)
        ? mobileNumber
        : null,
    })

    if (result.verified) {
      const ekyc = result.data
        ? {
            name:
              typeof result.data.name === "string"
                ? result.data.name
                : undefined,
            dateOfBirth:
              typeof result.data.dateOfBirth === "string"
                ? result.data.dateOfBirth
                : undefined,
            gender:
              typeof result.data.gender === "string"
                ? result.data.gender
                : undefined,
            maskedNumber:
              typeof result.data.maskedNumber === "string"
                ? result.data.maskedNumber
                : undefined,
          }
        : undefined

      const aadhaar_okyc: AadhaarOkycState = {
        ...existing,
        verifiedAt: Date.now(),
        ...(ekyc ? { ekyc } : {}),
      }
      await updateSession(sessionId, { aadhaar_okyc })
    }

    return Response.json({
      verified: result.verified,
      code: result.code ?? undefined,
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "OTP verify failed"
    return Response.json({ detail: message.slice(0, 300) }, { status: 400 })
  }
}
