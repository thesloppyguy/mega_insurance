# Mavrik

Self-contained LiveKit underwriting interview stack:

- **frontend/** — Next.js call UI with stage overlays, report view, and API routes
- **worker/** — Gemini Live agent (`gemini-3.8-live`) with camera + mic, stage tools (`set_stage`, `request_capture`)

## Quick start

1. Copy `.env.example` to `.env` and fill LiveKit + `GOOGLE_API_KEY`.
   Optional: `GEMINI_LIVE_MODEL` / `GEMINI_LIVE_VOICE` (defaults `gemini-3.8-live` / `Puck`).
   For session recordings on LiveKit Cloud, also set `EGRESS_S3_*`.
   Point `API_PUBLIC_BASE_URL` at the Next.js app (`http://127.0.0.1:3000/api`).
2. Frontend (serves UI + API):

```bash
cd frontend
pnpm install
pnpm dev
```

3. Worker:

```bash
cd worker
uv sync
uv run python main.py dev
```

Open http://localhost:3000 → **Start interview**.

The agent sees the user camera, coaches posture, updates stage UI via RPC, and can trigger captures.
The frontend also runs **MediaPipe Pose** and streams `pose_context` to the worker so the agent
coaches automatically (no “does that look okay?” loop) and captures when `pose_ok` is stable.
Stills upload to the session; Muse underwriting analysis is not used in this path.
