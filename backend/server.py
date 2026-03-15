from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from agent import HistoricalReconstructor
import uvicorn
import asyncio
import json

app = FastAPI(title="Chronos Lens Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

chronos = HistoricalReconstructor()

@app.websocket("/stream")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("WebSocket connected.")
    
    # We send an initial welcome/clear message to frontend
    await websocket.send_json({"clear": True, "text": "Chronos Link Established. Initiating Live Relay...\n\n"})
    
    try:
        # Start background tasks for concurrent duplex streaming
        receive_task = asyncio.create_task(receive_frames(websocket))
        agent_task = asyncio.create_task(chronos.start_session(websocket))
        
        done, pending = await asyncio.wait(
            [receive_task, agent_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
    except Exception as e:
        print(f"WebSocket Error: {e}")
    finally:
        print("WebSocket disconnected.")

async def receive_frames(websocket: WebSocket):
    while True:
        data = await websocket.receive_text()
        message = json.loads(data)
        if message.get("action") == "video_frame":
            frame_data = message.get("data")
            await chronos.enqueue_frame(frame_data)
        elif message.get("action") == "manual_override":
            loc_command = message.get("location")
            if loc_command:
                await chronos.trigger_live_interruption(websocket, loc_command)

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
