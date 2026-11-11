/**
 * Floor-plan → wall rectangles.
 *
 * The plan is a grayscale CAD-style drawing: dark linework on white. Walls are
 * drawn as double lines with a hollow core, which means a naive threshold gives
 * two thin lines per wall instead of a solid band. The pipeline here:
 *
 *   1. adaptive threshold (local mean − C) so JPEG falloff and faint lines both survive
 *   2. morphological closing, which fills the hollow core → solid wall bands
 *   3. run-length filter: keep only long straight runs (walls are axis aligned),
 *      which drops text, door arcs, dimension marks and furniture symbols
 *   4. connected-component filter: drop leftover small blobs
 *   5. greedy rectangle merge: turn the pixel mask into a small set of boxes
 *
 * Everything is plain JS + typed arrays so there is no build step and no deps.
 */

const DEFAULTS = {
  targetWidth: 1200, // working resolution, scaled from the source image
  contrast: 16, // adaptive threshold bias
  closeRadiusRatio: 0.0033, // ≈4px at 1200 wide
  minRunRatio: 0.029, // ≈35px at 1200 wide
  minAreaRatio: 0.00055, // fraction of total pixels, ≈790px at 1200×896
};

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load floor plan image: ' + url));
    img.src = url;
  });
}

export async function extractWalls(url, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const img = await loadImage(url);
  return analyzeImage(img, opts);
}

export function analyzeImage(img, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (!srcW || !srcH) throw new Error('Floor plan image has no size');

  const w = Math.min(opts.targetWidth, srcW);
  const h = Math.max(1, Math.round((srcH * w) / srcW));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  // --- 1. grayscale luminance ------------------------------------------------
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  // --- 2. adaptive threshold -------------------------------------------------
  const sum = integral(gray, w, h);
  const win = Math.max(8, Math.round(0.019 * w));
  const dark = new Uint8Array(w * h);
  const x0s = new Int32Array(w);
  const x1s = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    x0s[x] = Math.max(0, x - win);
    x1s[x] = Math.min(w, x + win + 1);
  }
  let darkCount = 0;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - win);
    const y1 = Math.min(h, y + win + 1);
    const rowTop = y0 * (w + 1);
    const rowBot = y1 * (w + 1);
    for (let x = 0; x < w; x++) {
      const xa = x0s[x];
      const xb = x1s[x];
      const local =
        sum[rowBot + xb] - sum[rowTop + xb] - sum[rowBot + xa] + sum[rowTop + xa];
      const mean = local / ((y1 - y0) * (xb - xa));
      const idx = y * w + x;
      if (gray[idx] < mean - opts.contrast) {
        dark[idx] = 1;
        darkCount++;
      }
    }
  }

  // --- 3. closing (dilate → erode) ------------------------------------------
  const r = Math.max(2, Math.round(opts.closeRadiusRatio * w));
  const closed = erode(dilate(dark, w, h, r), w, h, r);

  // --- 4. keep only long straight runs --------------------------------------
  const minRun = Math.max(12, Math.round(opts.minRunRatio * w));
  const straight = keepLongRuns(closed, w, h, minRun);

  // --- 5. drop small / non-wall components -----------------------------------
  // Text glyphs survive the run filter as short thick bars, so components are
  // kept only when they are big, or when they are a large hollow outline
  // (an isolated small room like a pantry is a thin loop, not a solid blob).
  const minBigArea = Math.max(400, Math.round(opts.minAreaRatio * 2.6 * w * h));
  const minSmallArea = Math.max(200, Math.round(opts.minAreaRatio * w * h));
  const minDiag = Math.round(0.05 * w);
  const maxFill = 0.5;
  const { mask, components, keptComponents } = filterComponents(straight, w, h, {
    minBigArea,
    minSmallArea,
    minDiag,
    maxFill,
  });

  // --- 6. greedy rectangle merge --------------------------------------------
  const { rects, bounds } = rectMerge(mask, w, h);
  if (!rects.length || !bounds) {
    throw new Error('No walls detected in the floor plan');
  }

  return {
    rects,
    bounds,
    gridWidth: w,
    gridHeight: h,
    imageWidth: srcW,
    imageHeight: srcH,
    stats: { darkCount, components, keptComponents, rects: rects.length, minRun, closeRadius: r },
  };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Prefix sum with an extra row/column of zeros: (w+1) × (h+1). */
function integral(src, w, h) {
  const out = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const srcRow = y * w;
    const outRow = (y + 1) * (w + 1);
    const prevRow = y * (w + 1);
    for (let x = 0; x < w; x++) {
      rowSum += src[srcRow + x];
      out[outRow + x + 1] = out[prevRow + x + 1] + rowSum;
    }
  }
  return out;
}

function boxCount(mask, w, h, radius) {
  const sum = integral(mask, w, h);
  const out = new Uint32Array(w * h);
  const x0s = new Int32Array(w);
  const x1s = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    x0s[x] = Math.max(0, x - radius);
    x1s[x] = Math.min(w, x + radius + 1);
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h, y + radius + 1);
    const rowTop = y0 * (w + 1);
    const rowBot = y1 * (w + 1);
    for (let x = 0; x < w; x++) {
      const xa = x0s[x];
      const xb = x1s[x];
      out[y * w + x] =
        sum[rowBot + xb] - sum[rowTop + xb] - sum[rowBot + xa] + sum[rowTop + xa];
    }
  }
  return out;
}

function dilate(mask, w, h, radius) {
  const counts = boxCount(mask, w, h, radius);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = counts[i] > 0 ? 1 : 0;
  return out;
}

function erode(mask, w, h, radius) {
  const counts = boxCount(mask, w, h, radius);
  const out = new Uint8Array(w * h);
  const x0s = new Int32Array(w);
  const x1s = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    x0s[x] = Math.max(0, x - radius);
    x1s[x] = Math.min(w, x + radius + 1);
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const area = (y1 - y0) * (x1s[x] - x0s[x]);
      out[y * w + x] = counts[y * w + x] >= area ? 1 : 0;
    }
  }
  return out;
}

function keepLongRuns(mask, w, h, minRun) {
  const out = new Uint8Array(w * h);
  // horizontal runs
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && mask[row + x];
      if (on && start < 0) start = x;
      else if (!on && start >= 0) {
        if (x - start >= minRun) out.fill(1, row + start, row + x);
        start = -1;
      }
    }
  }
  // vertical runs
  for (let x = 0; x < w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && mask[y * w + x];
      if (on && start < 0) start = y;
      else if (!on && start >= 0) {
        if (y - start >= minRun) {
          for (let yy = start; yy < y; yy++) out[yy * w + x] = 1;
        }
        start = -1;
      }
    }
  }
  return out;
}

function filterComponents(mask, w, h, { minBigArea, minSmallArea, minDiag, maxFill }) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const out = new Uint8Array(w * h);
  let next = 0;
  let kept = 0;
  let total = 0;

  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    total++;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = next + 1;
    const cells = [];
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    while (sp > 0) {
      const p = stack[--sp];
      cells.push(p);
      const y = (p / w) | 0;
      const x = p - y * w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0) {
        const q = p - 1;
        if (mask[q] && !labels[q]) { labels[q] = next + 1; stack[sp++] = q; }
      }
      if (x < w - 1) {
        const q = p + 1;
        if (mask[q] && !labels[q]) { labels[q] = next + 1; stack[sp++] = q; }
      }
      if (y > 0) {
        const q = p - w;
        if (mask[q] && !labels[q]) { labels[q] = next + 1; stack[sp++] = q; }
      }
      if (y < h - 1) {
        const q = p + w;
        if (mask[q] && !labels[q]) { labels[q] = next + 1; stack[sp++] = q; }
      }
    }
    next++;

    const area = cells.length;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    const diag = Math.hypot(bw, bh);
    const looksLikeWallNetwork = area >= minBigArea;
    const looksLikeHollowOutline = area >= minSmallArea && diag >= minDiag && fill <= maxFill;

    if (looksLikeWallNetwork || looksLikeHollowOutline) {
      kept++;
      for (const p of cells) out[p] = 1;
    }
  }
  return { mask: out, components: total, keptComponents: kept };
}

/**
 * Greedy rectangle decomposition of a binary mask: extend right while free,
 * then extend down while the whole span of rows is free.
 * Returns rectangles in grid units plus their bounding box.
 */
function rectMerge(mask, w, h) {
  const used = new Uint8Array(w * h);
  const rects = [];
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i] || used[i]) continue;

      let rw = 1;
      while (x + rw < w && mask[i + rw] && !used[i + rw]) rw++;

      let rh = 1;
      grow: while (y + rh < h) {
        const base = (y + rh) * w + x;
        for (let k = 0; k < rw; k++) {
          if (!mask[base + k] || used[base + k]) break grow;
        }
        rh++;
      }

      for (let yy = 0; yy < rh; yy++) {
        used.fill(1, (y + yy) * w + x, (y + yy) * w + x + rw);
      }
      rects.push({ x, y, w: rw, h: rh });

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + rw > maxX) maxX = x + rw;
      if (y + rh > maxY) maxY = y + rh;
    }
  }

  const bounds = rects.length ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
  return { rects, bounds };
}
