# Chrono Lens

**Point your lens at history. Witness the world as it once was.**

Chrono Lens is a real-time multimodal AI agent that identifies architectural landmarks through your camera, generates era-accurate historical reconstructions using Imagen 4, and narrates their history through voice — all in a single fluid experience.

Built for the [Gemini Live Agent Challenge](https://geminiliveagentchallenge.devpost.com/) — **Creative Storyteller** category.

---

## What it does

1. **See** — Point your camera at any landmark (Eiffel Tower, Gateway of India, Colosseum, etc.)
2. **Identify** — Gemini 2.5 Flash vision model recognises the landmark in real time
3. **Reconstruct** — Imagen 4 generates a photorealistic historical image of the landmark in its most iconic era
4. **Narrate** — Gemini Live API (native audio) voices a cinematic narration with historical facts
5. **Converse** — Tap the mic to ask follow-up questions. The agent answers from full historical context
6. **Archive** — Every discovery is saved to the Chronos Vault (IndexedDB) with image, era, narration, and fact cards

---

## Tech stack

| Component | Technology |
|-----------|------------|
| Frontend | Next.js 14, TypeScript, Tailwind CSS |
| Backend | FastAPI (Python), WebSockets |
| Voice narration | Gemini Live API — `gemini-2.5-flash-native-audio-preview-12-2025` |
| Vision + tool calls | Gemini 2.5 Flash — `gemini-2.5-flash` |
| Image generation | Imagen 4 — `imagen-4.0-generate-001` |
| AI SDK | Google GenAI Python SDK `>=1.0` |
| Deployment | Google Cloud Run |
| Persistence | IndexedDB (idb-keyval) |

---

## Architecture

```
User (camera + mic)
        │
        ▼
Next.js Frontend (Next.js 14)
  - CameraStream.tsx    → captures video frames + browser STT
  - useAudioStream.ts   → PCM audio capture + playback
  - socket.ts           → WebSocket client
  - IndexedDB vault     → persistent discovery history
        │
        │ WebSocket (wss://)
        ▼
FastAPI Backend (Google Cloud Run)
  - /ws/live            → main WebSocket endpoint
  - Vision analyser     → sends frames to Gemini 2.5 Flash
  - Tool dispatcher     → executes trigger_historical_reconstruction
  - Fresh session Q&A   → one Live session per voice question
        │
        ├──→ Gemini Live API (native audio)
        │     └─ Puck voice, automatic VAD, audio streaming
        │
        ├──→ Gemini 2.5 Flash (vision + function calling)
        │     └─ Landmark detection → trigger_historical_reconstruction tool
        │
        └──→ Imagen 4
              └─ Era-accurate historical reconstruction image
```

---

## Multimodal interleaved output

Each landmark discovery produces a **synchronised multi-modal response**:

- **Audio** — Puck voice narrates history via Gemini Live API (streams as PCM)
- **Image** — Imagen 4 historical reconstruction overlays the live camera feed
- **Text** — Transcription appears in the Chronos Intelligence panel
- **Fact cards** — 3 curated historical facts + poetic tagline
- **Ambient music** — Location-appropriate music tag triggers frontend audio

All generated simultaneously from a single agent decision — this is the interleaved output the Creative Storyteller category requires.

---

## Running locally

### Prerequisites

- Python 3.11+
- Node.js 18+
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/)

### Backend

```bash
cd backend

# Create virtual environment
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Create .env file
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY

# Run
python main.py
# Backend runs on http://localhost:8000
```

### Frontend

```bash
cd frontend

# Install dependencies
npm install

# Create .env.local
echo "NEXT_PUBLIC_WS_URL=ws://localhost:8000" > .env.local

# Run
npm run dev
# Frontend runs on http://localhost:3000
```

### .env example

```
GEMINI_API_KEY=your_gemini_api_key_here
GOOGLE_MAPS_API_KEY=your_maps_api_key_here
```

---

## Deploying to Google Cloud Run

### Prerequisites

```bash
# Install gcloud CLI: https://cloud.google.com/sdk/docs/install
gcloud auth login
gcloud config set project chronolens-489307
gcloud services enable run.googleapis.com cloudbuild.googleapis.com
```

### Deploy backend

```bash
cd backend

gcloud run deploy chrono-lens-backend \
  --source . \
  --project chronolens-489307 \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "GEMINI_API_KEY=YOUR_KEY" \
  --set-env-vars "GOOGLE_MAPS_API_KEY=YOUR_KEY" \
  --memory 2Gi \
  --timeout 3600 \
  --min-instances 1
```

### Deploy frontend

```bash
cd frontend

# Update WebSocket URL to your Cloud Run URL
# Edit .env.production:
# NEXT_PUBLIC_WS_URL=wss://your-cloud-run-url.run.app

npm run build
# Deploy to Vercel, Firebase Hosting, or any static host
```

---

## Automated deployment

A `deploy.sh` script is included for one-command deployment:

```bash
chmod +x deploy.sh
./deploy.sh
```

---

## Project structure

```
chrono-lens/
├── backend/
│   ├── main.py              # FastAPI WebSocket server + hybrid AI pipeline
│   ├── tools/
│   │   └── tools.py         # trigger_historical_reconstruction tool
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   └── CameraStream.tsx   # Main UI component
│   │   ├── hooks/
│   │   │   └── useAudioStream.ts  # PCM audio capture + playback
│   │   └── lib/
│   │       └── socket.ts          # WebSocket client
│   ├── package.json
│   └── next.config.js
├── deploy.sh
└── README.md
```

---

## Key technical decisions

**Hybrid audio architecture** — `gemini-2.5-flash-native-audio-preview` does not support sequential `send_client_content` turns (only the first turn receives a response). Solution: each voice question opens a fresh Live session with full conversation history injected into the prompt. This gives unlimited back-and-forth with consistent context.

**Separate vision model** — The native audio model also does not support function calling. Gemini 2.5 Flash handles all vision analysis and tool execution, while the native audio model handles narration exclusively. Results are piped together seamlessly.

**Frame throttling** — Video frames are sent at max 1 per 5 seconds to Gemini 2.5 Flash for landmark detection. Once a landmark is identified, frame sending pauses until the user taps "Live Rescan", preventing redundant API calls.

**Conversation context** — Each Q&A session injects the current landmark (name + era) and last 3 conversation exchanges into the prompt, maintaining continuity without relying on session state.

---

## Hackathon

Built for the **Gemini Live Agent Challenge** — Creative Storyteller category.  
Submission deadline: March 16, 2026.  
Hashtag: #GeminiLiveAgentChallenge

This project was created for the purposes of entering the Gemini Live Agent Challenge hackathon by Google/Devpost.
