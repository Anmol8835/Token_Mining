from typing import Optional

from src.cache.exact import ExactCache
from src.memory.experience import ExperienceMemory
from src.memory.semantic import SemanticMemory

SHORTCUT_SIMILARITY_THRESHOLD = 0.75
SHORTCUT_PREFIX = "shortcut:"  # prefix for semantic memory keys


class LearningEngine:
    def __init__(
        self,
        semantic_memory: SemanticMemory,
        experience_memory: Optional[ExperienceMemory] = None,
        exact_cache: Optional[ExactCache] = None,
        shortcut_threshold: float = SHORTCUT_SIMILARITY_THRESHOLD,
    ):
        self._semantic = semantic_memory
        self._experience = experience_memory or ExperienceMemory()
        self._cache = exact_cache
        self.shortcut_threshold = shortcut_threshold
        self._shortcut_hits = 0
        self._shortcut_misses = 0

    async def init_db(self):
        await self._experience.init_db()

    async def record_execution(
        self,
        goal: str,
        resolution: str,
        model_used: str = "",
        tokens_saved: int = 0,
        cost_saved: float = 0.0,
        success: bool = True,
        metadata: dict = None,
    ) -> int:
        return await self._experience.record(
            goal=goal,
            resolution=resolution,
            model_used=model_used,
            tokens_saved=tokens_saved,
            cost_saved=cost_saved,
            success=success,
            metadata=metadata,
        )

    async def learn_from(self, exp_id: int):
        entries = await self._experience.list_all()
        match = next((e for e in entries if e["id"] == exp_id), None)
        if not match or not match["success"]:
            return

        await self._experience.mark_shortcut(exp_id)
        shortcut_key = f"{SHORTCUT_PREFIX}{exp_id}"
        shortcut_text = f"Goal: {match['goal']}"
        shortcut_meta = {
            "type": "shortcut",
            "experience_id": exp_id,
            "goal": match["goal"],
            "resolution": match["resolution"],
            "model_used": match["model_used"],
            "tokens_saved": match["tokens_saved"],
            "cost_saved": match["cost_saved"],
        }
        await self._semantic.store(shortcut_key, shortcut_text, shortcut_meta)

    async def find_shortcut(self, query: str) -> Optional[dict]:
        results = await self._semantic.retrieve(
            query,
            top_k=1,
            threshold=self.shortcut_threshold,
        )
        if results and results[0]["key"].startswith(SHORTCUT_PREFIX):
            self._shortcut_hits += 1
            meta = results[0]["metadata"]
            return {
                "key": results[0]["key"],
                "score": results[0]["score"],
                "goal": meta.get("goal", ""),
                "resolution": meta.get("resolution", ""),
                "model_used": meta.get("model_used", ""),
                "tokens_saved": meta.get("tokens_saved", 0),
                "cost_saved": meta.get("cost_saved", 0.0),
                "experience_id": meta.get("experience_id"),
            }
        self._shortcut_misses += 1
        return None

    async def auto_learn(self, min_usage: int = 2):
        entries = await self._experience.list_all()
        for e in entries:
            if e["success"] and not e["is_shortcut"] and e["usage_count"] >= min_usage:
                await self.learn_from(e["id"])

    def stats(self) -> dict:
        total = self._shortcut_hits + self._shortcut_misses
        hit_rate = round(self._shortcut_hits / max(total, 1) * 100, 1)
        return {
            "shortcut_hits": self._shortcut_hits,
            "shortcut_misses": self._shortcut_misses,
            "shortcut_hit_rate_percent": hit_rate,
            "threshold": self.shortcut_threshold,
        }

    async def close(self):
        await self._experience.close()
