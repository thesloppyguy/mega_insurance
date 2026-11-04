"""Inworld Inference via OpenAI-compatible chat completions."""

from __future__ import annotations

import os

from livekit.plugins import openai

INWORLD_INFERENCE_BASE_URL = "https://api.inworld.ai/v1"
INWORLD_LIST_MODELS_URL = "https://api.inworld.ai/llm/v1alpha/models"
DEFAULT_INWORLD_LLM_MODEL = "gemma-4-26b-a4b-it"


class InworldLLM(openai.LLM):
    """Inworld OpenAI-compat LLM with a working connection prewarm.

    Stock ``openai.LLM`` warms with ``GET /v1/models``, which Inworld does not
    serve. Override to hit Inworld's list-models endpoint so DNS + TLS land in
    the keep-alive pool. Basic auth is applied via ``extra_headers``.
    """

    async def _prewarm_impl(self) -> None:
        from livekit.agents.utils import is_given

        headers: dict[str, str] = {"Accept": "application/json"}
        extra = self._opts.extra_headers
        if is_given(extra) and isinstance(extra, dict):
            headers.update(extra)

        http = self._client._client
        response = await http.get(
            INWORLD_LIST_MODELS_URL,
            headers=headers,
            params={"provider": "inworld"},
        )
        response.raise_for_status()


def build_inworld_llm(*, model: str | None = None) -> InworldLLM:
    api_key = os.getenv("INWORLD_API_KEY", "").strip()
    llm_kwargs: dict = {
        "model": model or DEFAULT_INWORLD_LLM_MODEL,
        "base_url": INWORLD_INFERENCE_BASE_URL,
    }
    if api_key:
        llm_kwargs["api_key"] = api_key
        llm_kwargs["extra_headers"] = {"Authorization": f"Basic {api_key}"}
    return InworldLLM(**llm_kwargs)
