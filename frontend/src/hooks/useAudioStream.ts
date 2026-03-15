import { useRef, useCallback } from 'react';

/**
 * useAudioStream Hook
 * Handles 16kHz PCM Mic Capture and 24kHz PCM Playback for Gemini Live API.
 */
export function useAudioStream(onAudioData: (base64: string) => void) {
    // Record State
    const audioContext = useRef<AudioContext | null>(null);
    const processor = useRef<ScriptProcessorNode | null>(null);
    const input = useRef<MediaStreamAudioSourceNode | null>(null);
    const stream = useRef<MediaStream | null>(null);

    // Playback State
    const playbackContext = useRef<AudioContext | null>(null);
    const nextStartTime = useRef<number>(0);

    // ─── RECORDING (16kHz PCM) ──────────────────────────────────────────

    const startCapture = useCallback(async () => {
        try {
            if (!audioContext.current) {
                audioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)({
                    sampleRate: 16000, // Request 16kHz directly if supported
                });
            }

            stream.current = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            const ctx = audioContext.current;
            input.current = ctx.createMediaStreamSource(stream.current);

            // Using ScriptProcessor for surgical simplicity in a single file
            // 4096 buffer size at 16k is ~250ms of audio
            processor.current = ctx.createScriptProcessor(4096, 1, 1);

            processor.current.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);

                // Convert Float32 to Int16 (LINEAR16)
                const pcmData = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                // Convert to Base64 and send
                const base64 = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
                onAudioData(base64);
            };

            input.current.connect(processor.current);
            processor.current.connect(ctx.destination);

            if (ctx.state === 'suspended') await ctx.resume();
            console.log("[Audio] Capture started at 16kHz.");
        } catch (err) {
            console.error("[Audio] Capture failed:", err);
        }
    }, [onAudioData]);

    const stopCapture = useCallback(() => {
        processor.current?.disconnect();
        input.current?.disconnect();
        stream.current?.getTracks().forEach(t => t.stop());
        console.log("[Audio] Capture stopped.");
    }, []);

    // ─── PLAYBACK (24kHz PCM) ───────────────────────────────────────────

    const playAudioChunk = useCallback((base64: string) => {
        try {
            if (!playbackContext.current) {
                playbackContext.current = new (window.AudioContext || (window as any).webkitAudioContext)({
                    sampleRate: 24000, // Gemini Live native output rate
                });
            }

            const ctx = playbackContext.current;
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            const pcmData = new Int16Array(bytes.buffer);
            const floatData = new Float32Array(pcmData.length);

            // Convert Int16 back to Float32 for Web Audio API
            for (let i = 0; i < pcmData.length; i++) {
                floatData[i] = pcmData[i] / 0x8000;
            }

            const audioBuffer = ctx.createBuffer(1, floatData.length, 24000);
            audioBuffer.getChannelData(0).set(floatData);

            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);

            // Audio scheduling for gapless playback
            const currentTime = ctx.currentTime;
            if (nextStartTime.current < currentTime) {
                nextStartTime.current = currentTime + 0.05; // Small buffer for initial chunk
            }

            source.start(nextStartTime.current);
            nextStartTime.current += audioBuffer.duration;

        } catch (err) {
            console.error("[Audio] Playback error:", err);
        }
    }, []);

    const stopPlayback = useCallback(() => {
        if (playbackContext.current) {
            // Close and recreate context to immediately kill all queued audio
            playbackContext.current.close();
            playbackContext.current = null;
            nextStartTime.current = 0;
        }
    }, []);

    const clearPlaybackQueue = useCallback(() => {
        // Immediately stop audio without full teardown — for barge-in
        if (playbackContext.current) {
            playbackContext.current.close();
            playbackContext.current = null;
            nextStartTime.current = 0;
            // Recreate context immediately so playback can resume
            playbackContext.current = new (window.AudioContext || (window as any).webkitAudioContext)({
                sampleRate: 24000,
            });
        }
    }, []);

    return { startCapture, stopCapture, playAudioChunk, stopPlayback, clearPlaybackQueue };
}
