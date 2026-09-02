FROM python:3.11-slim

WORKDIR /app

# libgomp1: onnxruntime (used internally by fastembed) needs the OpenMP runtime on
# Linux — without it the container starts fine but crashes on the first embed() call,
# which is exactly the kind of hiccup this whole bundle exists to avoid.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the embedding model INTO the image at build time — this is what makes
# the running container genuinely self-contained: it never reaches out to the
# internet at runtime, not even on its very first request.
RUN python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='BAAI/bge-small-en-v1.5')"

COPY app.py redis_store.py wsgi.py ./
COPY static ./static

ENV HOST=0.0.0.0
ENV PORT=5090
EXPOSE 5090

# Single worker — see wsgi.py's docstring for exactly why more than one is unsafe
# with today's code (no cross-worker cache invalidation yet).
CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:5090", "--timeout", "120", "wsgi:app"]
