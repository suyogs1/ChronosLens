"""
main.py — Chrono Lens Streaming Backend
=========================================
Hybrid architecture:
  - Gemini Native Audio Live — main session (narration + audio playback)
  - Gemini Native Audio Live — fresh session per text question
    (model limitation: only 1 send_client_content turn per session)
  - Gemini 2.5 Flash — vision + tool calls + Imagen 4

Context is maintained by injecting landmark info into every question prompt.
"""

import asyncio
import base64
import json
import os
import re
import sys

import dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
dotenv.load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
GEMINI_API_KEY      = os.environ["GEMINI_API_KEY"]
GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")

# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.dirname(__file__))
from tools.tools import (
    TRIGGER_RECONSTRUCTION_SCHEMA,
    execute_trigger_historical_reconstruction,
)

# ---------------------------------------------------------------------------
# Clients
# ---------------------------------------------------------------------------
client = genai.Client(
    api_key=GEMINI_API_KEY,
    http_options=types.HttpOptions(api_version='v1alpha')
)
vision_client = genai.Client(api_key=GEMINI_API_KEY)

AUDIO_MODEL  = "gemini-2.5-flash-native-audio-preview-12-2025"
VISION_MODEL = "gemini-2.5-flash"

# ---------------------------------------------------------------------------
# Ambient music map
# ---------------------------------------------------------------------------
AMBIENT_MUSIC_MAP = {
    "india": "indian_classical", "taj mahal": "indian_classical",
    "golden temple": "indian_classical", "gateway": "indian_classical",
    "mumbai": "indian_classical", "delhi": "indian_classical",
    "agra": "indian_classical", "ladakh": "indian_classical",
    "mosque": "arabic_oud", "mecca": "arabic_oud",
    "dubai": "arabic_oud", "istanbul": "arabic_oud",
    "jerusalem": "arabic_oud", "kaaba": "arabic_oud",
    "colosseum": "roman_orchestral", "rome": "roman_orchestral",
    "paris": "french_cafe", "eiffel": "french_cafe",
    "london": "british_orchestral", "big ben": "british_orchestral",
    "athens": "greek_classical", "acropolis": "greek_classical",
    "vienna": "european_classical", "prague": "european_classical",
    "barcelona": "spanish_guitar", "sagrada": "spanish_guitar",
    "china": "chinese_erhu", "great wall": "chinese_erhu",
    "beijing": "chinese_erhu", "japan": "japanese_koto",
    "tokyo": "japanese_koto", "kyoto": "japanese_koto",
    "angkor": "southeast_asian", "cambodia": "southeast_asian",
    "machu picchu": "andean_flute", "peru": "andean_flute",
    "new york": "jazz_ambient", "statue of liberty": "jazz_ambient",
    "niagara": "ambient_orchestral", "canada": "ambient_orchestral",
    "egypt": "ancient_egypt", "pyramid": "ancient_egypt",
    "giza": "ancient_egypt", "cairo": "ancient_egypt",
    "russia": "european_classical", "moscow": "european_classical",
    "mexico": "andean_flute", "chichen": "andean_flute",
    "milan": "european_classical", "duomo": "european_classical",
    "monaco": "french_cafe", "france": "french_cafe",
    "default": "ambient_orchestral",
}

def get_music_tag(location_name: str) -> str:
    loc_lower = location_name.lower()
    for keyword, tag in AMBIENT_MUSIC_MAP.items():
        if keyword in loc_lower:
            return tag
    return AMBIENT_MUSIC_MAP["default"]

# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------
NARRATION_SYSTEM_PROMPT = """You are the Chronos Historian — a warm, enthusiastic history guide.
When given a LANDMARK IDENTIFIED message, respond with exactly:
- 2 warm sentences about its history
- 1 interesting question
Maximum 300 characters total. Be enthusiastic and friendly.
"""

QA_SYSTEM_PROMPT = """You are the Chronos Historian — a warm, knowledgeable history guide.
Answer the user's question about the landmark in 2-3 sentences.
Be enthusiastic, friendly, and informative.
Keep answers concise and engaging.
"""

VISION_SYSTEM_PROMPT = """You are a landmark detection agent.
If you see ANY recognisable landmark — call trigger_historical_reconstruction IMMEDIATELY.
Fields: location_name (full name + city), target_era (most interesting era), perspective_descriptor (camera angle).
If NO landmark visible: respond with exactly: NO_LANDMARK
Never respond with text if you see a landmark."""

TOOLS = [types.Tool(function_declarations=[TRIGGER_RECONSTRUCTION_SCHEMA])]

# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(title="Chrono Lens")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Tool dispatcher
# ---------------------------------------------------------------------------
async def dispatch_tool(name: str, args: dict) -> dict:
    print(f"[dispatch] tool={name} args={args}")
    if name == "trigger_historical_reconstruction":
        return await execute_trigger_historical_reconstruction(args)
    return {"error": f"Unknown tool: {name}"}

# ---------------------------------------------------------------------------
# Fresh session Q&A — opens new session per question with full context
# This is necessary because the native audio model only responds to
# the FIRST send_client_content turn per session (confirmed by testing)
# ---------------------------------------------------------------------------
async def answer_question_fresh_session(
    user_question: str,
    current_landmark: dict,
    conversation_history: list,
    websocket: WebSocket
):
    """Open a fresh Live session to answer one question with full context."""

    # Build context-rich prompt with landmark + conversation history
    context_parts = []

    if current_landmark["location"]:
        context_parts.append(
            f"We are discussing {current_landmark['location']} "
            f"from {current_landmark['era']}."
        )

    # Include last 3 exchanges for continuity
    if conversation_history:
        context_parts.append("Previous conversation:")
        for entry in conversation_history[-3:]:
            context_parts.append(f"User: {entry['q']}")
            context_parts.append(f"You said: {entry['a']}")

    context_parts.append(f"User's question: {user_question}")
    full_prompt = " ".join(context_parts)

    config = types.LiveConnectConfig(
        system_instruction=types.Content(
            role="user",
            parts=[types.Part(text=QA_SYSTEM_PROMPT)]
        ),
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Puck")
            )
        ),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )

    answer_text = []

    try:
        async with client.aio.live.connect(model=AUDIO_MODEL, config=config) as q_session:
            print(f"[qa] Fresh session: {user_question[:60]}")
            await q_session.send_client_content(
                turns=[types.Content(
                    role="user",
                    parts=[types.Part(text=full_prompt)]
                )],
                turn_complete=True
            )

            async for response in q_session.receive():
                if response.data:
                    await websocket.send_bytes(response.data)

                if hasattr(response, 'server_content') and response.server_content:
                    sc = response.server_content

                    if hasattr(sc, 'output_transcription') and sc.output_transcription:
                        raw = getattr(sc.output_transcription, 'text', '') or ''
                        if raw:
                            answer_text.append(raw)
                            await websocket.send_json({
                                "type": "text", "content": raw + " "
                            })

                    if getattr(sc, 'turn_complete', False):
                        await websocket.send_json({"type": "turn_complete"})
                        break

        print(f"[qa] Done")
        return " ".join(answer_text)

    except Exception as e:
        print(f"[qa] Error: {type(e).__name__}: {e}")
        return ""

# ---------------------------------------------------------------------------
# Vision analyser
# ---------------------------------------------------------------------------
async def analyse_frame_and_reconstruct(
    video_bytes: bytes,
    live_session,
    websocket: WebSocket,
    frame_gate: dict,
    landmark_found: dict,
    current_landmark: dict,
):
    try:
        print("[vision] Analysing frame...")
        response = vision_client.models.generate_content(
            model=VISION_MODEL,
            contents=[
                types.Content(parts=[
                    types.Part(inline_data=types.Blob(
                        mime_type="image/jpeg", data=video_bytes
                    )),
                    types.Part(text=(
                        "Look at this image. If you see ANY architectural landmark, "
                        "call trigger_historical_reconstruction. "
                        "If no landmark visible: NO_LANDMARK"
                    ))
                ])
            ],
            config=types.GenerateContentConfig(
                system_instruction=VISION_SYSTEM_PROMPT,
                tools=TOOLS,
                temperature=0.1,
            )
        )

        if not response.candidates:
            return

        for part in response.candidates[0].content.parts:
            if hasattr(part, 'function_call') and part.function_call:
                fc = part.function_call
                print(f"[vision] Tool call: {fc.name} | {fc.args}")

                frame_gate["active"]    = False
                landmark_found["value"] = True

                location  = fc.args.get("location_name", "this landmark")
                era       = fc.args.get("target_era", "a past era")
                music_tag = get_music_tag(location)

                current_landmark["location"] = location
                current_landmark["era"]      = era

                await websocket.send_json({
                    "type": "tool_start", "tool": fc.name, "args": dict(fc.args)
                })

                result = await dispatch_tool(fc.name, dict(fc.args))
                print(f"[vision] Image: {'YES' if result.get('image_b64') else 'NO'}")

                await asyncio.sleep(0.3)

                # Narrate using fresh session (same pattern as Q&A)
                narration_prompt = (
                    f"LANDMARK IDENTIFIED: {location} ({era}). "
                    f"Give exactly 2 warm enthusiastic sentences about it, "
                    f"then ask 1 interesting question. Max 300 characters."
                )
                asyncio.create_task(
                    answer_question_fresh_session(
                        narration_prompt,
                        {"location": None, "era": None},  # No extra context needed
                        [],
                        websocket
                    )
                )

                # Generate fact card
                facts_data = {"facts": [], "tagline": ""}
                try:
                    fact_resp = vision_client.models.generate_content(
                        model=VISION_MODEL,
                        contents=[types.Content(parts=[types.Part(text=(
                            f'3 fascinating one-line facts about {location} in {era}. '
                            f'JSON only: {{"facts":["f1","f2","f3"],"tagline":"6-word tagline"}}'
                        ))])],
                        config=types.GenerateContentConfig(temperature=0.7)
                    )
                    raw = re.sub(r'```json|```', '', fact_resp.text or '').strip()
                    facts_data = json.loads(raw)
                except Exception:
                    pass

                # Send image to frontend
                if isinstance(result, dict) and result.get("image_b64"):
                    await websocket.send_json({
                        "type":      "image",
                        "image_b64": result["image_b64"],
                        "era":       result.get("era", ""),
                        "location":  result.get("location", ""),
                        "music_tag": music_tag,
                        "facts":     facts_data.get("facts", []),
                        "tagline":   facts_data.get("tagline", ""),
                    })
                return

        text_parts = [
            p.text for p in response.candidates[0].content.parts
            if hasattr(p, 'text') and p.text
        ]
        if "NO_LANDMARK" not in " ".join(text_parts):
            print(f"[vision] No tool call: {' '.join(text_parts)[:80]}")

    except Exception as e:
        print(f"[vision] Error: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()

# ---------------------------------------------------------------------------
# Main WebSocket session
# ---------------------------------------------------------------------------
async def run_live_session(websocket: WebSocket, retry_count: int = 0):

    frame_gate          = {"active": True}
    last_frame_t        = {"t": 0.0}
    landmark_found      = {"value": False}
    current_landmark    = {"location": None, "era": None}
    conversation_history = []  # list of {"q": question, "a": answer}
    qa_lock             = asyncio.Lock()  # prevent overlapping Q&A sessions

    try:
        # Main session — just keeps the connection alive for video frame analysis
        # Text Q&A handled by fresh sessions in answer_question_fresh_session
        print(f"[live] Main session started (attempt {retry_count + 1})")

        async def send_to_gemini():
            try:
                while True:
                    message = await websocket.receive_json()
                    m_type = message.get("type")

                    if m_type == "audio":
                        # Audio handled by Q&A fresh sessions — ignore here
                        pass

                    elif m_type == "audio_end":
                        pass

                    elif m_type == "video":
                        if not frame_gate["active"]:
                            continue
                        now = asyncio.get_event_loop().time()
                        if now - last_frame_t["t"] < 5.0:
                            continue
                        last_frame_t["t"] = now
                        video_bytes = base64.b64decode(message["data"])
                        print(f"[video] → vision ({len(video_bytes)} bytes)")
                        asyncio.create_task(
                            analyse_frame_and_reconstruct(
                                video_bytes, None, websocket,
                                frame_gate, landmark_found,
                                current_landmark
                            )
                        )

                    elif m_type == "text":
                        user_text = message["data"]
                        print(f"[text] User: {user_text[:80]}")

                        # Fire Q&A in background — non-blocking
                        async def handle_qa():
                            async with qa_lock:
                                answer = await answer_question_fresh_session(
                                    user_text,
                                    current_landmark,
                                    conversation_history,
                                    websocket
                                )
                                if answer:
                                    conversation_history.append({
                                        "q": user_text,
                                        "a": answer[:200]
                                    })
                                    # Keep history manageable
                                    if len(conversation_history) > 10:
                                        conversation_history.pop(0)

                        asyncio.create_task(handle_qa())

                    elif m_type == "reset_context":
                        print("[live] Rescan.")
                        frame_gate["active"]         = True
                        landmark_found["value"]      = False
                        last_frame_t["t"]            = 0.0
                        current_landmark["location"] = None
                        current_landmark["era"]      = None
                        conversation_history.clear()
                        await websocket.send_json({
                            "type": "status",
                            "content": "Scanning for a new landmark!"
                        })

                    elif m_type == "camera_off":
                        print("[live] Camera off.")
                        frame_gate["active"] = False
                        await websocket.send_json({
                            "type": "status",
                            "content": "Camera off. Ready when you are!"
                        })

            except WebSocketDisconnect:
                print("[ws:live] Client disconnected.")
            except Exception as e:
                print(f"[ws:live] Send error: {e}")

        await send_to_gemini()

    except Exception as e:
        error_str = str(e)
        if ("1011" in error_str or "503" in error_str) and retry_count < 3:
            wait = 2 ** retry_count
            print(f"[live] Retrying in {wait}s...")
            await asyncio.sleep(wait)
            await run_live_session(websocket, retry_count + 1)
        else:
            print(f"[live] Fatal: {e}")
            try:
                await websocket.send_json({"type": "error", "content": str(e)})
            except Exception:
                pass

# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------
@app.websocket("/ws/live")
async def live_stream_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("[ws:live] Frontend connected.")
    try:
        await run_live_session(websocket)
    finally:
        from starlette.websockets import WebSocketState
        try:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close()
        except Exception:
            pass

@app.get("/health")
async def health():
    return {"status": "ok", "mode": "live_api_hybrid"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)