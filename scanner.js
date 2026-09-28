'use strict';
/* SteuerFinn Beleg-Scanner
   Ecken finden → entzerren → Filter (Farbe / S/W) → mehrere Seiten → JPEG oder PDF.
   Texterkennung (OCR) mit Tesseract.js, wird erst bei Bedarf geladen. */
const Scanner = (() => {
  const MAX_SRC = 3400;   // Kantenlänge Quellbild (iPhone-Foto 4032 px → kaum Verlust)
  const MAX_OUT = 2800;   // Kantenlänge Ergebnis (ca. 300 dpi bei A4-Breite)
  const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  // ---------- Bild laden / Canvas ----------
  function loadImage(file) {
    return new Promise((res, rej) => {
      const u = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(u); res(img); };
      img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('Bild konnte nicht geladen werden')); };
      img.src = u;
    });
  }
  function toCanvas(src, max) {
    const w0 = src.naturalWidth || src.width, h0 = src.naturalHeight || src.height;
    const s = Math.min(1, max / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * s));
    c.height = Math.max(1, Math.round(h0 * s));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function rotate(canvas, dir = 1) {
    const c = document.createElement('canvas');
    c.width = canvas.height; c.height = canvas.width;
    const x = c.getContext('2d');
    x.translate(c.width / 2, c.height / 2);
    x.rotate(dir * Math.PI / 2);
    x.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return c;
  }
  const toBlob = (c, q) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));

  // ---------- Ecken erkennen ----------
  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, max = 0, t = 127;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > max) { max = between; t = i; }
    }
    return t;
  }
  const quadArea = (q) => Math.abs(q.reduce((a, p, i) => { const n = q[(i + 1) % 4]; return a + p.x * n.y - n.x * p.y; }, 0)) / 2;
  const inset = (w, h, f = 0.04) => [
    { x: w * f, y: h * f }, { x: w * (1 - f), y: h * f }, { x: w * (1 - f), y: h * (1 - f) }, { x: w * f, y: h * (1 - f) },
  ];

  // Größte zusammenhängende Fläche einer Maske → äußerste Ecken
  function component(mask, w, h) {
    const n = w * h, lab = new Int32Array(n), stack = new Int32Array(n);
    let best = 0, bestSize = 0, cur = 0;
    for (let i = 0; i < n; i++) {
      if (!mask[i] || lab[i]) continue;
      cur++;
      let sp = 0, size = 0;
      stack[sp++] = i; lab[i] = cur;
      while (sp) {
        const p = stack[--sp]; size++;
        const px = p % w, py = (p / w) | 0;
        if (px > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack[sp++] = p - 1; }
        if (px < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack[sp++] = p + 1; }
        if (py > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = cur; stack[sp++] = p - w; }
        if (py < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = cur; stack[sp++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; best = cur; }
    }
    if (!best) return { size: 0 };
    let tl = [0, 0, Infinity], br = [0, 0, -Infinity], tr = [0, 0, -Infinity], bl = [0, 0, Infinity];
    for (let i = 0; i < n; i++) {
      if (lab[i] !== best) continue;
      const px = i % w, py = (i / w) | 0, a = px + py, b = px - py;
      if (a < tl[2]) tl = [px, py, a];
      if (a > br[2]) br = [px, py, a];
      if (b > tr[2]) tr = [px, py, b];
      if (b < bl[2]) bl = [px, py, b];
    }
    return { size: bestSize, pts: [tl, tr, br, bl] };
  }

  // 1) helles Papier auf dunklerem Grund (Otsu), 2) sonst: alles, was sich deutlich von der Randfarbe abhebt
  function detect(canvas) {
    const s = Math.min(1, 360 / Math.max(canvas.width, canvas.height));
    const w = Math.max(1, Math.round(canvas.width * s)), h = Math.max(1, Math.round(canvas.height * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.drawImage(canvas, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    const n = w * h, g = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) { const v = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; g[i] = v; hist[v]++; }
    const inQuad = (q, px, py) => { // konvexes Viereck, Punkt innen?
      let sign = 0;
      for (let k = 0; k < 4; k++) {
        const a = q[k], b = q[(k + 1) % 4];
        const cr = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
        if (cr !== 0) { if (!sign) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false; }
      }
      return true;
    };
    // Wie gut füllt die Fläche das gefundene Viereck? (IoU, 1 = perfektes Rechteck)
    const score = (mask) => {
      const r = component(mask, w, h);
      if (r.size < n * 0.08 || r.size > n * 0.97) return { r, iou: 0 };
      const q = r.pts;
      let inter = 0, qa = 0;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        if (!inQuad(q, xx, yy)) continue;
        qa++;
        if (mask[yy * w + xx]) inter++;
      }
      return { r, iou: inter / (qa + r.size - inter || 1) };
    };

    // Kandidat A: helles Papier (Otsu auf Helligkeit)
    const tA = otsu(hist, n);
    const mA = new Uint8Array(n);
    for (let i = 0; i < n; i++) mA[i] = g[i] > tA ? 1 : 0;
    // Kandidat B: farbloses Papier vor farbigem Untergrund (Holz, Stoff), robust gegen Schatten
    const sat = new Uint8Array(n), hs = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const r0 = d[i * 4], g0 = d[i * 4 + 1], b0 = d[i * 4 + 2];
      const mx = Math.max(r0, g0, b0), mn = Math.min(r0, g0, b0);
      sat[i] = mx ? Math.min(255, ((mx - mn) * 255 / mx) | 0) : 0;
      hs[sat[i]]++;
    }
    const tB = otsu(hs, n);
    const mB = new Uint8Array(n);
    for (let i = 0; i < n; i++) mB[i] = sat[i] < tB && g[i] > 35 ? 1 : 0;
    // Kandidat C: alles, was sich von der Randfarbe abhebt
    const bw = Math.max(2, Math.round(Math.min(w, h) * 0.03));
    let sr = 0, sg = 0, sb = 0, cnt = 0;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      if (xx >= bw && xx < w - bw && yy >= bw && yy < h - bw) continue;
      const i = (yy * w + xx) * 4; sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; cnt++;
    }
    sr /= cnt; sg /= cnt; sb /= cnt;
    const mC = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const dr = d[i * 4] - sr, dg = d[i * 4 + 1] - sg, db = d[i * 4 + 2] - sb;
      mC[i] = dr * dr + dg * dg + db * db > 40 * 40 ? 1 : 0;
    }

    // Papier füllt fast das ganze Bild?
    const all = component(mA, w, h);
    if (all.size > n * 0.96) return inset(canvas.width, canvas.height, 0.01);

    let best = null;
    for (const m of [mA, mB, mC]) {
      const sc = score(m);
      if (sc.iou > 0.8 && (!best || sc.iou > best.iou)) best = sc;
    }
    if (!best) return inset(canvas.width, canvas.height);
    const q = best.r.pts.map(([px, py]) => ({ x: (px + 0.5) / s, y: (py + 0.5) / s }));
    return quadArea(q) >= canvas.width * canvas.height * 0.08 ? q : inset(canvas.width, canvas.height);
  }

  // ---------- Perspektive entzerren ----------
  function solve(A, b) {
    const n = b.length;
    A.forEach((row, i) => row.push(b[i]));
    for (let c = 0; c < n; c++) {
      let m = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
      [A[c], A[m]] = [A[m], A[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
      }
    }
    return A.map((row, i) => row[n] / row[i]);
  }
  // H bildet Zielpunkte (dst) auf Quellpunkte (src) ab
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = dst[i], { x: u, y: v } = src[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    return [...solve(A, b), 1];
  }
  function warp(canvas, q) {
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    let H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    const s = Math.min(1, MAX_OUT / Math.max(W, H));
    W = Math.max(1, Math.round(W * s)); H = Math.max(1, Math.round(H * s));
    const m = homography(q, [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]);
    const sw = canvas.width, sh = canvas.height;
    const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ox = out.getContext('2d');
    const od = ox.createImageData(W, H), o = od.data;
    const maxU = sw - 1.001, maxV = sh - 1.001, row = sw * 4;
    for (let y = 0; y < H; y++) {
      const Y = y + 0.5;
      for (let x = 0; x < W; x++) {
        const X = x + 0.5;
        const den = m[6] * X + m[7] * Y + 1;
        let u = (m[0] * X + m[1] * Y + m[2]) / den - 0.5;
        let v = (m[3] * X + m[4] * Y + m[5]) / den - 0.5;
        u = u < 0 ? 0 : u > maxU ? maxU : u;
        v = v < 0 ? 0 : v > maxV ? maxV : v;
        const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
        const i00 = y0 * row + x0 * 4, i01 = i00 + row, k = (y * W + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const a = src[i00 + ch] + (src[i00 + 4 + ch] - src[i00 + ch]) * fx;
          const c = src[i01 + ch] + (src[i01 + 4 + ch] - src[i01 + ch]) * fx;
          o[k + ch] = a + (c - a) * fy;
        }
        o[k + 3] = 255;
      }
    }
    ox.putImageData(od, 0, 0);
    return out;
  }

  // ---------- Filter ----------
  // Papierhelligkeit je Bildbereich schätzen (Maximum in 8×8-Blöcken, dann Schrift „wegwachsen“ und glätten).
  // Teilt man das Bild dadurch, verschwinden Schatten und Farbstich, das Papier wird gleichmäßig weiß.
  function bgMap(d, w, h) {
    const B = 8, sw = Math.ceil(w / B), sh = Math.ceil(h / B), n = sw * sh;
    const maps = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let y = 0; y < h; y++) {
      const rowB = ((y / B) | 0) * sw;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, j = rowB + ((x / B) | 0);
        if (d[i] > maps[0][j]) maps[0][j] = d[i];
        if (d[i + 1] > maps[1][j]) maps[1][j] = d[i + 1];
        if (d[i + 2] > maps[2][j]) maps[2][j] = d[i + 2];
      }
    }
    const pass = (m, r, isMax) => {
      const t = new Float32Array(n), o = new Float32Array(n);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        let acc = 0, c = 0;
        for (let k = -r; k <= r; k++) {
          const v = m[y * sw + Math.min(sw - 1, Math.max(0, x + k))];
          if (isMax) { if (v > acc) acc = v; } else { acc += v; c++; }
        }
        t[y * sw + x] = isMax ? acc : acc / c;
      }
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        let acc = 0, c = 0;
        for (let k = -r; k <= r; k++) {
          const v = t[Math.min(sh - 1, Math.max(0, y + k)) * sw + x];
          if (isMax) { if (v > acc) acc = v; } else { acc += v; c++; }
        }
        o[y * sw + x] = isMax ? acc : acc / c;
      }
      return o;
    };
    return { maps: maps.map((m) => pass(pass(pass(m, 2, true), 3, false), 2, false)), sw, sh, B };
  }

  // Unscharf maskieren (3×3), macht Schrift knackiger
  function sharpen(o, w, h, ch, amt) {
    const n = w * h, t = new Float32Array(n), b = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      for (let y = 0; y < h; y++) {
        const r = y * w;
        for (let x = 0; x < w; x++) {
          const xl = x > 0 ? x - 1 : x, xr = x < w - 1 ? x + 1 : x;
          t[r + x] = (o[(r + xl) * ch + c] + o[(r + x) * ch + c] + o[(r + xr) * ch + c]) / 3;
        }
      }
      for (let y = 0; y < h; y++) {
        const ru = (y > 0 ? y - 1 : y) * w, r = y * w, rd = (y < h - 1 ? y + 1 : y) * w;
        for (let x = 0; x < w; x++) b[r + x] = (t[ru + x] + t[r + x] + t[rd + x]) / 3;
      }
      for (let p = 0; p < n; p++) { const k = p * ch + c; o[k] += amt * (o[k] - b[p]); }
    }
  }

  // Modi: original | farbe (verbessert) | grau | sw
  function filter(canvas, mode) {
    if (mode === 'original') return canvas;
    const w = canvas.width, h = canvas.height, n = w * h;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(canvas, 0, 0);
    const img = x.getImageData(0, 0, w, h), d = img.data;
    const { maps, sw, sh, B } = bgMap(d, w, h);
    const [m0, m1, m2] = maps;
    const color = mode === 'farbe', ch = color ? 3 : 1;
    const ratio = new Float32Array(n * ch);
    const hist = new Uint32Array(256);
    const SCALE = 212; // Verhältnis 0…1,2 → 0…255

    for (let y = 0; y < h; y++) {
      let fy = (y + 0.5) / B - 0.5; fy = fy < 0 ? 0 : fy > sh - 1 ? sh - 1 : fy;
      const y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
      for (let xx = 0; xx < w; xx++) {
        let fx = (xx + 0.5) / B - 0.5; fx = fx < 0 ? 0 : fx > sw - 1 ? sw - 1 : fx;
        const x0 = fx | 0, x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
        const a = y0 * sw + x0, b = y0 * sw + x1, cc = y1 * sw + x0, dd = y1 * sw + x1;
        const bl = (m) => { const t = m[a] + (m[b] - m[a]) * tx, u = m[cc] + (m[dd] - m[cc]) * tx; return Math.max(24, t + (u - t) * ty); };
        const br = bl(m0), bgg = bl(m1), bb = bl(m2);
        const p = y * w + xx, i = p * 4;
        const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / (br * 0.299 + bgg * 0.587 + bb * 0.114);
        hist[Math.min(255, (lum * SCALE) | 0)]++;
        if (color) { ratio[p * 3] = d[i] / br; ratio[p * 3 + 1] = d[i + 1] / bgg; ratio[p * 3 + 2] = d[i + 2] / bb; }
        else ratio[p] = lum;
      }
    }

    // Schwarzpunkt = dunkelste 0,4 %, Weißpunkt knapp unter Papier
    let acc = 0, bp = 0;
    for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc > n * 0.004) { bp = k / SCALE; break; } }
    bp = Math.min(bp, 0.5);
    const wp = 0.9;
    let lo = bp, hi = wp;
    if (mode === 'sw') { // Trennung Schrift/Papier automatisch (Otsu), weicher Übergang gegen Treppchen
      const hs = hist.slice();
      for (let k = Math.round(wp * SCALE); k < 256; k++) hs[k] = 0;
      let tot = 0; for (const v of hs) tot += v;
      let t = otsu(hs, tot) / SCALE;
      t = Math.min(wp - 0.06, Math.max(bp + 0.12, t));
      lo = t - 0.09; hi = t + 0.07;
    }
    const span = hi - lo, o = new Float32Array(n * ch);
    for (let k = 0; k < n * ch; k++) {
      let v = (ratio[k] - lo) / span;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      o[k] = mode === 'sw' ? v * 255 : 255 * Math.pow(v, 1.3);
    }
    if (mode !== 'sw') sharpen(o, w, h, ch, 0.9);
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      if (color) { d[i] = o[p * 3]; d[i + 1] = o[p * 3 + 1]; d[i + 2] = o[p * 3 + 2]; }
      else d[i] = d[i + 1] = d[i + 2] = o[p];
    }
    x.putImageData(img, 0, 0);
    return c;
  }

  // ---------- PDF (mehrseitig, JPEG-Seiten) ----------
  function makePdf(pages) {
    const te = new TextEncoder();
    const chunks = [], offsets = [];
    let len = 0;
    const push = (x) => { const b = typeof x === 'string' ? te.encode(x) : x; chunks.push(b); len += b.length; };
    const obj = (num, body) => { offsets[num] = len; push(`${num} 0 obj\n`); body(); push('\nendobj\n'); };
    push('%PDF-1.4\n%âãÏÓ\n');
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`));
    pages.forEach((pg, i) => {
      const bytes = new Uint8Array(pg.data);
      const pw = 595.28, ph = +(pw * pg.h / pg.w).toFixed(2), p = 3 + 3 * i;
      obj(p, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`));
      const cs = `q ${pw} 0 0 ${ph} 0 0 cm /Im${i} Do Q`;
      obj(p + 1, () => push(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`));
      obj(p + 2, () => {
        push(`<< /Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
        push(bytes);
        push('\nendstream');
      });
    });
    const total = 3 + 3 * pages.length, xref = len;
    push(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let k = 1; k < total; k++) push(String(offsets[k]).padStart(10, '0') + ' 00000 n \n');
    push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  // ---------- Texterkennung ----------
  let tessLoading = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    if (!tessLoading) {
      tessLoading = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = TESS_URL;
        s.onload = res;
        s.onerror = () => { tessLoading = null; s.remove(); rej(new Error('Texterkennung braucht beim ersten Mal Internet.')); };
        document.head.append(s);
      });
    }
    return tessLoading;
  }
  async function ocr(source, onProgress) {
    await loadTesseract();
    const c = toCanvas(source, 2400);
    const worker = await Tesseract.createWorker('deu', 1, {
      logger: (m) => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress); },
    });
    try {
      const { data } = await worker.recognize(c);
      return data.text || '';
    } finally {
      await worker.terminate();
    }
  }

  // Betrag, Datum und Händler aus Kassenbon-Text herauslesen
  function parseReceipt(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const amtRe = /(\d{1,3}(?:[.\s]\d{3})+|\d+)\s?[,.]\s?(\d{2})(?![\d])/g;
    const toNum = (a, b) => parseFloat(a.replace(/[.\s]/g, '') + '.' + b);
    const skip = /mwst|ust\b|netto|steuer|r[üu]ckgeld|zur[üu]ck|gegeben|rabatt|pfand/i;
    const kw = /summe|gesamt|total|zu zahlen|zahlbetrag|endbetrag|betrag|brutto|\bbar\b|\bec\b|karte|girocard|visa|mastercard/i;
    let amount = null;
    const scan = (filterFn) => {
      for (const l of lines) {
        if (!filterFn(l) || skip.test(l)) continue;
        for (const m of l.matchAll(amtRe)) {
          const v = toNum(m[1], m[2]);
          if (v > 0 && v < 100000 && (amount === null || v > amount)) amount = v;
        }
      }
    };
    scan((l) => kw.test(l));
    if (amount === null) scan(() => true);

    let date = null;
    const now = new Date().getFullYear();
    for (const m of text.matchAll(/(\d{1,2})\s?[./-]\s?(\d{1,2})\s?[./-]\s?(\d{4}|\d{2})(?!\d)/g)) {
      let [, d, mo, y] = m.map(Number);
      if (y < 100) y += 2000;
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= now - 3 && y <= now + 1) {
        date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        break;
      }
    }

    const name = lines.slice(0, 6).find((l) => (l.match(/[a-zäöüß]/gi) || []).length >= 3 && !/\d{4,}|www\.|str\.|straße|tel|@/i.test(l));
    return { amount, date, name: name ? name.replace(/[^\p{L}\p{N}&.\-' ]/gu, '').trim().slice(0, 40) : null };
  }

  // ---------- Oberfläche ----------
  // open(file, {pages}) → Promise<{pages:[{data,w,h}], first: canvas} | null>
  function open(file, opts = {}) {
    return new Promise((resolve) => {
      const pages = (opts.pages || []).map((p) => ({ ...p })); // {data,w,h, canvas?}
      const root = document.createElement('div');
      root.className = 'scan';
      document.body.append(root);
      document.body.classList.add('locked');
      const picker = document.createElement('input');
      picker.type = 'file'; picker.accept = 'image/*'; picker.hidden = true;
      picker.setAttribute('capture', 'environment');
      root.append(picker);

      let src = null;   // aktuelles Quellbild (Canvas)
      let quad = null;  // Ecken in Quell-Koordinaten
      let mode = 'grau';
      try { mode = localStorage.getItem('sf-scan-mode') || 'grau'; } catch { /* privat */ }
      let warped = null, result = null, rot = 0;

      const finish = (val) => {
        root.remove();
        if (!document.querySelector('#sheet.open')) document.body.classList.remove('locked');
        resolve(val);
      };

      const busy = (msg) => { root.innerHTML = `<div class="scan-busy"><div class="spinner"></div><p>${msg}</p></div>`; root.append(picker); };

      async function loadFile(f) {
        busy('Bild wird geladen …');
        try {
          const img = await loadImage(f);
          src = toCanvas(img, MAX_SRC);
          quad = detect(src);
          cropStep();
        } catch (err) {
          alert(err.message);
          pages.length ? reviewStep() : finish(null);
        }
      }

      picker.addEventListener('change', () => {
        const f = picker.files[0];
        picker.value = '';
        if (f) loadFile(f); else if (!src) finish(null);
      });
      const pickAnother = () => { window.SF_pickerOpened?.(); picker.click(); };

      // ---- Schritt 1: Ecken ----
      function cropStep() {
        root.innerHTML = `
          <header class="scan-bar">
            <button class="scan-link" data-s="cancel">${pages.length ? 'Zurück' : 'Abbrechen'}</button>
            <b>Seite ${pages.length + 1} · Ecken</b>
            <button class="scan-link strong" data-s="next">Weiter</button>
          </header>
          <div class="scan-stage"><canvas></canvas></div>
          <p class="scan-tip">Ziehe die Punkte auf die Ecken des Belegs.<br><small>Tipp: dunkler Untergrund, gleichmäßiges Licht, ohne Blitz.</small></p>
          <footer class="scan-tools">
            <button data-s="rot"><span>↻</span>Drehen</button>
            <button data-s="auto"><span>◎</span>Erkennen</button>
            <button data-s="full"><span>⛶</span>Ganzes Bild</button>
          </footer>`;
        root.append(picker);
        const stage = root.querySelector('.scan-stage');
        const cv = stage.querySelector('canvas');
        const ctx = cv.getContext('2d');
        let fit = { s: 1, ox: 0, oy: 0 }, drag = -1;
        const dpr = Math.min(3, window.devicePixelRatio || 1);

        const layout = () => {
          const r = stage.getBoundingClientRect();
          cv.width = r.width * dpr; cv.height = r.height * dpr;
          cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
          const pad = 22;
          const s = Math.min((r.width - pad * 2) / src.width, (r.height - pad * 2) / src.height);
          fit = { s, ox: (r.width - src.width * s) / 2, oy: (r.height - src.height * s) / 2 };
          draw();
        };
        const toView = (p) => ({ x: fit.ox + p.x * fit.s, y: fit.oy + p.y * fit.s });
        const draw = () => {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, cv.width, cv.height);
          ctx.drawImage(src, fit.ox, fit.oy, src.width * fit.s, src.height * fit.s);
          const v = quad.map(toView);
          // Außen abdunkeln
          ctx.save();
          ctx.fillStyle = 'rgba(0,0,0,.5)';
          ctx.beginPath();
          ctx.rect(0, 0, cv.width, cv.height);
          ctx.moveTo(v[0].x, v[0].y); v.slice(1).forEach((p) => ctx.lineTo(p.x, p.y)); ctx.closePath();
          ctx.fill('evenodd');
          ctx.restore();
          ctx.strokeStyle = '#4fe3a0'; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(v[0].x, v[0].y); v.slice(1).forEach((p) => ctx.lineTo(p.x, p.y)); ctx.closePath(); ctx.stroke();
          v.forEach((p, i) => {
            ctx.beginPath(); ctx.arc(p.x, p.y, i === drag ? 15 : 12, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(79,227,160,.25)'; ctx.fill();
            ctx.lineWidth = 3; ctx.strokeStyle = '#4fe3a0'; ctx.stroke();
          });
          if (drag >= 0) { // Lupe
            const p = quad[drag], vp = v[drag], R = 58, Z = 2.4;
            const cx = vp.x < cv.width / dpr / 2 ? cv.width / dpr - R - 14 : R + 14, cy = R + 14;
            ctx.save();
            ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
            ctx.fillStyle = '#000'; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
            const ss = fit.s * Z;
            ctx.drawImage(src, cx - p.x * ss, cy - p.y * ss, src.width * ss, src.height * ss);
            ctx.strokeStyle = '#4fe3a0'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12); ctx.stroke();
            ctx.restore();
            ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
          }
        };
        const point = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
        cv.addEventListener('pointerdown', (e) => {
          const pt = point(e);
          let best = -1, bd = 48;
          quad.map(toView).forEach((v, i) => { const d = Math.hypot(v.x - pt.x, v.y - pt.y); if (d < bd) { bd = d; best = i; } });
          if (best < 0) return;
          drag = best; cv.setPointerCapture(e.pointerId); draw();
        });
        cv.addEventListener('pointermove', (e) => {
          if (drag < 0) return;
          const pt = point(e);
          quad[drag] = {
            x: Math.min(src.width, Math.max(0, (pt.x - fit.ox) / fit.s)),
            y: Math.min(src.height, Math.max(0, (pt.y - fit.oy) / fit.s)),
          };
          draw();
        });
        const up = () => { drag = -1; draw(); };
        cv.addEventListener('pointerup', up);
        cv.addEventListener('pointercancel', up);
        requestAnimationFrame(layout);
        window.addEventListener('resize', layout, { once: true });

        root.onclick = (e) => {
          const b = e.target.closest('[data-s]');
          if (!b) return;
          const a = b.dataset.s;
          if (a === 'cancel') pages.length ? reviewStep() : finish(null);
          if (a === 'rot') { src = rotate(src, 1); quad = detect(src); layout(); }
          if (a === 'auto') { quad = detect(src); draw(); }
          if (a === 'full') { quad = inset(src.width, src.height, 0); draw(); }
          if (a === 'next') {
            busy('Wird entzerrt …');
            setTimeout(() => { warped = warp(src, quad); rot = 0; editStep(); }, 30);
          }
        };
      }

      // ---- Schritt 2: Filter für diese Seite ----
      function editStep() {
        const apply = () => { let c = warped; for (let i = 0; i < rot; i++) c = rotate(c, 1); result = filter(c, mode); };
        apply();
        root.innerHTML = `
          <header class="scan-bar">
            <button class="scan-link" data-s="back">Ecken</button>
            <b>Seite ${pages.length + 1}</b>
            <button class="scan-link strong" data-s="take">Übernehmen</button>
          </header>
          <div class="scan-stage"><img alt="Vorschau"></div>
          <footer class="scan-tools">
            <div class="scan-seg">${[['original', 'Original'], ['farbe', 'Farbe'], ['grau', 'Grau'], ['sw', 'S/W']].map(([k, v]) => `<button data-m="${k}" aria-pressed="${k === mode}">${v}</button>`).join('')}</div>
            <button data-s="rot"><span>↻</span>Drehen</button>
          </footer>`;
        root.append(picker);
        const img = root.querySelector('img');
        let url;
        const show = () => { if (url) URL.revokeObjectURL(url); result.toBlob((b) => { url = URL.createObjectURL(b); img.src = url; img.style.opacity = ''; }, 'image/jpeg', 0.85); };
        show();
        root.onclick = async (e) => {
          const m = e.target.closest('[data-m]');
          if (m) {
            mode = m.dataset.m;
            try { localStorage.setItem('sf-scan-mode', mode); } catch { /* privat */ }
            root.querySelectorAll('[data-m]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.m === mode));
            img.style.opacity = '.4';
            setTimeout(() => { apply(); show(); }, 20);
            return;
          }
          const b = e.target.closest('[data-s]');
          if (!b) return;
          if (b.dataset.s === 'back') { if (url) URL.revokeObjectURL(url); cropStep(); }
          if (b.dataset.s === 'rot') { img.style.opacity = '.4'; setTimeout(() => { rot = (rot + 1) % 4; apply(); show(); }, 20); }
          if (b.dataset.s === 'take') {
            if (url) URL.revokeObjectURL(url);
            busy('Speichere Seite …');
            const blob = await toBlob(result, mode === 'original' || mode === 'farbe' ? 0.88 : 0.86);
            pages.push({ data: await blob.arrayBuffer(), w: result.width, h: result.height, canvas: result });
            src = null;
            reviewStep();
          }
        };
      }

      // ---- Schritt 3: Seitenübersicht ----
      function reviewStep() {
        const urls = [];
        root.innerHTML = `
          <header class="scan-bar">
            <button class="scan-link" data-s="cancel">Abbrechen</button>
            <b>${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'}</b>
            <button class="scan-link strong" data-s="done">Fertig</button>
          </header>
          <div class="scan-pages">
            ${pages.map((p, i) => { const u = URL.createObjectURL(new Blob([p.data], { type: 'image/jpeg' })); urls.push(u); return `<figure><img src="${u}" alt="Seite ${i + 1}"><figcaption>Seite ${i + 1}<button data-del="${i}" aria-label="Seite ${i + 1} löschen">✕</button></figcaption></figure>`; }).join('')}
            <button class="scan-add" data-s="add"><span>+</span>Weitere Seite scannen</button>
          </div>
          <p class="scan-tip">${pages.length > 1 ? 'Mehrere Seiten werden als PDF gespeichert.' : 'Mehrseitige Rechnung? Einfach weitere Seiten hinzufügen.'}</p>`;
        root.append(picker);
        const cleanup = () => urls.forEach((u) => URL.revokeObjectURL(u));
        root.onclick = (e) => {
          const del = e.target.closest('[data-del]');
          if (del) { pages.splice(+del.dataset.del, 1); cleanup(); pages.length ? reviewStep() : pickAnother(); return; }
          const b = e.target.closest('[data-s]');
          if (!b) return;
          if (b.dataset.s === 'cancel') { cleanup(); finish(null); }
          if (b.dataset.s === 'add') { cleanup(); pickAnother(); }
          if (b.dataset.s === 'done') {
            cleanup();
            if (!pages.length) { finish(null); return; }
            finish({ pages: pages.map(({ data, w, h }) => ({ data, w, h })), first: pages[0].canvas || null });
          }
        };
      }

      if (file) loadFile(file); else if (pages.length) reviewStep(); else pickAnother();
    });
  }

  return { open, ocr, parseReceipt, makePdf, loadImage, toCanvas };
})();
