import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomAgentDispatch,
  RoomConfiguration,
  S3Upload,
} from "livekit-server-sdk"

import {
  EGRESS_S3_ACCESS_KEY,
  EGRESS_S3_BUCKET,
  EGRESS_S3_ENDPOINT,
  EGRESS_S3_FORCE_PATH_STYLE,
  EGRESS_S3_REGION,
  EGRESS_S3_SECRET,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  LIVEKIT_URL,
  ensureDirs,
} from "./config"

function httpHost(url: string) {
  return url.replace(/^wss:/, "https:").replace(/^ws:/, "http:")
}

function requireLiveKitCreds() {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    throw new Error(
      "LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are required"
    )
  }
}

function s3Configured() {
  return Boolean(
    EGRESS_S3_ACCESS_KEY && EGRESS_S3_SECRET && EGRESS_S3_BUCKET
  )
}

function encodedFileOutput(filepath: string) {
  if (!s3Configured()) {
    throw new Error(
      "LiveKit Cloud egress needs object storage. Set EGRESS_S3_ACCESS_KEY, " +
        "EGRESS_S3_SECRET, EGRESS_S3_BUCKET, and EGRESS_S3_REGION " +
        "(plus EGRESS_S3_ENDPOINT / EGRESS_S3_FORCE_PATH_STYLE for R2/MinIO)."
    )
  }

  return new EncodedFileOutput({
    filepath,
    fileType: EncodedFileType.MP4,
    output: {
      case: "s3",
      value: new S3Upload({
        accessKey: EGRESS_S3_ACCESS_KEY,
        secret: EGRESS_S3_SECRET,
        bucket: EGRESS_S3_BUCKET,
        region: EGRESS_S3_REGION || undefined,
        endpoint: EGRESS_S3_ENDPOINT || undefined,
        forcePathStyle: EGRESS_S3_FORCE_PATH_STYLE,
      }),
    },
  })
}

export async function mintToken(input: {
  room_name: string
  identity: string
  name: string
  metadata: Record<string, unknown>
  agent_name?: string
}) {
  requireLiveKitCreds()

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: input.identity,
    name: input.name,
  })
  at.addGrant({
    roomJoin: true,
    room: input.room_name,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  })
  at.roomConfig = new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({
        agentName: input.agent_name || "mavrik",
        metadata: JSON.stringify(input.metadata),
      }),
    ],
  })
  return at.toJwt()
}

export async function startTrackEgresses(input: {
  room_name: string
  tracks: Array<Record<string, unknown>>
  audio_only?: boolean
}) {
  ensureDirs()
  const results: Array<Record<string, unknown>> = []

  if (!s3Configured()) {
    console.error(
      "skipping egress: S3 storage not configured (required on LiveKit Cloud)"
    )
    for (const track of input.tracks) {
      const role = (track.role as string) || "unknown"
      results.push({
        role,
        egress_id: null,
        filepath: `mavrik/${input.room_name}/${role}_{time}.mp4`,
        status: "failed",
        error: "egress_storage_not_configured",
      })
    }
    return results
  }

  requireLiveKitCreds()
  const egress = new EgressClient(
    httpHost(LIVEKIT_URL),
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET
  )

  for (const track of input.tracks) {
    const role = (track.role as string) || "unknown"
    const filepath = `mavrik/${input.room_name}/${role}_{time}.mp4`
    const identity = track.identity as string | undefined
    try {
      const fileOutput = encodedFileOutput(filepath)
      let info
      if (identity) {
        info = await egress.startParticipantEgress(
          input.room_name,
          identity,
          { file: fileOutput },
          { screenShare: false }
        )
      } else {
        info = await egress.startRoomCompositeEgress(
          input.room_name,
          fileOutput,
          {
            layout: "speaker",
            audioOnly: Boolean(input.audio_only),
          }
        )
      }
      results.push({
        role,
        egress_id: info.egressId ?? null,
        filepath,
        status: "started",
      })
    } catch (err) {
      console.error(
        `failed to start egress role=${role} room=${input.room_name}`,
        err
      )
      results.push({
        role,
        egress_id: null,
        filepath,
        status: "failed",
        error: "egress_start_failed",
      })
    }
  }

  return results
}
