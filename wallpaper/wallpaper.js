"use strict";

const SCREEN_W = 512, SCREEN_H = 342; // Mac 128K/512K/Plus/SE/Classic screen
const DOC_W = 576, DOC_H = 720;       // MacPaint documents are always this size
const DOC_ROW_BYTES = DOC_W / 8;
const MAC_EPOCH_OFFSET = 2082844800;  // seconds from 1904-01-01 to 1970-01-01

// BinHex 4.0 character set (64 chars, deliberately skips look-alikes).
const HQX_ALPHABET = "!\"#$%&'()*+,-012345689@ABCDEFGHIJKLMNPQRSTUVXYZ[`abcdefhijklmpqr";

// Standard 8x8 Bayer ordered-dither matrix (values 0..63).
const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

document.addEventListener("DOMContentLoaded", () => {
  // --- DOM ---
  const fileEl = document.getElementById("file");
  const canvasEl = document.getElementById("dither");
  const cardEl = document.getElementById("dither-card");
  const ctx = canvasEl.getContext("2d");
  const algoEl = document.getElementById("algo");
  const invertEl = document.getElementById("invert");
  const zoomEl = document.getElementById("zoom");
  const zoomValEl = document.getElementById("zoomval");
  const brightEl = document.getElementById("brightness");
  const brightValEl = document.getElementById("brightnessval");
  const contrastEl = document.getElementById("contrast");
  const contrastValEl = document.getElementById("contrastval");
  const threshEl = document.getElementById("threshold");
  const threshValEl = document.getElementById("thresholdval");
  const resetEl = document.getElementById("reset");
  const dlHqxEl = document.getElementById("download-hqx");
  const dlBinEl = document.getElementById("download-bin");
  const dlRawEl = document.getElementById("download-raw");
  const statusEl = document.getElementById("status");

  // --- state ---
  let img = null;        // HTMLImageElement
  let imgName = "Wallpaper";
  let cx = 0, cy = 0;    // crop-view center, in source-image coordinates
  let bits = null;       // Uint8Array SCREEN_W*SCREEN_H, 1 = black
  let dragging = false;
  let lastX = 0, lastY = 0;
  let renderQueued = false;

  // offscreen canvas the crop is rendered into before dithering
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = SCREEN_W;
  srcCanvas.height = SCREEN_H;
  const sctx = srcCanvas.getContext("2d", { willReadFrequently: true });

  function setStatus(msg, warn) {
    statusEl.textContent = msg;
    statusEl.className = "status" + (warn ? " warn" : "");
  }

  function setControlsEnabled(on) {
    [algoEl, invertEl, zoomEl, brightEl, contrastEl, threshEl,
      resetEl, dlHqxEl, dlBinEl, dlRawEl].forEach((el) => { el.disabled = !on; });
  }

  // --- crop view (pan + zoom over the source image) ---
  function coverScale() {
    return Math.max(SCREEN_W / img.naturalWidth, SCREEN_H / img.naturalHeight);
  }

  function viewScale() {
    return coverScale() * parseFloat(zoomEl.value);
  }

  function clampView() {
    const s = viewScale();
    const vw = SCREEN_W / s, vh = SCREEN_H / s;
    cx = Math.max(vw / 2, Math.min(img.naturalWidth - vw / 2, cx));
    cy = Math.max(vh / 2, Math.min(img.naturalHeight - vh / 2, cy));
  }

  // --- dithering ---
  // Crop -> grayscale with brightness/contrast applied. Values 0..255.
  function buildGray() {
    const s = viewScale();
    const vw = SCREEN_W / s, vh = SCREEN_H / s;
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(img, cx - vw / 2, cy - vh / 2, vw, vh, 0, 0, SCREEN_W, SCREEN_H);

    const data = sctx.getImageData(0, 0, SCREEN_W, SCREEN_H).data;
    const bright = parseInt(brightEl.value, 10);
    const c = parseInt(contrastEl.value, 10) * 2.55;
    const factor = (259 * (c + 255)) / (255 * (259 - c));
    const invert = invertEl.checked;

    const gray = new Float32Array(SCREEN_W * SCREEN_H);
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4;
      let v = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      v = factor * (v - 128) + 128 + bright;
      if (invert) v = 255 - v;
      gray[i] = v;
    }
    return gray;
  }

  // Error diffusion over gray in place; returns bits (1 = black).
  // taps: [dx, dy, weight] with weights summing to <= 1.
  function diffuse(gray, threshold, taps) {
    const out = new Uint8Array(SCREEN_W * SCREEN_H);
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        const i = y * SCREEN_W + x;
        const old = gray[i];
        const black = old < threshold;
        out[i] = black ? 1 : 0;
        const err = old - (black ? 0 : 255);
        for (const [dx, dy, w] of taps) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < SCREEN_W && ny < SCREEN_H) {
            gray[ny * SCREEN_W + nx] += err * w;
          }
        }
      }
    }
    return out;
  }

  const ATKINSON_TAPS = [
    [1, 0, 1 / 8], [2, 0, 1 / 8],
    [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8],
    [0, 2, 1 / 8],
  ];

  const FLOYD_TAPS = [
    [1, 0, 7 / 16],
    [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16],
  ];

  function ditherOrdered(gray, threshold) {
    const out = new Uint8Array(SCREEN_W * SCREEN_H);
    for (let y = 0; y < SCREEN_H; y++) {
      const row = BAYER8[y & 7];
      for (let x = 0; x < SCREEN_W; x++) {
        const i = y * SCREEN_W + x;
        const v = gray[i] + ((row[x & 7] + 0.5) / 64 - 0.5) * 255;
        out[i] = v < threshold ? 1 : 0;
      }
    }
    return out;
  }

  function ditherThreshold(gray, threshold) {
    const out = new Uint8Array(SCREEN_W * SCREEN_H);
    for (let i = 0; i < gray.length; i++) out[i] = gray[i] < threshold ? 1 : 0;
    return out;
  }

  function dither() {
    const gray = buildGray();
    const threshold = parseInt(threshEl.value, 10);
    switch (algoEl.value) {
      case "floyd": return diffuse(gray, threshold, FLOYD_TAPS);
      case "bayer": return ditherOrdered(gray, threshold);
      case "threshold": return ditherThreshold(gray, threshold);
      default: return diffuse(gray, threshold, ATKINSON_TAPS); // atkinson
    }
  }

  // --- rendering ---
  function drawEmpty() {
    ctx.fillStyle = "#1a1a1e";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    ctx.fillStyle = "#9a9aa5";
    ctx.font = "18px -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Load or drop a photo", SCREEN_W / 2, SCREEN_H / 2);
  }

  function render() {
    renderQueued = false;
    if (!img) { drawEmpty(); return; }
    bits = dither();
    const image = ctx.createImageData(SCREEN_W, SCREEN_H);
    const px = image.data;
    for (let i = 0; i < bits.length; i++) {
      const v = bits[i] ? 0 : 255;
      const p = i * 4;
      px[p] = px[p + 1] = px[p + 2] = v;
      px[p + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }

  function requestRender() {
    if (!renderQueued) {
      renderQueued = true;
      requestAnimationFrame(render);
    }
  }

  function syncLabels() {
    zoomValEl.textContent = Math.round(parseFloat(zoomEl.value) * 100) + "%";
    brightValEl.textContent = brightEl.value;
    contrastValEl.textContent = contrastEl.value;
    threshValEl.textContent = threshEl.value;
  }

  // --- MacPaint (PNTG) export ---

  // Apple PackBits, applied per scanline.
  function packBits(src) {
    const out = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      let run = 1;
      while (run < 128 && i + run < n && src[i + run] === src[i]) run++;
      if (run >= 2) {
        out.push(257 - run, src[i]); // -(run-1) as an unsigned byte
        i += run;
      } else {
        const lit = i;
        i++;
        while (i < n && i - lit < 128 && !(i + 1 < n && src[i] === src[i + 1])) i++;
        out.push(i - lit - 1);
        for (let k = lit; k < i; k++) out.push(src[k]);
      }
    }
    return out;
  }

  // Build the MacPaint data fork: 512-byte header (version 0 = default
  // patterns) + 720 PackBits-compressed 72-byte scanlines. The screen image
  // sits at the document's top-left corner.
  function buildMacPaint() {
    const doc = new Uint8Array(DOC_ROW_BYTES * DOC_H); // 0 bits = white

    for (let y = 0; y < SCREEN_H; y++) {
      const rowStart = y * DOC_ROW_BYTES;
      for (let xb = 0; xb < SCREEN_W / 8; xb++) {
        let b = 0;
        const base = y * SCREEN_W + xb * 8;
        for (let k = 0; k < 8; k++) b = (b << 1) | bits[base + k];
        doc[rowStart + xb] = b;
      }
    }

    const body = [];
    for (let y = 0; y < DOC_H; y++) {
      body.push(...packBits(doc.subarray(y * DOC_ROW_BYTES, (y + 1) * DOC_ROW_BYTES)));
    }

    const fork = new Uint8Array(512 + body.length);
    fork.set(body, 512);
    return fork;
  }

  function crc16(bytes, len) {
    let crc = 0;
    for (let i = 0; i < len; i++) {
      crc ^= bytes[i] << 8;
      for (let b = 0; b < 8; b++) {
        crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc;
  }

  function writeU32(buf, off, v) {
    buf[off] = (v >>> 24) & 0xff;
    buf[off + 1] = (v >>> 16) & 0xff;
    buf[off + 2] = (v >>> 8) & 0xff;
    buf[off + 3] = v & 0xff;
  }

  function writeAscii(buf, off, str) {
    for (let i = 0; i < str.length; i++) buf[off + i] = str.charCodeAt(i);
  }

  // Wrap the data fork in a MacBinary II envelope with type PNTG / creator
  // MPNT, so Stuffit Expander or an emulator restores a real MacPaint file.
  function buildMacBinary(name, dataFork) {
    const h = new Uint8Array(128);
    h[1] = name.length;
    writeAscii(h, 2, name);
    writeAscii(h, 65, "PNTG");
    writeAscii(h, 69, "MPNT");
    writeU32(h, 83, dataFork.length);
    const macSecs = Math.floor(Date.now() / 1000) + MAC_EPOCH_OFFSET;
    writeU32(h, 91, macSecs);
    writeU32(h, 95, macSecs);
    h[122] = 129; // MacBinary II
    h[123] = 129;
    const crc = crc16(h, 124);
    h[124] = (crc >>> 8) & 0xff;
    h[125] = crc & 0xff;

    const padded = Math.ceil(dataFork.length / 128) * 128;
    const out = new Uint8Array(128 + padded);
    out.set(h, 0);
    out.set(dataFork, 128);
    return out;
  }

  // Wrap the data fork in BinHex 4.0 with type PNTG / creator MPNT. Pure
  // 7-bit text, so it survives any transfer path; StuffIt Expander decodes it.
  function buildBinHex(name, dataFork) {
    const head = [name.length];
    for (let i = 0; i < name.length; i++) head.push(name.charCodeAt(i));
    head.push(0); // version
    for (const ch of "PNTGMPNT") head.push(ch.charCodeAt(0));
    head.push(0, 0); // Finder flags
    head.push((dataFork.length >>> 24) & 0xff, (dataFork.length >>> 16) & 0xff,
      (dataFork.length >>> 8) & 0xff, dataFork.length & 0xff);
    head.push(0, 0, 0, 0); // resource fork length
    const hcrc = crc16(Uint8Array.from(head), head.length);
    head.push((hcrc >>> 8) & 0xff, hcrc & 0xff);

    const dcrc = crc16(dataFork, dataFork.length);
    const payload = new Uint8Array(head.length + dataFork.length + 4);
    payload.set(head, 0);
    payload.set(dataFork, head.length);
    let o = head.length + dataFork.length;
    payload[o++] = (dcrc >>> 8) & 0xff;
    payload[o++] = dcrc & 0xff;
    payload[o++] = 0; // CRC of the empty resource fork
    payload[o++] = 0;

    // RLE90: runs of 4-255 become [byte, 0x90, count]; literal 0x90 -> 0x90 0x00
    const rle = [];
    let i = 0;
    while (i < payload.length) {
      const b = payload[i];
      let run = 1;
      while (run < 255 && i + run < payload.length && payload[i + run] === b) run++;
      if (b === 0x90) {
        for (let k = 0; k < run; k++) rle.push(0x90, 0x00);
      } else if (run >= 4) {
        rle.push(b, 0x90, run);
      } else {
        for (let k = 0; k < run; k++) rle.push(b);
      }
      i += run;
    }

    // 6-bit encode, 64 chars per line, CR line endings
    let out = "(This file must be converted with BinHex 4.0)\r\r:";
    let acc = 0, bits = 0, col = 1;
    const emit = (ch) => {
      out += ch;
      if (++col === 64) { out += "\r"; col = 0; }
    };
    for (const byte of rle) {
      acc = (acc << 8) | byte;
      bits += 8;
      while (bits >= 6) {
        bits -= 6;
        emit(HQX_ALPHABET[(acc >>> bits) & 63]);
      }
    }
    if (bits > 0) emit(HQX_ALPHABET[(acc << (6 - bits)) & 63]);
    emit(":");
    return out + "\r";
  }

  // Classic Mac filename: printable ASCII, no colons, HFS limit of 31 chars.
  function macFileName() {
    const clean = imgName.replace(/[^\x20-\x7e]/g, "").replace(/:/g, "-").trim();
    return (clean || "Wallpaper").slice(0, 31);
  }

  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --- image loading ---
  function loadImageFile(file) {
    if (!file.type.startsWith("image/")) {
      setStatus(`"${file.name}" isn't an image file.`, true);
      return;
    }
    const url = URL.createObjectURL(file);
    const el = new Image();
    el.onload = () => {
      URL.revokeObjectURL(url);
      img = el;
      imgName = file.name.replace(/\.[^.]*$/, "");
      cx = img.naturalWidth / 2;
      cy = img.naturalHeight / 2;
      zoomEl.value = "1";
      setControlsEnabled(true);
      syncLabels();
      clampView();
      requestRender();
      setStatus(`Loaded "${file.name}" — ${img.naturalWidth}×${img.naturalHeight}. Drag the preview to reposition; zoom to crop tighter.`, false);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      setStatus(`Couldn't decode "${file.name}".`, true);
    };
    el.src = url;
  }

  // --- events ---
  fileEl.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) loadImageFile(f);
    e.target.value = ""; // allow re-loading the same file
  });

  cardEl.addEventListener("dragover", (e) => e.preventDefault());
  cardEl.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadImageFile(f);
  });

  // drag to pan
  canvasEl.addEventListener("pointerdown", (e) => {
    if (!img) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvasEl.classList.add("dragging");
    canvasEl.setPointerCapture(e.pointerId);
  });
  canvasEl.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = canvasEl.getBoundingClientRect();
    const toSource = (SCREEN_W / rect.width) / viewScale();
    cx -= (e.clientX - lastX) * toSource;
    cy -= (e.clientY - lastY) * toSource;
    lastX = e.clientX;
    lastY = e.clientY;
    clampView();
    requestRender();
  });
  canvasEl.addEventListener("pointerup", () => {
    dragging = false;
    canvasEl.classList.remove("dragging");
  });

  // scroll to zoom
  canvasEl.addEventListener("wheel", (e) => {
    if (!img) return;
    e.preventDefault();
    const z = parseFloat(zoomEl.value) * Math.exp(-e.deltaY * 0.002);
    zoomEl.value = Math.max(1, Math.min(4, z)).toFixed(2);
    syncLabels();
    clampView();
    requestRender();
  }, { passive: false });

  zoomEl.addEventListener("input", () => {
    syncLabels();
    clampView();
    requestRender();
  });

  [brightEl, contrastEl, threshEl].forEach((el) => {
    el.addEventListener("input", () => {
      syncLabels();
      requestRender();
    });
  });

  [algoEl, invertEl].forEach((el) => el.addEventListener("change", requestRender));

  resetEl.addEventListener("click", () => {
    algoEl.value = "atkinson";
    invertEl.checked = false;
    zoomEl.value = "1";
    brightEl.value = "0";
    contrastEl.value = "0";
    threshEl.value = "128";
    if (img) {
      cx = img.naturalWidth / 2;
      cy = img.naturalHeight / 2;
    }
    syncLabels();
    if (img) clampView();
    requestRender();
  });

  dlHqxEl.addEventListener("click", () => {
    if (!bits) return;
    const fork = buildMacPaint();
    const name = macFileName();
    const hqx = buildBinHex(name, fork);
    downloadBytes(hqx, name + ".hqx");
    setStatus(`Exported ${name}.hqx — BinHex 4.0 text, ${hqx.length} bytes (${fork.length}-byte PNTG inside).`, false);
  });

  dlBinEl.addEventListener("click", () => {
    if (!bits) return;
    const fork = buildMacPaint();
    const name = macFileName();
    const bin = buildMacBinary(name, fork);
    downloadBytes(bin, name + ".bin");
    setStatus(`Exported ${name}.bin — MacBinary II, ${bin.length} bytes (${fork.length}-byte PNTG data fork).`, false);
  });

  dlRawEl.addEventListener("click", () => {
    if (!bits) return;
    const fork = buildMacPaint();
    const name = macFileName();
    downloadBytes(fork, name + ".pntg");
    setStatus(`Exported ${name}.pntg — raw MacPaint data, ${fork.length} bytes.`, false);
  });

  setControlsEnabled(false);
  syncLabels();
  drawEmpty();
});
