import {
  API_PUBLIC_BASE_URL,
  WORKER_API_KEY,
} from "./config"
import type { SessionRecord } from "./store"

const CASCADE_INSTRUCTIONS =
  "You are Sanjay, a professional underwriting interview guide. " +
  "Guide the candidate through face capture, body scan, Aadhaar verification, and QnA. " +
  "Use the available tools for captures and OTP. Speak clearly. Do not invent medical diagnoses."

const CASCADE_GREETING =
  "Hello, and welcome. I am Sanjay from Mavrik, your interview guide. " +
  "I will walk you through identity and body captures. Are you ready?"

export function buildAgentDispatchMetadata(session: SessionRecord) {
  const cfg = (session.config || {}) as Record<string, unknown>
  const callerName =
    (cfg.caller_name as string | undefined) ||
    session.participant_name ||
    "Candidate"

  return {
    session_id: session.session_id,
    organization_id: session.organization_id,
    campaign_id: session.campaign_id,
    recording_enabled: cfg.recording_enabled !== false,
    caller_name: callerName,
    contact_metadata: {
      caller_name: callerName,
    },
    max_duration_seconds: (cfg.max_duration_seconds as number) ?? 1800,
    inactivity_warning_seconds: (cfg.inactivity_warning_seconds as number) ?? 45,
    inactivity_end_seconds: (cfg.inactivity_end_seconds as number) ?? 120,
    tools_context: {
      backend_base_url: API_PUBLIC_BASE_URL,
      worker_api_key: WORKER_API_KEY,
      session_id: session.session_id,
    },
    avatar: {
      provider_id: "arkit",
      external_avatar_id: "sanjay",
      name: "Sanjay",
    },
    config: {
      pipeline_mode: "cascaded",
      stt: { provider: "meta", model: "muse-voice-transcribe-1.0" },
      llm: {
        provider: "inworld",
        model: "gemma-4-26b-a4b-it",
      },
      tts: {
        provider: "inworld",
        model: "inworld-tts-2-flash",
        voice: "Aarav",
      },
      realtime: null,
      avatar: {
        provider_id: "arkit",
        external_avatar_id: "sanjay",
        name: "Sanjay",
        enabled: true,
      },
      instructions: (cfg.instructions as string | undefined) || CASCADE_INSTRUCTIONS,
      greeting: (cfg.greeting as string | undefined) || CASCADE_GREETING,
    },
  }
}
