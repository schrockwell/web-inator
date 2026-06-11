"use strict";

const ICON_OFFSET = 0xFD2;   // 4050
const ICON_BYTES = 20;
const WIDTH = 16, HEIGHT = 10;
const EXPECTED_SIZE = 135168; // 132 KB base ROM
const OVERLAY_X = 5, OVERLAY_Y = 6; // icon position within the Happy Mac base
const PAD = 4; // white padding (in base pixels) around the preview

document.addEventListener("DOMContentLoaded", () => {
    let romBytes = null;                 // Uint8Array: full working ROM
    let originalIcon = new Uint8Array(ICON_BYTES); // snapshot for "Reset to original"
    const pixels = Array.from({ length: HEIGHT }, () => new Array(WIDTH).fill(0));

    // --- drawing-drag state ---
    let isPainting = false;
    let paintValue = 1;

    // --- DOM ---
    const gridEl = document.getElementById("grid");
    const statusEl = document.getElementById("status");
    const cells = []; // cells[r][c] -> div

    // preview canvas + Happy Mac base image
    const previewEl = document.getElementById("preview");
    const pctx = previewEl.getContext("2d");
    const baseImg = new Image();
    let baseReady = false;
    baseImg.onload = () => { baseReady = true; renderPreview(); };
    baseImg.src = "happy-mac.png";

    function renderPreview() {
        if (!baseReady) return;
        pctx.imageSmoothingEnabled = false;
        pctx.fillStyle = "#fff"; // white padding around the base
        pctx.fillRect(0, 0, previewEl.width, previewEl.height);
        pctx.drawImage(baseImg, PAD, PAD);
        for (let r = 0; r < HEIGHT; r++) {
            for (let c = 0; c < WIDTH; c++) {
                pctx.fillStyle = pixels[r][c] ? "#000" : "#fff"; // bit 1 = black, 0 = white
                pctx.fillRect(PAD + OVERLAY_X + c, PAD + OVERLAY_Y + r, 1, 1);
            }
        }
    }

    function b64ToBytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function readIconToPixels() {
        for (let r = 0; r < HEIGHT; r++) {
            for (let c = 0; c < WIDTH; c++) {
                const byte = romBytes[ICON_OFFSET + r * 2 + (c < 8 ? 0 : 1)];
                const bit = 7 - (c % 8);
                pixels[r][c] = (byte >> bit) & 1;
            }
        }
    }

    function writePixelsToRom() {
        for (let r = 0; r < HEIGHT; r++) {
            let hi = 0, lo = 0;
            for (let c = 0; c < WIDTH; c++) {
                const bit = 7 - (c % 8);
                if (pixels[r][c]) {
                    if (c < 8) hi |= (1 << bit); else lo |= (1 << bit);
                }
            }
            romBytes[ICON_OFFSET + r * 2] = hi;
            romBytes[ICON_OFFSET + r * 2 + 1] = lo;
        }
    }

    function buildGrid() {
        gridEl.innerHTML = "";
        for (let r = 0; r < HEIGHT; r++) {
            cells[r] = [];
            for (let c = 0; c < WIDTH; c++) {
                const cell = document.createElement("div");
                cell.className = "cell";
                cell.dataset.r = r;
                cell.dataset.c = c;
                gridEl.appendChild(cell);
                cells[r][c] = cell;
            }
        }
    }

    function paintCell(r, c, val) {
        if (pixels[r][c] === val) return;
        pixels[r][c] = val;
        renderCell(r, c);
        renderPreview();
    }

    function renderCell(r, c) {
        // bit 1 = black, bit 0 = white
        cells[r][c].className = "cell " + (pixels[r][c] ? "black" : "white");
    }

    function render() {
        for (let r = 0; r < HEIGHT; r++)
            for (let c = 0; c < WIDTH; c++) renderCell(r, c);
        renderPreview();
    }

    function loadRom(bytes, label) {
        romBytes = new Uint8Array(bytes); // own a mutable copy
        originalIcon = romBytes.slice(ICON_OFFSET, ICON_OFFSET + ICON_BYTES);
        readIconToPixels();
        render();
        if (romBytes.length !== EXPECTED_SIZE) {
            setStatus(`Loaded ${label} (${romBytes.length} bytes). Expected ${EXPECTED_SIZE}; editing icon anyway.`, true);
        } else {
            setStatus(`Loaded ${label} (${romBytes.length} bytes).`, false);
        }
    }

    function setStatus(msg, warn) {
        statusEl.textContent = msg;
        statusEl.className = "status" + (warn ? " warn" : "");
    }

    // --- events: drag painting ---
    function cellFromEvent(e) {
        const t = e.target;
        if (!t || !t.classList || !t.classList.contains("cell")) return null;
        return { r: +t.dataset.r, c: +t.dataset.c };
    }

    gridEl.addEventListener("mousedown", (e) => {
        const cell = cellFromEvent(e);
        if (!cell) return;
        e.preventDefault();
        isPainting = true;
        paintValue = pixels[cell.r][cell.c] ? 0 : 1; // toggle clicked pixel, drag paints that value
        paintCell(cell.r, cell.c, paintValue);
    });
    gridEl.addEventListener("mouseover", (e) => {
        if (!isPainting) return;
        const cell = cellFromEvent(e);
        if (cell) paintCell(cell.r, cell.c, paintValue);
    });
    document.addEventListener("mouseup", () => { isPainting = false; });

    // touch support (drag paint on mobile)
    gridEl.addEventListener("touchstart", (e) => {
        const t = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
        if (t && t.classList.contains("cell")) {
            e.preventDefault();
            isPainting = true;
            const r = +t.dataset.r, c = +t.dataset.c;
            paintValue = pixels[r][c] ? 0 : 1;
            paintCell(r, c, paintValue);
        }
    }, { passive: false });
    gridEl.addEventListener("touchmove", (e) => {
        if (!isPainting) return;
        e.preventDefault();
        const t = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
        if (t && t.classList.contains("cell")) paintCell(+t.dataset.r, +t.dataset.c, paintValue);
    }, { passive: false });
    document.addEventListener("touchend", () => { isPainting = false; });

    // --- controls ---
    document.getElementById("file").addEventListener("change", async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const buf = new Uint8Array(await f.arrayBuffer());
        if (buf.length < ICON_OFFSET + ICON_BYTES) {
            setStatus(`File too small (${buf.length} bytes); needs at least ${ICON_OFFSET + ICON_BYTES}.`, true);
            e.target.value = "";
            return;
        }
        loadRom(buf, f.name);
        e.target.value = ""; // allow re-loading the same file
    });

    document.getElementById("clear").addEventListener("click", () => {
        for (let r = 0; r < HEIGHT; r++)
            for (let c = 0; c < WIDTH; c++) pixels[r][c] = 0; // all white (bit 0)
        render();
        setStatus("Cleared to all white.", false);
    });

    document.getElementById("reset").addEventListener("click", () => {
        romBytes.set(originalIcon, ICON_OFFSET);
        readIconToPixels();
        render();
        setStatus("Icon reset to the originally loaded image.", false);
    });

    document.getElementById("download").addEventListener("click", () => {
        writePixelsToRom();
        const blob = new Blob([romBytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "code-custom.bin";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus("Downloaded code-custom.bin with your icon applied.", false);
    });

    // --- sample faces (ASCII art defined in samples.js) ---
    // Convert a face's ASCII art rows into the 20-byte ROM bitmap.
    function artToBytes(art) {
        const bytes = new Uint8Array(ICON_BYTES);
        for (let r = 0; r < HEIGHT; r++) {
            const row = art[r] || "";
            let hi = 0, lo = 0;
            for (let c = 0; c < WIDTH; c++) {
                const ch = row[c];
                const on = ch === "X" || ch === "x" || ch === "#";
                if (on) {
                    const bit = 7 - (c % 8);
                    if (c < 8) hi |= (1 << bit); else lo |= (1 << bit);
                }
            }
            bytes[r * 2] = hi;
            bytes[r * 2 + 1] = lo;
        }
        return bytes;
    }

    const facesEl = document.getElementById("faces");
    if (facesEl && typeof SAMPLE_FACES !== "undefined" && Array.isArray(SAMPLE_FACES)) {
        SAMPLE_FACES.forEach((face) => {
            const btn = document.createElement("button");
            btn.className = "sample";
            btn.type = "button";
            btn.innerHTML = `<span class="sample-icon"></span><span class="sample-name"></span>`;
            btn.querySelector(".sample-icon").textContent = face.icon || "";
            btn.querySelector(".sample-name").textContent = face.name;
            btn.addEventListener("click", () => {
                romBytes.set(artToBytes(face.art), ICON_OFFSET); // apply face into the working ROM
                readIconToPixels();
                render();
                setStatus(`Loaded the "${face.name}" face.`, false);
            });
            facesEl.appendChild(btn);
        });
    }

    // Dump the current grid as samples.js "art" rows. Call dumpArt() in the console,
    // draw a face, then paste the logged block into icon/samples.js.
    window.dumpArt = function dumpArt() {
        const rows = [];
        for (let r = 0; r < HEIGHT; r++) {
            let s = "";
            for (let c = 0; c < WIDTH; c++) s += pixels[r][c] ? "X" : ".";
            rows.push(s);
        }
        console.log("art: [\n" + rows.map((s) => `  "${s}",`).join("\n") + "\n],");
        return rows;
    };

    // --- init ---
    buildGrid();
    loadRom(b64ToBytes(DEFAULT_ROM_B64), "default ROM");
});