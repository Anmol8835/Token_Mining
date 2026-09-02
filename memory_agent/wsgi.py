"""
Production entrypoint. Local dev: `python app.py`. Deployed (inside the Docker image
built from this project): `gunicorn -w 1 -b 0.0.0.0:$PORT wsgi:app`.

Kept single-worker deliberately: this process's per-user UserCache is a derived,
lazily-loaded copy of Redis (the actual source of truth), rebuilt in-process and kept
warm for fast retrieval. Two independent gunicorn WORKER PROCESSES would each keep
their own separate copy with no cross-worker invalidation — a store() handled by
worker A would not be visible to worker B until worker B's cache happens to reload,
which today only happens on that worker's first-ever touch of that user_id. That's a
real correctness gap, not a performance tuning knob, so this stays single-worker until
a cross-worker invalidation mechanism (e.g. a Redis pub/sub channel workers subscribe
to, dropping their cached copy of a user on any write) is actually built.
"""
from app import app

if __name__ == "__main__":
    app.run()
