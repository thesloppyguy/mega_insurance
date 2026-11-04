# Mavrik

Live video underwriting interview: AI agent + OptiModel avatar + identity capture + post-call report.

```
frontend/   Next.js UI + API
worker/     LiveKit agent (mavrik)
```

## Setup

1. Copy env templates and fill credentials:

```bash
cp frontend/.env.example frontend/.env
cp worker/.env.example worker/.env
```

Required: LiveKit, Inworld (`INWORLD_API_KEY`), Meta Muse (`MODEL_API_KEY` / `META_API_KEY`).  
Optional: S3 egress for recordings, Deepvue for Aadhaar eKYC.

2. Frontend:

```bash
cd frontend && pnpm install && pnpm dev
```

3. Worker (agent name **`mavrik`**):

```bash
cd worker && uv sync && uv run python main.py dev
```

Open http://localhost:3000 → connection preview → **Start interview**.  
After the call: `/report/{sessionId}`.
