FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY src/ src/
COPY bench/ bench/

RUN pip install --no-cache-dir -e ".[dev]" && \
    python -m spacy download en_core_web_sm

EXPOSE 8080

CMD ["uvicorn", "src.gateway.server:app", "--host", "0.0.0.0", "--port", "8080"]
