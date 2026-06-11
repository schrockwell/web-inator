"use strict";

const TARGET_RATE = 22050;       // Hz — ROM-inator startup sound format
const MAX_SECONDS = 0.66;        // default startup sound length
const TARGET_SAMPLES = Math.round(TARGET_RATE * MAX_SECONDS); // 14553 bytes out

document.addEventListener("DOMContentLoaded", () => {
  // --- DOM ---
  const fileEl = document.getElementById("file");
  const playEl = document.getElementById("play");
  const downloadEl = document.getElementById("download");
  const startEl = document.getElementById("start");
  const startValEl = document.getElementById("startval");
  const statusEl = document.getElementById("status");
  const waveEl = document.getElementById("wave");
  const wctx = waveEl.getContext("2d");

  // --- state ---
  let monoData = null;   // Float32Array, full clip mixed to mono @ TARGET_RATE
  let durationSec = 0;
  let startSec = 0;      // start of the 0.66s window within the clip
  let audioCtx = null;   // created lazily on first play (needs user gesture)
  let playingSource = null;
  let scrubbing = false;

  const css = getComputedStyle(document.documentElement);
  const COL_WAVE = (css.getPropertyValue("--accent").trim()) || "#4f9cff";

  function setStatus(msg, warn) {
    statusEl.textContent = msg;
    statusEl.className = "status" + (warn ? " warn" : "");
  }

  // Decode any common audio file, resample to 22050 Hz, mix down to mono.
  // Native decode (preserves quality) + offline render at the target rate.
  async function decodeToMono(arrayBuffer) {
    const tmp = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      decoded = await tmp.decodeAudioData(arrayBuffer);
    } finally {
      tmp.close();
    }
    const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
    const off = new OfflineAudioContext(1, frames, TARGET_RATE); // 1 ch => mono downmix
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return rendered.getChannelData(0).slice();
  }

  // Take the 0.66s window from startSec, padding past the clip end with silence (0.0).
  function buildWindowFloat() {
    const out = new Float32Array(TARGET_SAMPLES); // zero-filled = silence
    const start = Math.round(startSec * TARGET_RATE);
    const n = Math.min(TARGET_SAMPLES, monoData.length - start);
    for (let i = 0; i < n; i++) out[i] = monoData[start + i];
    return out;
  }

  // Float [-1,1] -> 8-bit unsigned [0,255]; silence (0.0) -> 128.
  function floatTo8bit(f) {
    const b = new Uint8Array(f.length);
    for (let i = 0; i < f.length; i++) {
      let v = f[i];
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      b[i] = Math.round((v + 1) * 127.5);
    }
    return b;
  }

  // --- waveform rendering ---
  function fitCanvas() {
    const w = Math.max(320, Math.floor(waveEl.clientWidth));
    if (waveEl.width !== w) waveEl.width = w;
    drawWave();
  }

  function drawWave() {
    const W = waveEl.width, H = waveEl.height, mid = H / 2;
    wctx.clearRect(0, 0, W, H);
    wctx.fillStyle = "#1a1a1e";
    wctx.fillRect(0, 0, W, H);

    if (!monoData || durationSec <= 0) return;

    // highlighted 0.66s window
    const x0 = Math.max(0, (startSec / durationSec) * W);
    const x1 = Math.min(W, ((startSec + MAX_SECONDS) / durationSec) * W);
    wctx.fillStyle = "rgba(79,156,255,0.15)";
    wctx.fillRect(x0, 0, x1 - x0, H);
    wctx.strokeStyle = "rgba(79,156,255,0.6)";
    wctx.beginPath();
    wctx.moveTo(x0 + 0.5, 0); wctx.lineTo(x0 + 0.5, H);
    wctx.moveTo(x1 - 0.5, 0); wctx.lineTo(x1 - 0.5, H);
    wctx.stroke();

    // center line
    wctx.strokeStyle = "rgba(255,255,255,0.08)";
    wctx.beginPath(); wctx.moveTo(0, mid + 0.5); wctx.lineTo(W, mid + 0.5); wctx.stroke();

    // min/max peaks per column
    const N = monoData.length;
    wctx.strokeStyle = COL_WAVE;
    wctx.beginPath();
    for (let x = 0; x < W; x++) {
      const s0 = Math.floor(x / W * N);
      const s1 = Math.max(s0 + 1, Math.floor((x + 1) / W * N));
      let min = 1, max = -1;
      for (let i = s0; i < s1 && i < N; i++) {
        const v = monoData[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      wctx.moveTo(x + 0.5, mid - max * mid);
      wctx.lineTo(x + 0.5, mid - min * mid);
    }
    wctx.stroke();
  }

  function syncStart(sec) {
    const maxStart = Math.max(0, durationSec - MAX_SECONDS);
    startSec = Math.max(0, Math.min(maxStart, sec));
    startEl.value = startSec.toFixed(3);
    startValEl.textContent = startSec.toFixed(3) + "s";
    drawWave();
  }

  function setStartFromX(clientX) {
    const rect = waveEl.getBoundingClientRect();
    syncStart(((clientX - rect.left) / rect.width) * durationSec);
  }

  // Decode an audio file's bytes and load it into the editor.
  async function loadAudio(arrayBuffer, name) {
    setStatus(`Decoding ${name}…`, false);
    playEl.disabled = downloadEl.disabled = true;
    try {
      monoData = await decodeToMono(arrayBuffer);
      durationSec = monoData.length / TARGET_RATE;
      const maxStart = Math.max(0, durationSec - MAX_SECONDS);
      startEl.max = maxStart.toFixed(3);
      startEl.disabled = maxStart <= 0;
      syncStart(0);
      playEl.disabled = downloadEl.disabled = false;
      fitCanvas();
      if (durationSec < MAX_SECONDS) {
        setStatus(`Loaded "${name}" — ${durationSec.toFixed(2)}s, shorter than ${MAX_SECONDS}s, so it will be padded with silence.`, false);
      } else {
        setStatus(`Loaded "${name}" — ${durationSec.toFixed(2)}s. Drag the waveform or slider to pick the ${MAX_SECONDS}s window.`, false);
      }
    } catch (err) {
      monoData = null;
      setStatus(`Couldn't decode "${name}": ${err.message || err}`, true);
    }
  }

  // --- events ---
  fileEl.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    await loadAudio(await f.arrayBuffer(), f.name);
    e.target.value = ""; // allow re-loading the same file
  });

  startEl.addEventListener("input", () => syncStart(parseFloat(startEl.value) || 0));

  waveEl.addEventListener("mousedown", (e) => {
    if (!monoData) return;
    scrubbing = true;
    setStartFromX(e.clientX);
  });
  window.addEventListener("mousemove", (e) => { if (scrubbing) setStartFromX(e.clientX); });
  window.addEventListener("mouseup", () => { scrubbing = false; });

  playEl.addEventListener("click", async () => {
    if (!monoData) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    if (playingSource) { try { playingSource.stop(); } catch (_) { } }

    // play the actual 8-bit result so the preview matches the exported fidelity
    const bytes = floatTo8bit(buildWindowFloat());
    const buf = audioCtx.createBuffer(1, TARGET_SAMPLES, TARGET_RATE);
    const ch0 = buf.getChannelData(0);
    for (let i = 0; i < TARGET_SAMPLES; i++) ch0[i] = (bytes[i] - 128) / 127.5;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start();
    playingSource = src;
  });

  downloadEl.addEventListener("click", () => {
    if (!monoData) return;
    const bytes = floatTo8bit(buildWindowFloat());
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "startup-sound.bin";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Exported startup-sound.bin — ${bytes.length} bytes, raw ${TARGET_RATE} Hz 8-bit unsigned mono.`, false);
  });

  // --- sample gallery (buttons declared in the page, paths in data-file) ---
  const galleryEl = document.getElementById("samples");
  if (galleryEl) {
    galleryEl.addEventListener("click", async (e) => {
      const btn = e.target.closest(".sample");
      if (!btn || !btn.dataset.file) return;
      const file = btn.dataset.file;
      const name = (btn.querySelector(".sample-name")?.textContent || file).trim();
      setStatus(`Fetching ${name}…`, false);
      try {
        const res = await fetch(file);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadAudio(await res.arrayBuffer(), name);
      } catch (err) {
        setStatus(`Couldn't load "${name}": ${err.message || err}`, true);
      }
    });
  }

  window.addEventListener("resize", fitCanvas);
  fitCanvas();
});
