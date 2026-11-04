import { DEFAULT_CAMPAIGN_ID, DEFAULT_ORG_ID } from "@/lib/server/config"
import { createSession } from "@/lib/server/store"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    participant_name?: string
    caller_name?: string
    organization_id?: string
    campaign_id?: string
    use_avatar?: boolean
    recording_enabled?: boolean
    background_audio_enabled?: boolean
  }

  const callerName =
    (body.caller_name || body.participant_name || "Candidate").trim() ||
    "Candidate"

  const session = await createSession({
    organization_id: body.organization_id || DEFAULT_ORG_ID,
    campaign_id: body.campaign_id || DEFAULT_CAMPAIGN_ID,
    participant_name: callerName,
    config: {
      caller_name: callerName,
      use_avatar: body.use_avatar ?? true,
      recording_enabled: body.recording_enabled ?? true,
      background_audio_enabled: body.background_audio_enabled ?? false,
    },
  })

  return Response.json({
    session_id: session.session_id,
    room_name: session.room_name,
    join_path: `/interview/${session.session_id}`,
    report_path: `/report/${session.session_id}`,
  })
}
