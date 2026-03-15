"use client";

import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Camera, VideoOff, MapPin, Wifi, WifiOff, Loader2, Clock, Volume2, VolumeX, Mic, Share2, Download, Image as ImageIcon, X, Trash2, History } from 'lucide-react';
import { WebSocketClient, ServerMessage, ConnectionStatus } from '@/lib/socket';
import { get, set } from 'idb-keyval';
import { useAudioStream } from '@/hooks/useAudioStream';

// ─── Types ────────────────────────────────────────────────────────────────────
interface TemporalImage {
    url: string;
    era: string;
    location: string;
    facts?: string[];
    tagline?: string;
}

interface Monument {
    id: string;
    name: string;
    era: string;
    description: string;
    imageUrl: string;
    timestamp: number;
    facts?: string[];
    tagline?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const FPS_INTERVAL_MS = 3000; // 1 frame every 3 seconds — cost-efficient for vision

// ─── Status Indicator ─────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: ConnectionStatus }) {
    const config = {
        connected: { icon: Wifi, label: "Link Established", dot: "bg-emerald-400", text: "text-emerald-300", border: "border-emerald-900/50", bg: "bg-emerald-950/40" },
        reconnecting: { icon: Loader2, label: "Reconnecting to Chronos…", dot: "bg-amber-400 animate-spin", text: "text-amber-300", border: "border-amber-900/50", bg: "bg-amber-950/40" },
        disconnected: { icon: WifiOff, label: "Chronos Offline", dot: "bg-red-500", text: "text-red-400", border: "border-red-900/50", bg: "bg-red-950/40" },
    }[status];

    const Icon = config.icon;

    return (
        <motion.div
            key={status}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-full border ${config.bg} ${config.border} backdrop-blur-md shadow-lg`}
        >
            <Icon size={14} className={config.text} />
            <span className={`text-xs font-bold tracking-widest uppercase ${config.text}`}>{config.label}</span>
            {status !== "reconnecting" && (
                <span className={`w-1.5 h-1.5 rounded-full ${config.dot} animate-pulse`} />
            )}
        </motion.div>
    );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function CameraStream() {
    // Refs
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const wsClient = useRef<WebSocketClient | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const frameInterval = useRef<ReturnType<typeof setInterval> | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const musicFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // State
    const [isStreaming, setIsStreaming] = useState(false);
    const [wsStatus, setWsStatus] = useState<ConnectionStatus>("disconnected");
    const [narrative, setNarrative] = useState<string>('');
    const [temporalImage, setTemporalImage] = useState<TemporalImage | null>(null);
    const [isToolActive, setIsToolActive] = useState(false);
    const [activeToolName, setActiveToolName] = useState<string>('');
    const [groundingSources, setGroundingSources] = useState<{ title: string; uri: string }[]>([]);
    const [voiceEnabled, setVoiceEnabled] = useState(true);
    const [activeEra, setActiveEra] = useState("1940S_BOMBAY");
    const [sttMode, setSttMode] = useState<'continuous' | 'manual'>('manual');
    const [isListening, setIsListening] = useState(false);
    const [visitedMonuments, setVisitedMonuments] = useState<Monument[]>([]);
    const isFramePausedRef = useRef(false);

    // ── Persistence: Load Chronos Vault via IndexedDB ──────────────────────
    useEffect(() => {
        const loadVault = async () => {
            try {
                const saved = await get('chrono_vault_idb');
                if (saved) {
                    setVisitedMonuments(saved);
                }
            } catch (e) {
                console.error("Failed to load IndexedDB vault", e);
            }
        };
        loadVault();
    }, []);

    // Helper to add monument to vault
    const addToVault = useCallback(async (monument: Monument) => {
        setVisitedMonuments(prev => {
            const newList = [monument, ...prev];
            set('chrono_vault_idb', newList).catch(e => console.error("IDB save error:", e));
            return newList;
        });
    }, []);

    const deleteFromVault = useCallback(async (id: string) => {
        setVisitedMonuments(prev => {
            const newList = prev.filter(m => m.id !== id);
            set('chrono_vault_idb', newList).catch(e => console.error("IDB delete error:", e));
            return newList;
        });
    }, []);

    const [isGalleryOpen, setIsGalleryOpen] = useState(false);
    const narrativeRef = useRef('');
    const userTextBufferRef = useRef('');
    const userTextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hasSentBargeInRef = useRef<boolean>(false);
    const isPlayingRef = useRef(false);

    const clearText = () => {
        setNarrative('');
        narrativeRef.current = '';
    };

    // ── Native Audio Stream (Gemini Live) ──────────────────────────────────
    const { startCapture, stopCapture, playAudioChunk, stopPlayback, clearPlaybackQueue } = useAudioStream((base64Audio) => {
        // Only send PCM audio in continuous mode
        // In tap/manual mode we use browser STT → text instead
        if (sttMode === 'continuous' && wsClient.current?.getReadyState() === WebSocket.OPEN && !isPlayingRef.current) {
            wsClient.current.send(JSON.stringify({ type: "audio", data: base64Audio }));
        }
    });

    // ── Share & Download ───────────────────────────────────────────────────────
    const handleShareChronos = async () => {
        if (!temporalImage) return;
        const description = narrativeRef.current || `A glimpse into ${temporalImage.location} during the ${temporalImage.era}.`;

        if (navigator.share) {
            try {
                const res = await fetch(temporalImage.url);
                const blob = await res.blob();
                const file = new File([blob], `${temporalImage.location.replace(/ /g, '_')}_${temporalImage.era}.jpg`, { type: 'image/jpeg' });
                await navigator.share({
                    title: `Chrono Lens: ${temporalImage.location}`,
                    text: `I just reconstructed ${temporalImage.location} in the era of ${temporalImage.era} using Chrono Lens!\n\n${description}`,
                    files: [file],
                });
                return;
            } catch (err) {
                console.error("Web Share failed or aborted, falling back to download", err);
            }
        }

        // Fallback: Download with watermark
        const canvas = document.createElement('canvas');
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = temporalImage.url;
        img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.drawImage(img, 0, 0);

            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.font = 'bold 36px sans-serif';
            ctx.textAlign = 'right';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 10;
            ctx.shadowOffsetX = 2;
            ctx.shadowOffsetY = 2;
            ctx.fillText('Chrono Lens', canvas.width - 40, canvas.height - 40);

            const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = `ChronoLens_${temporalImage.location.replace(/ /g, '_')}.jpg`;
            a.click();
        };
    };

    // ── WebSocket message handler ──────────────────────────────────────────────
    const handleMessage = useCallback((msg: any) => {
        if (wsClient.current?.getReadyState() !== WebSocket.OPEN) return;

        switch (msg.type) {
            // "audio" case removed — Gemini Live sends raw binary frames,
            // handled by onBinaryMessage in WebSocketClient constructor above

            case "status":
                clearText();
                setTemporalImage(null);
                setIsToolActive(false);
                setGroundingSources([]);
                break;

            case "turn_complete":
                isPlayingRef.current = false;
                narrativeRef.current = narrative;
                break;

            case "interrupted":
                // User interrupted Gemini — stop all queued audio immediately
                isPlayingRef.current = false;
                clearPlaybackQueue();
                break;

            case "user_text":
                // Accumulate chunks and flush after 800ms of silence
                userTextBufferRef.current += ' ' + msg.content;
                if (userTextTimerRef.current) clearTimeout(userTextTimerRef.current);
                userTextTimerRef.current = setTimeout(() => {
                    const full = userTextBufferRef.current.trim();
                    if (full) {
                        setNarrative(prev => {
                            const prefix = prev ? prev + '\n' : '';
                            const n = prefix + `You: ${full}\n`;
                            narrativeRef.current = n;
                            return n;
                        });
                        userTextBufferRef.current = '';
                    }
                }, 800);
                break;

            case "text":
                setNarrative(prev => {
                    const n = prev + (prev && !prev.endsWith(' ') ? ' ' : '') + msg.content;
                    narrativeRef.current = n;
                    return n;
                });
                break;

            case "image":
                isFramePausedRef.current = true; // pause frames — landmark found
                console.log("[frame] Pausing frame send — landmark identified.");
                const newImg = {
                    url: `data:image/jpeg;base64,${msg.image_b64}`,
                    era: msg.era,
                    location: msg.location,
                    facts: msg.facts || [],
                    tagline: msg.tagline || "",
                };
                setTemporalImage(newImg);

                // Construct monument with full history context
                addToVault({
                    id: Math.random().toString(36).substr(2, 9),
                    name: msg.location,
                    era: msg.era,
                    description: narrativeRef.current,
                    imageUrl: newImg.url,
                    timestamp: Date.now(),
                    facts: msg.facts || [],
                    tagline: msg.tagline || "",
                });

                setIsToolActive(false);
                break;

            case "grounding":
                if (msg.content.sources?.length) {
                    setGroundingSources(msg.content.sources);
                }
                break;

            case "tool_start":
                setIsToolActive(true);
                if (msg.tool === "trigger_historical_reconstruction") {
                    setTemporalImage(null);
                    setActiveToolName("Reconstructing Temporal Stream…");
                } else {
                    setActiveToolName(msg.tool);
                }
                break;

            case "tool_error":
            case "error":
                console.error(`[chronos error] ${msg.type}:`, msg);
                setIsToolActive(false);
                break;
        }
    }, [voiceEnabled, playAudioChunk, addToVault]);

    // ── WebSocket setup ────────────────────────────────────────────────────────
    useEffect(() => {
        const client = new WebSocketClient(
            "ws://localhost:8000/ws/live",
            handleMessage,
            setWsStatus,
            (buffer: ArrayBuffer) => {
                if (voiceEnabled) {
                    isPlayingRef.current = true;
                    // Convert ArrayBuffer to base64 for playAudioChunk
                    const bytes = new Uint8Array(buffer);
                    let binary = '';
                    bytes.forEach(b => binary += String.fromCharCode(b));
                    playAudioChunk(btoa(binary));
                }
            }
        );
        wsClient.current = client;
        client.connect();

        return () => {
            client.disconnect();
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(t => t.stop());
            }
            if (frameInterval.current) clearInterval(frameInterval.current);
            stopPlayback();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Frame capture & send ───────────────────────────────────────────────────
    const sendFrame = useCallback(() => {
        if (!videoRef.current || !canvasRef.current || !wsClient.current) return;
        if (wsStatus !== "connected") return;

        const video = videoRef.current;
        const canvas = canvasRef.current;

        // Must have valid dimensions
        if (video.readyState < 2 || video.videoWidth === 0) return;
        if (isFramePausedRef.current) return;

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        // Resize to 640px wide to reduce payload size and API cost
        const scale = Math.min(1, 640 / canvas.width);
        const w = Math.floor(canvas.width * scale);
        const h = Math.floor(canvas.height * scale);
        
        const smallCanvas = document.createElement('canvas');
        smallCanvas.width = w;
        smallCanvas.height = h;
        const smallCtx = smallCanvas.getContext('2d');
        if (!smallCtx) return;
        
        smallCtx.drawImage(canvas, 0, 0, w, h);
        const frameData = smallCanvas.toDataURL('image/jpeg', 0.5);
        const base64Data = frameData.split(',')[1];
        if (!base64Data) return;

        wsClient.current.send(JSON.stringify({
            type: 'video',
            data: base64Data,
        }));
        console.log("[frame] sent, size:", base64Data.length);

    }, [wsStatus]);

    // ── Camera start/stop ──────────────────────────────────────────────────────
    const startStreaming = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                streamRef.current = stream;
                setIsStreaming(true);
                // Initial prompt sent by backend on session open
                frameInterval.current = setInterval(sendFrame, FPS_INTERVAL_MS);

                // Mic starts only when user taps the mic button
            }
        } catch (err) {
            console.error("Camera access denied:", err);
        }
    };

    const stopStreaming = () => {
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        if (frameInterval.current) clearInterval(frameInterval.current);
        frameInterval.current = null;
        setIsStreaming(false);
        setIsListening(false);
        stopCapture();
        stopPlayback();
        isFramePausedRef.current = true;
        wsClient.current?.send(JSON.stringify({ type: "audio_end" }));
        wsClient.current?.send(JSON.stringify({ type: "camera_off" }));
    };

    useEffect(() => {
        if (isStreaming) {
            if (frameInterval.current) clearInterval(frameInterval.current);
            frameInterval.current = setInterval(sendFrame, FPS_INTERVAL_MS);
        }
    }, [sendFrame, isStreaming]);

    // ─── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="flex flex-col lg:flex-row gap-6 w-full max-w-[1600px] mx-auto p-4 lg:p-6 z-10 relative h-full">

            {/* ── Left Column: Live Vision Feed ─────────────────────────────────── */}
            <div className="flex-[1.5] flex flex-col gap-6 h-full">

                {/* Camera viewport */}
                <motion.div
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="w-full rounded-[2.5rem] overflow-hidden shadow-[0_0_80px_rgba(0,0,0,0.8)] border border-amber-900/30 relative bg-stone-950 aspect-[16/9] group"
                >
                    {/* Floating Controls Overlay */}
                    <div className="absolute top-6 left-6 z-[60] flex gap-3 items-center">
                        {isStreaming ? (
                            <button onClick={stopStreaming} className="bg-red-500/20 text-red-400 p-3.5 rounded-full hover:bg-red-500/30 transition-all shadow-lg backdrop-blur-xl border border-red-500/30">
                                <VideoOff size={20} />
                            </button>
                        ) : (
                            <button onClick={startStreaming} className="bg-emerald-500/20 text-emerald-400 p-3.5 rounded-full hover:bg-emerald-500/30 transition-all shadow-lg backdrop-blur-xl border border-emerald-500/30">
                                <Camera size={20} />
                            </button>
                        )}
                        <button
                            onClick={() => {
                                if (voiceEnabled) {
                                    stopCapture();
                                    stopPlayback();
                                } else {
                                    if (isStreaming) startCapture();
                                }
                                setVoiceEnabled(v => !v);
                            }}
                            className={`p-3.5 rounded-full backdrop-blur-xl border transition-all ${voiceEnabled ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-lg' : 'bg-stone-800/60 text-stone-500 border-stone-700/40'
                                }`}
                        >
                            {voiceEnabled ? <Volume2 size={20} /> : <VolumeX size={20} />}
                        </button>
                        <StatusBadge status={wsStatus} />
                    </div>

                    <video
                        ref={videoRef}
                        autoPlay playsInline muted
                        className={`w-full h-full object-cover select-none pointer-events-none transition-opacity duration-700 ${isStreaming ? 'opacity-100' : 'opacity-0 absolute'}`}
                    />

                    {/* Idle state UI */}
                    {!isStreaming && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-stone-900/30">
                            <motion.div
                                animate={{ scale: [1, 1.05, 1], opacity: [0.3, 0.5, 0.3] }}
                                transition={{ duration: 4, repeat: Infinity }}
                                className="w-32 h-32 rounded-full bg-amber-500/5 flex items-center justify-center border border-amber-500/10"
                            >
                                <Camera size={48} className="text-amber-500/20" />
                            </motion.div>
                            <p className="font-light tracking-[0.5em] text-amber-500/40 uppercase text-xs text-center px-8">Initialize Temporal Stream to Begin Analysis</p>
                        </div>
                    )}

                    {/* Reconstruction Overlay */}
                    <AnimatePresence>
                        {temporalImage && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 1.5 }}
                                className="absolute inset-0 z-40 bg-black"
                            >
                                <img src={temporalImage.url} alt="Temporal Reconstruction" className="w-full h-full object-cover brightness-90 sepia-[0.2] saturate-[0.8]" />
                                <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/20 to-transparent pointer-events-none" />

                                {/* Info Badge */}
                                <div className="absolute top-6 right-6 bg-black/60 backdrop-blur-xl px-5 py-2.5 rounded-full border border-amber-500/30 flex items-center gap-3">
                                    <Clock size={14} className="text-amber-400" />
                                    <span className="text-[11px] font-bold tracking-[0.2em] text-amber-200 uppercase">{temporalImage.era}</span>
                                </div>

                                {/* Shared Tools */}
                                <div className="absolute bottom-10 left-10 flex flex-col gap-1">
                                    <p className="text-amber-500/60 text-[10px] tracking-[0.4em] font-medium uppercase">Located Anomaly</p>
                                    <h3 className="text-3xl font-light tracking-tight text-white">{temporalImage.location}</h3>
                                    {temporalImage.tagline && (
                                        <p className="text-amber-400/80 text-sm italic mt-1">{temporalImage.tagline}</p>
                                    )}
                                    {temporalImage.facts && temporalImage.facts.length > 0 && (
                                        <div className="mt-3 flex flex-col gap-1">
                                            {temporalImage.facts.map((fact, i) => (
                                                <p key={i} className="text-white/70 text-xs flex gap-2">
                                                    <span className="text-amber-500">▸</span>{fact}
                                                </p>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div className="absolute bottom-10 right-10 flex gap-3">
                                    <button onClick={handleShareChronos} className="bg-white/10 hover:bg-white/20 text-white p-3 rounded-xl backdrop-blur-xl border border-white/20 transition-all">
                                        <Share2 size={20} />
                                    </button>
                                    <button
                                        onClick={() => {
                                            isFramePausedRef.current = false;
                                            setTemporalImage(null);
                                            console.log("[frame] Resuming frame send — rescanning.");
                                        }}
                                        className="bg-amber-500 text-black px-6 py-3 rounded-xl font-bold text-xs tracking-widest uppercase hover:bg-amber-400 transition-all shadow-xl shadow-amber-900/20"
                                    >
                                        Live Rescan
                                    </button>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Pulse Scanner Effect */}
                    <AnimatePresence>
                        {isToolActive && (
                            <motion.div
                                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                                className="absolute inset-0 z-30 pointer-events-none overflow-hidden"
                            >
                                <motion.div
                                    className="absolute left-0 w-full h-[2px] bg-cyan-400/80 shadow-[0_0_30px_rgba(34,211,238,0.8)]"
                                    initial={{ top: '0%' }} animate={{ top: '100%' }}
                                    transition={{ duration: 2.5, repeat: Infinity, ease: "linear" }}
                                />
                                <div className="absolute inset-0 bg-cyan-950/20 mix-blend-overlay" />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </motion.div>

                {/* Enhanced Mic Control Bar */}
                <div className="relative flex items-center justify-between gap-6 px-10 py-6 rounded-[3rem] bg-stone-950/60 border border-stone-800/50 backdrop-blur-3xl shadow-2xl overflow-hidden group">
                    {/* Background accent */}
                    <div className={`absolute top-0 left-0 w-1 h-full transition-colors duration-500 ${isListening ? 'bg-red-500' : 'bg-amber-500/30'}`} />
                    
                    {/* Left: Spacer (to center the mic) */}
                    <div className="flex-1" />

                    {/* Center: Prominent Circular Mic */}
                    <div className="relative">
                        <AnimatePresence>
                            {isListening && (
                                <>
                                    <motion.div 
                                        initial={{ scale: 0.8, opacity: 0 }}
                                        animate={{ scale: 1.5, opacity: 0 }}
                                        exit={{ scale: 0.8, opacity: 0 }}
                                        transition={{ duration: 1.5, repeat: Infinity, ease: "easeOut" }}
                                        className="absolute inset-0 rounded-full bg-red-500/20"
                                    />
                                    <motion.div 
                                        initial={{ scale: 0.8, opacity: 0 }}
                                        animate={{ scale: 2, opacity: 0 }}
                                        exit={{ scale: 0.8, opacity: 0 }}
                                        transition={{ duration: 1.5, repeat: Infinity, ease: "easeOut", delay: 0.5 }}
                                        className="absolute inset-0 rounded-full bg-red-500/10"
                                    />
                                </>
                            )}
                        </AnimatePresence>
                        
                        <button
                            onClick={() => {
                                if (isListening) {
                                    stopCapture();
                                    setIsListening(false);
                                    wsClient.current?.send(JSON.stringify({ type: "audio_end" }));
                                } else {
                                    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
                                    if (SpeechRecognition) {
                                        const recognition = new SpeechRecognition();
                                        recognition.continuous = false;
                                        recognition.interimResults = false;
                                        recognition.lang = 'en-US';
                                        setIsListening(true);
                                        clearPlaybackQueue(); // stop playback when mic opens
                                        recognition.start();
                                        recognition.onresult = (event: any) => {
                                            const transcript = event.results[0][0].transcript;
                                            console.log("[STT] Transcript:", transcript, "wsReady:", wsClient.current?.getReadyState(), "isPlaying:", isPlayingRef.current);
                                            wsClient.current?.send(JSON.stringify({
                                                type: "text",
                                                data: transcript
                                            }));
                                            setNarrative(prev => {
                                                const updated = prev + `\nYou: ${transcript}\n`;
                                                narrativeRef.current = updated;
                                                return updated;
                                            });
                                        };
                                        recognition.onerror = (e: any) => {
                                            console.error("[STT] Error:", e);
                                            setIsListening(false);
                                        };
                                        recognition.onend = () => {
                                            setIsListening(false);
                                        };
                                    } else {
                                        startCapture();
                                        setIsListening(true);
                                    }
                                }
                            }}
                            className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-500 transform active:scale-90 ${
                                isListening
                                    ? 'bg-red-500 text-white shadow-[0_0_50px_rgba(239,68,68,0.4)]'
                                    : 'bg-stone-900 text-amber-500 border-2 border-amber-500/20 hover:border-amber-500/50 hover:bg-stone-800 shadow-xl'
                            }`}
                        >
                            <Mic size={32} className={isListening ? "animate-pulse" : ""} />
                        </button>
                    </div>

                    {/* Right: Status Text */}
                    <div className="flex-1 text-right">
                        <motion.p 
                            key={isListening ? 'listening' : 'idle'}
                            initial={{ y: 5, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
                            className={`text-xs font-black tracking-[0.3em] uppercase transition-colors ${isListening ? 'text-red-400' : 'text-amber-500/90'}`}
                        >
                            {isListening ? 'System Listening' : 'Historian Awaiting'}
                        </motion.p>
                        <p className="text-[10px] text-stone-500 mt-1 font-medium tracking-wider">
                            {isListening 
                                ? 'Voice activity detected — interrupt freely' 
                                : 'Tap the core to ask a question'}
                        </p>
                    </div>
                </div>

                {/* Middle Section: Narrative Box */}
                <div className="flex-1 glass-panel p-8 rounded-[2.5rem] border border-stone-800/50 bg-stone-900/40 backdrop-blur-2xl shadow-xl prose-invert flex flex-col min-h-[300px]">
                    <div className="flex justify-between items-center mb-6">
                        <div className="flex items-center gap-3">
                            <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shadow-[0_0_10px_rgba(245,158,11,0.5)]" />
                            <h2 className="text-[11px] font-bold text-amber-500/80 tracking-[0.3em] uppercase">Chronos Intelligence</h2>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar pr-4">
                        {narrative ? (
                            <div className="text-stone-200 font-light leading-relaxed text-lg tracking-wide whitespace-pre-wrap">
                                {narrative}
                            </div>
                        ) : (
                            <div className="h-full flex items-center justify-center text-stone-600 italic text-sm font-light tracking-wide text-center px-12">
                                {wsStatus === "connected"
                                    ? "Awaiting temporal signal... Point the lens at an architectural landmark to begin analysis."
                                    : "Chronos system initialized. Establish link to proceed."}
                            </div>
                        )}
                    </div>

                    {groundingSources.length > 0 && (
                        <div className="mt-8 pt-6 border-t border-stone-800/50 overflow-x-auto whitespace-nowrap scrollbar-none">
                            <p className="text-[9px] font-bold text-stone-500 uppercase tracking-[0.2em] mb-4">Temporal Evidence Search</p>
                            <div className="flex gap-2 pb-2">
                                {groundingSources.slice(0, 5).map((s, i) => (
                                    <a key={i} href={s.uri} target="_blank" className="text-[10px] bg-stone-800/50 hover:bg-amber-900/20 px-4 py-2 rounded-lg text-stone-400 hover:text-amber-300 transition-all flex items-center gap-2 border border-stone-800 flex-shrink-0">
                                        <History size={10} /> {s.title || "Context Link"}
                                    </a>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* ── Right Column: Persistent History Gallery (Vault) ─────────────────── */}
            <div className="w-full lg:w-[420px] flex flex-col bg-stone-900/60 backdrop-blur-3xl border border-stone-800/50 rounded-[2.5rem] overflow-hidden shadow-2xl h-full lg:max-h-[85vh]">
                <div className="p-8 border-b border-stone-800/50 flex items-center justify-between bg-black/20">
                    <div className="flex items-center gap-3">
                        <History size={20} className="text-amber-500/70" />
                        <h2 className="text-[12px] font-bold text-stone-300 tracking-[0.3em] uppercase">Chronos Vault</h2>
                    </div>
                    <span className="px-3 py-1 rounded-full bg-stone-800 text-[10px] font-bold text-amber-500 border border-amber-500/20">{visitedMonuments.length}</span>
                </div>

                <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 lg:grid-cols-2 gap-4 custom-scrollbar bg-black/10 auto-rows-max">
                    {visitedMonuments.length === 0 ? (
                        <div className="h-full col-span-2 flex flex-col items-center justify-center text-center p-8">
                            <motion.div
                                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                                className="w-16 h-16 rounded-full bg-stone-800/30 flex items-center justify-center mb-6"
                            >
                                <ImageIcon size={24} className="text-stone-700" />
                            </motion.div>
                            <p className="text-xs text-stone-500 font-light leading-relaxed max-w-[200px]">Successful temporal reconstructions will be archived here in the Indexed Vault.</p>
                        </div>
                    ) : (
                        visitedMonuments.map((m) => (
                            <motion.div
                                key={m.id}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="group flex flex-col rounded-[1.5rem] overflow-hidden border border-stone-800/80 hover:border-amber-500/50 transition-all cursor-pointer bg-stone-900/40 shadow-xl"
                                onClick={() => {
                                    setTemporalImage({ 
                                        url: m.imageUrl, 
                                        era: m.era, 
                                        location: m.name,
                                        facts: m.facts,
                                        tagline: m.tagline
                                    });
                                    setNarrative(m.description);
                                    narrativeRef.current = m.description;
                                }}
                            >
                                {/* Thumbnail Image Container - Robust Aspect Ratio */}
                                <div className="relative w-full pt-[100%] overflow-hidden bg-stone-800/20">
                                    <img 
                                        src={m.imageUrl} 
                                        alt={m.name} 
                                        className="absolute inset-0 w-full h-full object-cover opacity-80 group-hover:opacity-100 group-hover:scale-110 transition-all duration-700" 
                                    />
                                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); deleteFromVault(m.id); }}
                                            className="bg-black/90 p-2 rounded-lg text-red-500 hover:text-white hover:bg-red-600 transition-all border border-red-500/20 shadow-lg"
                                            title="Expunge"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                    <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 to-transparent pointer-events-none" />
                                </div>

                                {/* Thumbnail Info */}
                                <div className="p-3 bg-stone-900/80 border-t border-stone-800/30">
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <div className="w-1 h-1 rounded-full bg-amber-500 animate-pulse" />
                                        <span className="text-[8px] font-black tracking-widest text-amber-500/80 uppercase truncate">{m.era}</span>
                                    </div>
                                    <h4 className="text-stone-200 text-[10px] font-bold tracking-tight truncate">{m.name}</h4>
                                </div>
                            </motion.div>
                        ))
                    )}
                </div>

                {/* Remove mic from vault - now lives below camera */}
            </div>

            <canvas ref={canvasRef} className="hidden" />
        </div>
    );
}
