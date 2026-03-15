import asyncio
from google import genai
from google.genai import types
import dotenv, os
dotenv.load_dotenv('.env')

client = genai.Client(
    api_key=os.environ['GEMINI_API_KEY'],
    http_options=types.HttpOptions(api_version='v1alpha')
)

async def test():
    config = types.LiveConnectConfig(
        response_modalities=['AUDIO'],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name='Puck')
            )
        ),
    )
    async with client.aio.live.connect(
        model='gemini-2.5-flash-native-audio-preview-12-2025',
        config=config
    ) as session:
        print('SESSION OPEN')

        # Track turn complete
        turn_done = asyncio.Event()
        turn_done.set()

        async def receiver():
            async for response in session.receive():
                if response.data:
                    print(f'AUDIO: {len(response.data)} bytes')
                if hasattr(response, 'server_content') and response.server_content:
                    if getattr(response.server_content, 'turn_complete', False):
                        print('TURN COMPLETE')
                        turn_done.set()

        recv_task = asyncio.create_task(receiver())

        # TURN 1
        print('Sending turn 1...')
        turn_done.clear()
        await session.send_client_content(
            turns=[types.Content(role='user', parts=[types.Part(text='Say: hello world')])],
            turn_complete=True
        )
        await asyncio.wait_for(turn_done.wait(), timeout=10)
        print('Turn 1 done')

        await asyncio.sleep(0.5)

        # TURN 2
        print('Sending turn 2...')
        turn_done.clear()
        await session.send_client_content(
            turns=[types.Content(role='user', parts=[types.Part(text='Say: goodbye world')])],
            turn_complete=True
        )
        await asyncio.wait_for(turn_done.wait(), timeout=10)
        print('Turn 2 done')

        recv_task.cancel()

asyncio.run(test())