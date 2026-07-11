import time


class LLMRouter:
    def __init__(self, premium_client, cheap_client):
        self._premium = premium_client
        self._cheap = cheap_client

    async def route(
        self,
        decision: str,
        messages: list[dict],
        stream: bool = False,
        temperature: float = 0.7,
        max_tokens: int = 2048,
    ) -> dict:
        t0 = time.monotonic()
        if decision == "cheap":
            result = await self._cheap.chat_completion(
                messages=messages,
                stream=stream,
                temperature=temperature,
                max_tokens=max_tokens,
            )
        else:
            result = await self._premium.chat_completion(
                messages=messages,
                stream=stream,
                temperature=temperature,
                max_tokens=max_tokens,
            )
        elapsed = time.monotonic() - t0
        result["_llm_router_time_ms"] = round(elapsed * 1000, 2)
        return result
