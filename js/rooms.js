/**
 * Room detection.
 *
 * The wall mask already separates the plan into rooms, except where doors are
 * drawn as gaps. Strategy:
 *
 *   1. dilate the walls by a radius roughly half a door width, which plugs the
 *      door gaps (and any window gaps) in the *sealed* copy,
 *   2. flood fill the free space of that sealed copy into components,
 *   3. drop components that touch the image border (that is the area outside
 *      the apartment) and components that are too small to be rooms,
 *   4. grow the surviving labels back over the raw free space (never over a
 *      wall, never into a barrier) with a bounded BFS, so the rooms recover the
 *      area the dilation ate — and the doorway itself gets split between the
 *      two rooms it joins,
 *   5. decompose each room mask into rectangles with the same greedy merge the
 *      walls use, which gives us cheap floor geometry and a picking map.
 *
 * Everything stays in grid coordinates; the caller converts to world units.
 */

import { dilate, rectMerge } from './plan-extract.js';

const DEFAULTS = {
  // half of the widest door we want to plug, as a fraction of the plan width
  sealRatio: 0.03,
  // rooms smaller than this fraction of the image are noise
  minAreaRatio: 0.0025,
};

export function detectRooms(wallMask, w, h, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const sealRadius = opts.sealRadius ?? Math.max(8, Math.round(opts.sealRatio * w));
  const minArea = opts.minArea ?? Math.round(opts.minAreaRatio * w * h);
  const n = w * h;

  const sealed = dilate(wallMask, w, h, sealRadius);

  // --- 1. label the free space of the sealed plan ---------------------------
  const labels = new Int32Array(n); // 0 free, -1 barrier, >0 room id
  const stack = new Int32Array(n);
  const comps = [];
  let next = 0;

  for (let i = 0; i < n; i++) {
    if (sealed[i] || labels[i]) continue;
    next++;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = next;
    const cells = [];
    let touchesBorder = false;
    while (sp > 0) {
      const p = stack[--sp];
      cells.push(p);
      const y = (p / w) | 0;
      const x = p - y * w;
      if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3) touchesBorder = true;
      if (x > 0 && !sealed[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && !sealed[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && !sealed[p - w] && !labels[p - w]) { labels[p - w] = next; stack[sp++] = p - w; }
      if (y < h - 1 && !sealed[p + w] && !labels[p + w]) { labels[p + w] = next; stack[sp++] = p + w; }
    }
    comps.push({ id: next, cells, area: cells.length, touchesBorder });
  }

  // --- 2. keep room-sized, non-border components; everything else is barrier
  const kept = comps.filter((c) => !c.touchesBorder && c.area >= minArea);
  const keepIds = new Set(kept.map((c) => c.id));
  for (const c of comps) {
    if (!keepIds.has(c.id)) {
      for (const p of c.cells) labels[p] = -1;
    }
  }

  // --- 3. grow the labels back over the raw free space ----------------------
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (const c of kept) {
    for (const p of c.cells) queue[tail++] = p;
  }
  const maxDepth = 2 * sealRadius + 8;
  for (let depth = 0; depth < maxDepth && head < tail; depth++) {
    const levelEnd = tail;
    while (head < levelEnd) {
      const p = queue[head++];
      const id = labels[p];
      if (id <= 0) continue;
      const y = (p / w) | 0;
      const x = p - y * w;
      const tryGrow = (q) => {
        if (!wallMask[q] && labels[q] === 0) {
          labels[q] = id;
          queue[tail++] = q;
        }
      };
      if (x > 0) tryGrow(p - 1);
      if (x < w - 1) tryGrow(p + 1);
      if (y > 0) tryGrow(p - w);
      if (y < h - 1) tryGrow(p + w);
    }
  }

  // --- 4. per-room rectangles ----------------------------------------------
  const roomMask = new Uint8Array(n);
  const rooms = [];
  for (const c of kept) {
    const id = c.id;
    let cells = 0;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;
    roomMask.fill(0);
    for (let i = 0; i < n; i++) {
      if (labels[i] !== id) continue;
      roomMask[i] = 1;
      cells++;
      const y = (i / w) | 0;
      const x = i - y * w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += x;
      sumY += y;
    }
    const { rects } = rectMerge(roomMask, w, h);
    if (!rects.length) continue;
    rooms.push({
      id,
      cells,
      area: cells,
      rects,
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      center: { x: sumX / Math.max(1, cells), y: sumY / Math.max(1, cells) },
    });
  }

  // --- 5. reading order (top to bottom, right to left for RTL) --------------
  rooms.sort((a, b) => {
    const rowA = Math.round(a.center.y / (0.04 * h));
    const rowB = Math.round(b.center.y / (0.04 * h));
    if (rowA !== rowB) return rowA - rowB;
    return b.center.x - a.center.x;
  });

  // labels carry the old component ids; remap to the final, ordered ids
  const remap = new Map();
  rooms.forEach((room, index) => {
    const newId = index + 1;
    remap.set(room.id, newId);
    room.id = newId;
  });
  for (let i = 0; i < n; i++) {
    const v = labels[i];
    if (v > 0) labels[i] = remap.get(v) ?? 0;
  }

  return { rooms, labels, sealRadius, components: comps.length };
}

/**
 * For every wall box, which rooms sit on its edges and how long the contact is.
 * Sampling a ring outside the box is enough: walls are thin, so whatever is
 * immediately around them is the room they belong to.
 */
export function assignWallsToRooms(rects, labels, w, h, band = 4) {
  const out = new Array(rects.length);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const counts = new Map();
    const add = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const v = labels[y * w + x];
      if (v > 0) counts.set(v, (counts.get(v) || 0) + 1);
    };
    const x0 = r.x - band;
    const x1 = r.x + r.w + band - 1;
    const y0 = r.y - band;
    const y1 = r.y + r.h + band - 1;
    for (let x = x0; x <= x1; x++) {
      for (let d = 1; d <= band; d++) {
        add(x, r.y - d);
        add(x, r.y + r.h - 1 + d);
      }
    }
    for (let y = y0; y <= y1; y++) {
      for (let d = 1; d <= band; d++) {
        add(r.x - d, y);
        add(r.x + r.w - 1 + d, y);
      }
    }
    const rooms = [...counts.entries()]
      .map(([room, count]) => ({ room, count }))
      .sort((a, b) => b.count - a.count);
    out[i] = rooms;
  }
  return out;
}
