# ── Chrono Lens — Backend Dockerfile ──────────────────────────────────────────
# Targets Google Cloud Run (port 8080, single container, no root user).
# Build:  docker build -t chronos-lens-backend .
# Local:  docker run -p 8080:8080 --env-file .env chronos-lens-backend
# Deploy: see deployment.yaml or README.md

FROM python:3.11-slim

# ── System hygiene ─────────────────────────────────────────────────────────────
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

# ── Install Python dependencies ────────────────────────────────────────────────
# Copy requirements first so Docker layer caching skips pip on code-only changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Copy application source ────────────────────────────────────────────────────
# Exclude venv, __pycache__, .env (secrets are injected via Cloud Run Secret Manager)
COPY main.py .
COPY styles.txt .
COPY tools/ ./tools/

# ── Non-root user (Cloud Run security best-practice) ──────────────────────────
RUN adduser --disabled-password --gecos "" appuser
USER appuser

# ── Start server ───────────────────────────────────────────────────────────────
# Cloud Run routes external traffic to $PORT (default 8080).
# --workers 1 is intentional: each Cloud Run instance owns one WebSocket session
# pool. Horizontal scaling is handled by Cloud Run autoscaling (minScale: 1).
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
