from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("MAVRIK_DATA_DIR", ROOT / "data"))
SESSIONS_DIR = DATA_DIR / "sessions"
ASSETS_DIR = DATA_DIR / "assets"
EGRESS_DIR = DATA_DIR / "egress"

LIVEKIT_URL = os.getenv("LIVEKIT_URL", "")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "")

WORKER_API_KEY = os.getenv("WORKER_API_KEY", "dev-worker-key")
API_PUBLIC_BASE_URL = os.getenv("API_PUBLIC_BASE_URL", "http://127.0.0.1:8000")

ANAM_AVATAR_ID = os.getenv("ANAM_AVATAR_ID", "")
ANAM_AVATAR_NAME = os.getenv("ANAM_AVATAR_NAME", "Mavrik Interviewer")

DEFAULT_ORG_ID = os.getenv("DEFAULT_ORG_ID", "org_local")
DEFAULT_CAMPAIGN_ID = os.getenv("DEFAULT_CAMPAIGN_ID", "campaign_local")


def ensure_dirs() -> None:
    for path in (DATA_DIR, SESSIONS_DIR, ASSETS_DIR, EGRESS_DIR):
        path.mkdir(parents=True, exist_ok=True)
