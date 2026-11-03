import {
  ANAM_AVATAR_ID,
  ANAM_AVATAR_NAME,
  API_PUBLIC_BASE_URL,
  WORKER_API_KEY,
} from "./config"
import type { SessionRecord } from "./store"

const LIVE_INSTRUCTIONS =
  "You are Mavrik, a professional underwriting interview guide with live camera vision. " +
  "Guide the candidate through precheck, face, liveness, KYC ID, body front, and body back. " +
  "Use set_stage when changing stages. MediaPipe pose updates are context only — they never capture. " +
  "When framing looks good, tell the candidate you are capturing, then call request_capture. " +
  "Speak clearly. Do not invent medical diagnoses."

const LIVE_GREETING =
  "Hello, and welcome. I am Mavrik, your interview guide. " +
  "I can see your camera and will walk you through identity and body captures. Are you ready?"

export function buildAgentDispatchMetadata(session: SessionRecord) {
  const cfg = (session.config || {}) as Record<string, unknown>
  const avatarId = (cfg.anam_avatar_id as string | undefined) || ANAM_AVATAR_ID
  const avatarName =
    (cfg.anam_avatar_name as string | undefined) || ANAM_AVATAR_NAME
  // Gemini Live speaks natively — keep avatar off unless explicitly requested.
  const useAvatar = Boolean(avatarId) && cfg.use_avatar === true
  const liveModel =
    (cfg.realtime_model as string | undefined) ||
    process.env.GEMINI_LIVE_MODEL ||
    "gemini-3.8-live"
  const liveVoice =
    (cfg.realtime_voice as string | undefined) ||
    process.env.GEMINI_LIVE_VOICE ||
    "Puck"

  return {
    session_id: session.session_id,
    organization_id: session.organization_id,
    campaign_id: session.campaign_id,
    recording_enabled: cfg.recording_enabled !== false,
    use_avatar: useAvatar,
    max_duration_seconds: (cfg.max_duration_seconds as number) ?? 1800,
    inactivity_warning_seconds: (cfg.inactivity_warning_seconds as number) ?? 45,
    inactivity_end_seconds: (cfg.inactivity_end_seconds as number) ?? 120,
    dial_phone_number: null,
    tools_context: {
      backend_base_url: API_PUBLIC_BASE_URL,
      worker_api_key: WORKER_API_KEY,
      session_id: session.session_id,
    },
    avatar: {
      provider_id: useAvatar ? "anam" : null,
      external_avatar_id: useAvatar ? avatarId || null : null,
      name: avatarName,
    },
    config: {
      stt: null,
      llm: null,
      tts: null,
      realtime: {
        provider: "google",
        model: liveModel,
        voice: liveVoice,
      },
      avatar: {
        provider_id: useAvatar ? "anam" : null,
        external_avatar_id: useAvatar ? avatarId || null : null,
        name: avatarName,
      },
      noise_filtering: {
        enabled: false,
        suppression_level: 50,
      },
      background_audio: {
        enabled: false,
        ambient_volume: Number(cfg.ambient_volume ?? 0.35),
        thinking_volume: Number(cfg.thinking_volume ?? 0.45),
      },
      tool_call_audio: {
        enabled: false,
      },
      instructions: (cfg.instructions as string | undefined) || LIVE_INSTRUCTIONS,
      greeting: (cfg.greeting as string | undefined) || LIVE_GREETING,
    },
  }
}
