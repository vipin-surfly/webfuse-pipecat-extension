// Voice widget for the Webfuse session popup. Runs in the participant's
// browser (extensions origin): real mic, real speakers. Audio is raw Int16
// PCM @16 kHz over a WebSocket — same wire protocol as client/index.html.

const status = document.getElementById("status");
const button = document.getElementById("mic");

const setStatus = (text, live = false) =>
  (status.innerHTML = (live ? '<span class="dot"></span>' : "") + text);

const FALLBACK_WS_URL = "wss://c606-95-97-8-146.ngrok-free.app";

// The bot URL is configured in the extension manifest's env; fall back to the
// hardcoded value if it can't be read.
async function resolveBotUrl() {
  try {
    let env = globalThis.browser?.webfuseSession?.env;
    if (typeof env === "function") env = await env();
    if (env && typeof env.then === "function") env = await env;
    const value = env?.BOT_WS_URL ?? (typeof env?.get === "function" ? env.get("BOT_WS_URL") : null);
    if (value) return value;
  } catch (_) { /* fall through */ }
  return FALLBACK_WS_URL;
}

button.addEventListener("click", async () => {
  button.disabled = true;
  try {
    await start();
  } catch (err) {
    setStatus("Error: " + err.message);
    button.disabled = false;
  }
});

async function start() {
  const url = await resolveBotUrl();

  // One AudioContext at 16 kHz: the mic is resampled on capture and bot
  // audio (Int16 PCM @16 kHz) plays back natively — no resampling anywhere.
  const ctx = new AudioContext({ sampleRate: 16000 });

  setStatus("Requesting microphone…");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  await ctx.audioWorklet.addModule("pcm-worklet.js");
  const source = ctx.createMediaStreamSource(stream);
  const sender = new AudioWorkletNode(ctx, "pcm-sender");
  const receiver = new AudioWorkletNode(ctx, "pcm-receiver");
  source.connect(sender);
  receiver.connect(ctx.destination);

  setStatus("Connecting…");
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  // mic -> bot
  sender.port.onmessage = (e) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
  };
  // bot -> speaker
  ws.onmessage = (e) => receiver.port.postMessage(e.data);

  ws.onopen = async () => {
    setStatus("Connected — just talk", true);
    // Inbound binding: tell the bot which session this popup lives in, so it
    // drives the very page the user is looking at.
    try {
      const info = await globalThis.browser?.webfuseSession?.getSessionInfo?.();
      if (info) {
        ws.send(
          JSON.stringify({
            type: "bind",
            session_id: info.session_id ?? info.id ?? info.sessionId ?? info.sid,
            info,
          })
        );
      }
    } catch (_) { /* bot falls back to creating a session */ }
  };
  ws.onclose = () => setStatus("Disconnected — reopen this popup to reconnect");
  ws.onerror = () => setStatus("Connection error — is the bot running?");
}
