"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Poll a JSON endpoint on an interval. While a refetch is in flight the
 * previous render is held (React keeps the old state), so panels never
 * flash skeletons mid-stream. `stale` turns true only after a failed
 * fetch, so the UI can show a last-updated note instead of clearing.
 */
export function usePoll<T>(path: string | null, intervalMs = 3000) {
  const [data, setData] = useState<T | null>(null);
  const [stale, setStale] = useState(false);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!path) return;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      try {
        const res = await fetch(path!, { cache: "no-store" });
        if (!res.ok) throw new Error(`${res.status}`);
        const json = (await res.json()) as T;
        if (!alive.current) return;
        setData(json);
        setStale(false);
        setLastOk(Date.now());
      } catch {
        if (alive.current) setStale(true);
      } finally {
        if (alive.current) timer = setTimeout(tick, intervalMs);
      }
    }

    tick();
    return () => clearTimeout(timer);
  }, [path, intervalMs]);

  return { data, stale, lastOk };
}
