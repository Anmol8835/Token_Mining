import time
from typing import AsyncIterator

import httpx

from src.config import settings


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


class ModelClient:
    def __init__(
        self,
        api_key: str = "",
        api_base: str = "",
        model: str = "",
        label: str = "",
    ):
        self.api_key = api_key
        self.api_base = api_base
        self.model = model
        self.label = label or model
        self._client = httpx.AsyncClient(timeout=120.0)

    async def chat_completion(
        self,
        messages: list[dict],
        stream: bool = False,
        temperature: float = 0.7,
        max_tokens: int = 2048,
    ) -> dict:
        if not self.api_key:
            return self._simulate(messages, max_tokens)

        payload = {
            "model": self.model,
            "messages": messages,
            "stream": stream,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        t0 = time.monotonic()
        response = await self._client.post(
            f"{self.api_base}/chat/completions",
            json=payload,
            headers=headers,
        )
        elapsed = time.monotonic() - t0
        response.raise_for_status()
        body = response.json()
        usage = body.get("usage", {})
        return {
            "model": self.model,
            "content": body["choices"][0]["message"]["content"],
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
            "total_tokens": usage.get("total_tokens", 0),
            "latency_ms": round(elapsed * 1000, 2),
        }

    def _simulate(self, messages: list[dict], max_tokens: int) -> dict:
        last = messages[-1]["content"] if messages else ""
        pt = sum(estimate_tokens(m.get("content", "")) for m in messages)
        ct = min(max_tokens, estimate_tokens(last) + 20)
        return {
            "model": f"{self.model} (simulated)",
            "content": f"[{self.label}] Simulated to: {last[:60]}...",
            "prompt_tokens": pt,
            "completion_tokens": ct,
            "total_tokens": pt + ct,
            "latency_ms": round(0.5, 2),
        }

    async def chat_completion_stream(
        self,
        messages: list[dict],
        temperature: float = 0.7,
        max_tokens: int = 2048,
    ) -> AsyncIterator[str]:
        if not self.api_key:
            yield '{"choices":[{"delta":{"content":"[simulated stream]"}}]}'
            return

        payload = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        async with self._client.stream(
            "POST",
            f"{self.api_base}/chat/completions",
            json=payload,
            headers=headers,
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    chunk = line[6:]
                    if chunk.strip() == "[DONE]":
                        break
                    yield chunk

    async def close(self):
        await self._client.aclose()


premium_client = ModelClient(
    api_key=settings.premium_api_key,
    api_base=settings.premium_api_base,
    model=settings.premium_model,
    label="premium",
)

cheap_client = ModelClient(
    api_key=settings.cheap_api_key or settings.premium_api_key,
    api_base=settings.cheap_api_base or settings.premium_api_base,
    model=settings.cheap_model,
    label="cheap",
)
