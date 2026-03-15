#!/bin/bash
# deploy.sh — Chrono Lens automated deployment to Google Cloud Run
# Created for the Gemini Live Agent Challenge
# Usage: chmod +x deploy.sh && ./deploy.sh

set -e

PROJECT_ID="chronolens-489307"
SERVICE_NAME="chrono-lens-backend"
REGION="us-central1"

echo "=== Chrono Lens — Cloud Run Deployment ==="
echo "Project: $PROJECT_ID"
echo "Service: $SERVICE_NAME"
echo "Region:  $REGION"
echo ""

# Check required env vars
if [ -z "$GEMINI_API_KEY" ]; then
  echo "ERROR: GEMINI_API_KEY environment variable not set"
  echo "Run: export GEMINI_API_KEY=your_key_here"
  exit 1
fi

# Enable required APIs
echo "=== Enabling GCP APIs ==="
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  --project "$PROJECT_ID"

# Deploy backend to Cloud Run
echo ""
echo "=== Deploying backend to Cloud Run ==="
cd "$(dirname "$0")/backend"

gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "GEMINI_API_KEY=${GEMINI_API_KEY}" \
  --set-env-vars "GOOGLE_MAPS_API_KEY=${GOOGLE_MAPS_API_KEY:-}" \
  --memory 2Gi \
  --timeout 3600 \
  --min-instances 1 \
  --max-instances 3

echo ""
echo "=== Deployment complete ==="
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format "value(status.url)")
echo "Backend URL: $SERVICE_URL"
echo "Health check: $SERVICE_URL/health"
echo ""
echo "Update your frontend .env.production:"
echo "NEXT_PUBLIC_WS_URL=wss://${SERVICE_URL#https://}"
