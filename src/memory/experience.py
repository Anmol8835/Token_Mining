import json
import sqlite3
import time
from typing import Optional

MAX_EXPERIENCES = 100


class ExperienceMemory:
    def __init__(self, db_path: str = "experience.db", max_entries: int = MAX_EXPERIENCES):
        self.db_path = db_path
        self.max_entries = max_entries
        self._conn: Optional[sqlite3.Connection] = None

    async def init_db(self):
        self._conn = sqlite3.connect(self.db_path)
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS experiences ("
            "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  goal TEXT NOT NULL,"
            "  resolution TEXT NOT NULL,"
            "  model_used TEXT NOT NULL DEFAULT '',"
            "  tokens_saved INTEGER NOT NULL DEFAULT 0,"
            "  cost_saved REAL NOT NULL DEFAULT 0.0,"
            "  success INTEGER NOT NULL DEFAULT 1,"
            "  is_shortcut INTEGER NOT NULL DEFAULT 0,"
            "  usage_count INTEGER NOT NULL DEFAULT 0,"
            "  metadata TEXT DEFAULT '{}',"
            "  created_at REAL NOT NULL,"
            "  last_used_at REAL NOT NULL"
            ")"
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_experiences_shortcut ON experiences (is_shortcut)"
        )
        self._conn.commit()

    async def record(
        self,
        goal: str,
        resolution: str,
        model_used: str = "",
        tokens_saved: int = 0,
        cost_saved: float = 0.0,
        success: bool = True,
        metadata: dict = None,
    ) -> int:
        now = time.time()
        self._conn.execute(
            "INSERT INTO experiences "
            "(goal, resolution, model_used, tokens_saved, cost_saved, "
            "success, metadata, created_at, last_used_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                goal,
                resolution,
                model_used,
                tokens_saved,
                cost_saved,
                1 if success else 0,
                json.dumps(metadata or {}),
                now,
                now,
            ),
        )
        self._conn.commit()
        exp_id = self._conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        self._evict_if_needed()
        return exp_id

    def _evict_if_needed(self):
        count = self._conn.execute("SELECT COUNT(*) FROM experiences").fetchone()[0]
        if count <= self.max_entries:
            return
        excess = count - self.max_entries
        self._conn.execute(
            "DELETE FROM experiences WHERE id IN ("
            "  SELECT id FROM experiences"
            "  WHERE is_shortcut = 0"
            "  ORDER BY usage_count ASC, last_used_at ASC"
            f"  LIMIT {excess}"
            ")"
        )
        self._conn.commit()

    async def mark_shortcut(self, exp_id: int):
        self._conn.execute(
            "UPDATE experiences SET is_shortcut = 1 WHERE id = ?",
            (exp_id,),
        )
        self._conn.commit()

    async def increment_usage(self, exp_id: int):
        now = time.time()
        self._conn.execute(
            "UPDATE experiences SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?",
            (now, exp_id),
        )
        self._conn.commit()

    async def list_shortcuts(self) -> list[dict]:
        rows = self._conn.execute(
            "SELECT id, goal, resolution, model_used, tokens_saved, cost_saved, "
            "usage_count, created_at "
            "FROM experiences WHERE is_shortcut = 1 "
            "ORDER BY usage_count DESC"
        ).fetchall()
        return [
            {
                "id": r[0],
                "goal": r[1],
                "resolution": r[2],
                "model_used": r[3],
                "tokens_saved": r[4],
                "cost_saved": r[5],
                "usage_count": r[6],
                "created_at": r[7],
            }
            for r in rows
        ]

    async def list_all(self) -> list[dict]:
        rows = self._conn.execute(
            "SELECT id, goal, resolution, model_used, tokens_saved, cost_saved, "
            "success, is_shortcut, usage_count, created_at "
            "FROM experiences ORDER BY created_at DESC"
        ).fetchall()
        return [
            {
                "id": r[0],
                "goal": r[1],
                "resolution": r[2],
                "model_used": r[3],
                "tokens_saved": r[4],
                "cost_saved": r[5],
                "success": bool(r[6]),
                "is_shortcut": bool(r[7]),
                "usage_count": r[8],
                "created_at": r[9],
            }
            for r in rows
        ]

    async def stats(self) -> dict:
        total = self._conn.execute("SELECT COUNT(*) FROM experiences").fetchone()[0]
        shortcuts = self._conn.execute(
            "SELECT COUNT(*) FROM experiences WHERE is_shortcut = 1"
        ).fetchone()[0]
        total_usage = self._conn.execute(
            "SELECT COALESCE(SUM(usage_count), 0) FROM experiences WHERE is_shortcut = 1"
        ).fetchone()[0]
        total_tokens = self._conn.execute(
            "SELECT COALESCE(SUM(tokens_saved), 0) FROM experiences"
        ).fetchone()[0]
        total_cost = self._conn.execute(
            "SELECT COALESCE(SUM(cost_saved), 0) FROM experiences"
        ).fetchone()[0]
        return {
            "total_experiences": total,
            "shortcuts": shortcuts,
            "total_shortcut_uses": total_usage,
            "total_tokens_saved": total_tokens,
            "total_cost_saved": round(total_cost, 6),
            "max_entries": self.max_entries,
        }

    async def clear(self):
        self._conn.execute("DELETE FROM experiences")
        self._conn.commit()

    async def close(self):
        if self._conn:
            self._conn.close()
