# Mavrik

Self-contained LiveKit underwriting interview stack:

- **api/** — FastAPI token mint, sessions, egress, assets, reports
- **worker/** — LiveKit agent with Anam avatar, Muse analysis, proctoring, post-reports
- **frontend/** — Next.js call UI + report view

## Quick start

1. Copy `.env.example` to `.env` and fill LiveKit, Muse (`MODEL_API_KEY`), Anam, Google/Inworld keys.
2. API:

```bash
cd api
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

3. Worker:

```bash
cd worker
uv sync
uv run python main.py dev
```

4. Frontend:

```bash
cd frontend
pnpm install
pnpm dev
```

Open http://localhost:3000 → **Start interview**.

## Disclosure

Height, weight, BMI, heart rate, respiratory rate, and fitness scores are **AI estimates only**, not clinical measurements or medical advice.
