# Mavrik

Self-contained LiveKit underwriting interview stack:

- **frontend/** — Next.js call UI (prejoin + OptiModel Sanjay + report) and API routes
- **worker/** — Cascaded LiveKit agent (`mavrik`) with Muse STT, Inworld Gemma LLM, Inworld TTS, OptiModel lipsync, composite egress, and Muse post-call reports

See [docs/MODELS_AND_DATAFLOW.md](docs/MODELS_AND_DATAFLOW.md) for models, payloads, and end-to-end dataflow.

## Features (MVP)

- **Connection preview** — camera/mic check, `caller_name`, MediaPipe face-visible gate before Start
- **OptiModel avatar Sanjay** — client-rendered Gaussian avatar driven by worker FLAME lipsync
- **Cascaded pipeline** — `muse-voice-transcribe-1.0` → Inworld `gemma-4-26b-a4b-it` → `inworld-tts-2-flash`
- **Room composite egress** — speaker-layout MP4 to S3 when recording is enabled
- **Post-call report** — downloads room-composite egress MP4 → SAM 3.1 video segmentation (person/face/id card) → Muse Wonder underwriting for `/report/[sessionId]`

## Quick start

1. Copy `.env.example` to `.env` and fill:
   - LiveKit credentials
   - `INWORLD_API_KEY`
   - `MODEL_API_KEY` / `META_API_KEY` (Muse STT + report)
   - `EGRESS_S3_*` for recordings
   - `API_PUBLIC_BASE_URL=http://127.0.0.1:3000/api` and `WORKER_API_KEY`
2. Frontend:

```bash
cd frontend
pnpm install
pnpm dev
```

3. Worker (agent name must be `mavrik`):

```bash
cd worker
uv sync
uv run python main.py dev
```

Open http://localhost:3000 → complete the connection preview → **Start interview**.

After the call ends, open `/report/{sessionId}` for the Muse underwriting summary.

## Agent dispatch

The frontend mints LiveKit tokens that dispatch agent name **`mavrik`** with metadata including `session_id`, `caller_name` / `contact_metadata`, and `recording_enabled`.

## OptiModel assets

Sanjay packs live under `frontend/public/spatialreal/avatars/sanjay-3c409ac5/`.
Local avatar API: `GET /avatar-api/v2/avatar/{id}`.
