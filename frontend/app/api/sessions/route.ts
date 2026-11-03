import { DEFAULT_CAMPAIGN_ID, DEFAULT_ORG_ID } from "@/lib/server/config"
import { createSession } from "@/lib/server/store"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    participant_name?: string
    organization_id?: string
    campaign_id?: string
    use_avatar?: boolean
    recording_enabled?: boolean
    background_audio_enabled?: boolean
    anam_avatar_id?: string | null
    anam_avatar_name?: string | null
  }

  const session = await createSession({
    organization_id: body.organization_id || DEFAULT_ORG_ID,
    campaign_id: body.campaign_id || DEFAULT_CAMPAIGN_ID,
    participant_name: body.participant_name || "Candidate",
    config: {
      use_avatar: body.use_avatar ?? false,
      recording_enabled: body.recording_enabled ?? true,
      background_audio_enabled: body.background_audio_enabled ?? false,
      anam_avatar_id: body.anam_avatar_id ?? null,
      anam_avatar_name: body.anam_avatar_name ?? null,
    },
  })

  return Response.json({
    session_id: session.session_id,
    room_name: session.room_name,
    join_path: `/interview/${session.session_id}`,
    report_path: `/report/${session.session_id}`,
  })
}
