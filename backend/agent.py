import os
import asyncio
import base64
import json

# Firebase & Firestore for Spatial Memory
import firebase_admin
from firebase_admin import credentials, firestore

try:
    if not firebase_admin._apps:
        # Initialize default app if standard credentials exist (e.g. ADC on Cloud Run)
        # For local dev without creds, this might fail, so we wrap in try/except
        firebase_admin.initialize_app()
    db = firestore.client()
except Exception as e:
    print(f"Firestore initialization skipped (running in local mock without credentials): {e}")
    db = None

try:
    from tools.storyteller import storyteller_tool_schema, execute_storyteller
    from tools.maps_mcp import maps_location_tool_schema
except ImportError:
    storyteller_tool_schema = None
    maps_location_tool_schema = None
    execute_storyteller = None

SYSTEM_PROMPT = """You are the **HistoricalReconstructor**, a global, location-aware real-time multimodal AI agent powered by Gemini 3.1 Live.
Your role is to act as a cinematic historical guide, transporting the user into various eras based on their physical location.

Your capabilities & rules:
1. **Visual Trigger**: Continuously monitor the camera feed. When a landmark is detected, YOU MUST trigger the `identify_location` tool.
2. **Grounding Integration**: Use Gemini 3.1 Grounding with Google Maps to get the exact location and Google Search to identify the most visually distinct historical era for that place.
3. **Output Format**: Every time the location changes, you must output your response EXACTLY in this format combining the search results with the DYNAMIC_DNA_TEMPLATE:
   "Era: [Era Name]. Architecture: [Architecture style]. Atmosphere: [Atmosphere description]. Lighting: [Lighting details]."
   Example: "Era: Belle Époque. Architecture: Haussmann style & ironwork. Atmosphere: Sepia-toned, humid morning. Lighting: Gaslight reflections."
4. **Dynamic Styling**: After outputting the text, use the `storyteller_tool` providing it the `location` and the exact text output you generated as the `historical_context`.
5. **Live Interruption**: If the user says something like "Wait, show me 100 years further back!", acknowledge it immediately, abort your current historical timeline, and pivot to the new requested era.
6. **Spatial Memory**: I am maintaining your memory. Be consistent with previous context unless explicitly tracking a pan/location change.

Maintain an atmospheric, nostalgic, and narrative educational tone.
"""

class MockSession:
    """Mock session for UI verification when GEMINI_API_KEY is missing."""
    async def __aenter__(self):
        return self
    async def __aexit__(self, exc_type, exc, tb):
        pass
    async def send(self, input):
        pass
    
    async def receive(self):
        # Mock receiving text
        class MockPart:
            def __init__(self, text):
                self.text = text
        class MockModelTurn:
            def __init__(self):
                self.parts = [MockPart("Ah, I see you are connecting from the 21st century! Welcome back to 1940s Bombay. According to historical records (Source: Example Heritage Trust), this Art Deco stretch was just completed...")]
        class MockServerContent:
            def __init__(self):
                self.model_turn = MockModelTurn()
        class MockResponse1:
            def __init__(self):
                self.server_content = MockServerContent()
                self.tool_call = None
        
        yield MockResponse1()
        await asyncio.sleep(2)
        
        # Mock invoking the storyteller tool
        class MockFunctionCall:
            def __init__(self):
                self.name = "storyteller_tool"
                self.args = {"location": "Marine Drive, Bombay", "historical_context": "1940s Art Deco movement, newly built promenade."}
        class MockToolCall:
            def __init__(self):
                self.function_calls = [MockFunctionCall()]
        class MockResponse2:
            def __init__(self):
                self.server_content = None
                self.tool_call = MockToolCall()
                
        yield MockResponse2()
        
        while True:
            await asyncio.sleep(10)

class HistoricalReconstructor:
    def __init__(self):
        self._frame_queue = asyncio.Queue()
        self.api_key = os.environ.get("GEMINI_API_KEY")
        self.session_id = "default_session"

        if self.api_key:
            from google import genai
            self.client = genai.Client()
        else:
            self.client = None

    def _save_spatial_memory(self, location: str, context: str):
        if db:
            try:
                doc_ref = db.collection("spatial_memory").document(self.session_id)
                doc_ref.set({
                    "last_location": location,
                    "historical_context": context,
                    "timestamp": firestore.SERVER_TIMESTAMP
                }, merge=True)
                print(f"Saved to Spatial Memory: {location}")
            except Exception as e:
                print(f"Failed to save spatial memory: {e}")

    async def enqueue_frame(self, base64_data: str):
        if self._frame_queue.qsize() > 2:
            try:
                self._frame_queue.get_nowait()
            except asyncio.QueueEmpty: pass
        await self._frame_queue.put(base64_data)

    async def start_session(self, websocket):
        if not self.api_key:
            print("No GEMINI_API_KEY found. Running in MOCK VERIFICATION mode.")
            async with MockSession() as session:
                send_task = asyncio.create_task(self._send_to_gemini(session))
                receive_task = asyncio.create_task(self._receive_from_gemini(session, websocket))
                done, pending = await asyncio.wait([send_task, receive_task], return_when=asyncio.FIRST_COMPLETED)
                for task in pending: task.cancel()
            return

        # Real connection
        try:
            function_declarations = []
            if storyteller_tool_schema: function_declarations.append(storyteller_tool_schema)
            if maps_location_tool_schema: function_declarations.append(maps_location_tool_schema)
            
            # Integrate tools: Custom Tools + Google Search for Global Grounding
            tools = []
            if function_declarations:
                tools.append({"function_declarations": function_declarations})
            tools.append({"google_search": {}}) # Enabled Google Search for Grounding
                
            config = {"system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]}, "tools": tools}
            
            async with self.client.aio.live.connect(model="gemini-3.1-live", config=config) as session:
                print("Established Bidirectional Stream with Gemini 3.1 Live (HistoricalReconstructor).")
                self.active_session = session
                send_task = asyncio.create_task(self._send_to_gemini(session))
                receive_task = asyncio.create_task(self._receive_from_gemini(session, websocket))
                done, pending = await asyncio.wait([send_task, receive_task], return_when=asyncio.FIRST_COMPLETED)
                for task in pending: task.cancel()
        except Exception as e:
            print(f"Gemini Live Connection Error: {e}")

    async def _send_to_gemini(self, session):
        while True:
            base64_frame = await self._frame_queue.get()
            try:
                if self.api_key:
                    frame_bytes = base64.b64decode(base64_frame)
                    await session.send(input={"parts": [{"mime_type": "image/jpeg", "data": frame_bytes}]})
            except Exception as e: print(f"Error sending frame: {e}")

    async def trigger_live_interruption(self, websocket, text_command: str):
        """Implement Live Interruption: Flush output and pivot generation."""
        print(f"Live Interruption Triggered: {text_command}")
        
        # Clear frontend UI immediately
        await websocket.send_json({"clear": True, "text": f"\n\n[TEMPORAL SHIFT DETECTED: {text_command}]\n\n"})
        
        # In the real Gemini Live protocol, we can send a client_content message with `turn_complete=True`
        # or just a user message to prompt the model to pivot instantly. Adhering to SDK patterns:
        if self.api_key and hasattr(self, 'active_session'):
            try:
                # We send the interrupt text command as a user turn
                await self.active_session.send(input={"parts": [{"text": f"INTERRUPT CURRENT GENERATION. User said: '{text_command}'. Pivot instantly to the new era requested."}]})
            except Exception as e:
                print(f"Error sending interrupt to model: {e}")

    async def _receive_from_gemini(self, session, websocket):
        async for response in session.receive():
            try:
                # 1. Text streaming and Grounded Output
                if response.server_content and response.server_content.model_turn:
                    # Check for grounding metadata in the response
                    grounding_sources = ""
                    if hasattr(response.server_content, "grounding_metadata") and response.server_content.grounding_metadata:
                        # Extract basic citation if available
                        meta = response.server_content.grounding_metadata
                        if hasattr(meta, "search_entry_point") and meta.search_entry_point:
                            grounding_sources = f"\n[Source: Google Search used for historical grounding]"

                    for part in response.server_content.model_turn.parts:
                        if part.text: 
                            content = part.text + (grounding_sources if grounding_sources else "")
                            await websocket.send_json({"text": content})
                            grounding_sources = "" # Only append once per turn

                # 2. Tool Calls
                if response.tool_call:
                    for function_call in response.tool_call.function_calls:
                        name = function_call.name
                        args = getattr(function_call, "args", function_call.args if hasattr(function_call, "args") else {})
                        print(f"Model executed tool: {name} with args {args}")
                        
                        if name == "storyteller_tool" and execute_storyteller:
                            # Update Spatial memory when storyteller is triggered for a location
                            loc = args.get("location", "Unknown")
                            ctx = args.get("historical_context", "")
                            self._save_spatial_memory(loc, ctx)

                            image_data = await execute_storyteller(args)
                            if image_data: 
                                await websocket.send_json({"image": image_data})
                            
                            if self.api_key:
                                tool_resp = {"function_responses": [{"name": name, "response": {"result": "Successfully generated overlay."}}]}
                                await session.send(input={"tool_response": tool_resp})
            except Exception as e:
                print(f"Error receiving from model: {e}")
