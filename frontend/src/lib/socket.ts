/**
 * socket.ts — Chrono Lens WebSocket client
 *
 * Handles connection to the FastAPI bidi-streaming backend at
 * ws://localhost:8000/stream.
 *
 * Features:
 *  - Typed onMessage callback with parsed ServerMessage union
 *  - onStatusChange callback for "connected" | "disconnected" | "reconnecting"
 *  - Auto-reconnect with exponential backoff (up to 5 retries)
 */

export type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

/** Union of every message type the backend can send */
export type ServerMessage =
    | { type: "status"; content: string; maps_api_key?: string }
    | { type: "text"; content: string }
    | { type: "image"; image_b64: string; era: string; location: string; prompt: string }
    | { type: "grounding"; content: { rendered_content?: string; sources?: { title: string; uri: string }[] } }
    | { type: "tool_start"; tool: string; args: Record<string, unknown> }
    | { type: "tool_error"; tool: string; message: string }
    | { type: "error"; content: string };

type MessageHandler = (msg: ServerMessage) => void;
type StatusHandler = (status: ConnectionStatus) => void;
type BinaryHandler = (buffer: ArrayBuffer) => void;

const WS_URL = "wss://chrono-lens-backend-434492372587.us-central1.run.app/ws/live";
const MAX_RETRIES = 1;
const BASE_RETRY_MS = 8000;

export class WebSocketClient {
    private socket: WebSocket | null = null;
    private url: string;
    private onMessage: MessageHandler;
    private onStatus: StatusHandler;
    private onBinaryMessage: BinaryHandler;
    private retries = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private intentionalClose = false;
    /** Set to true when onerror fires so onclose can apply an error-backoff penalty. */
    private lastCloseWasError = false;

    constructor(
        url: string = WS_URL,
        onMessage: MessageHandler = () => { },
        onStatus: StatusHandler = () => { },
        onBinaryMessage: BinaryHandler = () => { },
    ) {
        this.url = url;
        this.onMessage = onMessage;
        this.onStatus = onStatus;
        this.onBinaryMessage = onBinaryMessage;
    }

    connect() {
        this.intentionalClose = false;
        this._open();
    }

    private _open() {
        if (this.socket) {
            try { this.socket.close(); } catch (_) { }
        }

        this.socket = new window.WebSocket(this.url);

        this.socket.onopen = () => {
            console.log("[ws] Connected to Chrono Lens backend.");
            this.retries = 0;
            this.onStatus("connected");
        };

        this.socket.onmessage = (event: MessageEvent) => {
            // Binary = raw PCM audio from Gemini Live API
            if (event.data instanceof Blob) {
                event.data.arrayBuffer().then(buf => this.onBinaryMessage(buf));
                return;
            }
            if (event.data instanceof ArrayBuffer) {
                this.onBinaryMessage(event.data);
                return;
            }
            // Text = JSON message
            try {
                const text = event.data as string;
                if (!text.trim().startsWith('{')) {
                    console.warn("[ws] Non-JSON payload, skipping:", text);
                    return;
                }
                const parsed: ServerMessage = JSON.parse(text);
                this.onMessage(parsed);
            } catch (err) {
                console.error("[ws] Failed to parse server message:", err, event.data);
            }
        };

        this.socket.onerror = (err) => {
            console.error("[ws] Chronos Link Interrupted - Checking Backend...", err);
            // Mark that the upcoming onclose event was triggered by an error
            // so we can apply a longer initial backoff and avoid a rapid death-loop.
            this.lastCloseWasError = true;
        };

        this.socket.onclose = (event: CloseEvent) => {
            const wasError = this.lastCloseWasError;
            this.lastCloseWasError = false; // reset for next cycle

            if (this.intentionalClose) {
                console.log("[ws] Intentionally closed.");
                this.onStatus("disconnected");
                return;
            }

            if (this.retries < MAX_RETRIES) {
                const baseDelay = BASE_RETRY_MS * Math.pow(1.8, this.retries);
                // If the close was caused by a server-side error (e.g. 1008 model error),
                // enforce a minimum 5-second pause before retrying to prevent hammering
                // the backend and compounding the error stream.
                const delay = wasError ? Math.max(baseDelay, 5000) : baseDelay;
                this.retries++;
                console.warn(
                    `[ws] ${wasError ? 'Error-close' : 'Close'} — reconnecting in ${Math.round(delay)}ms` +
                    ` (attempt ${this.retries}/${MAX_RETRIES}, code=${event.code})`
                );
                this.onStatus("reconnecting");
                this.retryTimer = setTimeout(() => this._open(), delay);
            } else {
                console.error("[ws] Max reconnect attempts reached.");
                this.onStatus("disconnected");
            }
        };
    }

    send(data: string | ArrayBuffer) {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(data);
        } else {
            console.warn("[ws] send() called but socket not open.");
        }
    }

    getReadyState() {
        return this.socket?.readyState;
    }

    disconnect() {
        this.intentionalClose = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.socket?.close();
        this.socket = null;
        this.onStatus("disconnected");
    }
}
