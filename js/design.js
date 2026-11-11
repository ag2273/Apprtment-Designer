/**
 * Per-room design: wall colours and floor tiles.
 *
 * Rooms come from rooms.js (pixel regions + rectangles). This module owns the
 * interactive part:
 *
 *   - wall recolouring is a vertex-colour write on the merged wall geometry,
 *     so it is one buffer update per change and still a single draw call;
 *   - each room gets a floor mesh built from its rectangles the first time a
 *     tile is applied, textured with world-space UVs (1 UV unit = one tile), so
 *     neighbouring rooms share one texture and the repeat stays realistic;
 *   - rooms are picked by casting the click ray onto the floor plane and
 *     looking the room id up in the label map — no picking geometry needed.
 */

import * as THREE from 'three';

export const WALL_COLORS = [
  { id: 'white', label: 'أبيض ناصع', hex: '#FFFFFF' },
  { id: 'warm-white', label: 'أبيض دافئ', hex: '#F7F3EC' },
  { id: 'ivory', label: 'عاجي', hex: '#F5F0E1' },
  { id: 'cream', label: 'كريمي', hex: '#F3E5C3' },
  { id: 'beige', label: 'بيج', hex: '#E8D8C0' },
  { id: 'sand', label: 'رملي', hex: '#DCC7A8' },
  { id: 'light-grey', label: 'رمادي فاتح', hex: '#D6D6D6' },
  { id: 'warm-grey', label: 'رمادي دافئ', hex: '#C8BFB4' },
  { id: 'grey', label: 'رمادي', hex: '#9E9E9E' },
  { id: 'dark-grey', label: 'رمادي داكن', hex: '#4A4A4A' },
  { id: 'light-blue', label: 'أزرق فاتح', hex: '#C7D9E5' },
  { id: 'sage', label: 'أخضر ميرمية', hex: '#BCC9B0' },
  { id: 'terracotta', label: 'تراكوتا', hex: '#C77B5B' },
  { id: 'olive', label: 'زيتوني', hex: '#A89A6E' },
  { id: 'indigo', label: 'نيلي', hex: '#2E3A4E' },
  { id: 'dusty-pink', label: 'وردي هادئ', hex: '#E8C9C4' },
];

const AR_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
const arNumber = (n) => String(n).replace(/\d/g, (d) => AR_DIGITS[Number(d)]);

export function createDesigner(ctx) {
  const {
    world,
    camera,
    canvas,
    renderer,
    wallMesh,
    rooms,
    labels,
    wallRooms,
    cell,
    cx,
    cy,
    gridWidth,
    gridHeight,
    imageAspect,
  } = ctx;

  const panel = document.getElementById('design-panel');
  const openButton = document.querySelector('[data-action="design"]');

  const roomColors = new Map(); // roomId -> '#RRGGBB'
  const roomTiles = new Map(); // roomId -> tile object
  const roomFloorMeshes = new Map(); // roomId -> THREE.Mesh
  const textureCache = new Map(); // tile id -> { texture, sizeU, sizeV }
  const colorCache = new Map(); // tile id -> CSS colour fallback

  let selectedRoom = null;
  let tiles = [];
  let highlight = null;
  let open = false;

  const raycaster = new THREE.Raycaster();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  /* ---------------------------------------------------------------- helpers */

  const toWorldX = (gridX) => (gridX - cx) * cell;
  const toWorldZ = (gridY) => (gridY - cy) * cell;
  const roomById = (id) => rooms.find((r) => r.id === id) || null;
  const roomName = (id) => `غرفة ${arNumber(id)}`;

  const baseColor = wallMesh.userData.baseColor;
  const wallColors = wallMesh.userData.colors;

  function applyWallColors() {
    const color = new THREE.Color();
    for (let i = 0; i < wallRooms.length; i++) {
      let chosen = null;
      for (const border of wallRooms[i]) {
        if (roomColors.has(border.room)) {
          chosen = roomColors.get(border.room);
          break;
        }
      }
      color.set(chosen || baseColor);
      const offset = i * 24 * 3;
      for (let v = 0; v < 24; v++) {
        wallColors[offset + v * 3] = color.r;
        wallColors[offset + v * 3 + 1] = color.g;
        wallColors[offset + v * 3 + 2] = color.b;
      }
    }
    wallMesh.geometry.attributes.color.needsUpdate = true;
  }

  /* ---------------------------------------------------------- floor meshes */

  function buildFloorGeometry(room) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    let base = 0;
    const y = 0.012;
    for (const r of room.rects) {
      const x0 = toWorldX(r.x);
      const x1 = toWorldX(r.x + r.w);
      const z0 = toWorldZ(r.y);
      const z1 = toWorldZ(r.y + r.h);
      positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
      normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      uvs.push(x0, z0, x1, z0, x1, z1, x0, z1);
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      base += 4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('tile image failed: ' + url));
      img.src = url;
    });
  }

  /** Centre-crop the product photo to ~75% so its border/shadow never tiles. */
  function cropToCanvas(img, ratio = 0.75) {
    const w = Math.max(32, Math.round(img.naturalWidth * ratio));
    const h = Math.max(32, Math.round(img.naturalHeight * ratio));
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const g = off.getContext('2d');
    g.drawImage(
      img,
      (img.naturalWidth - w) / 2,
      (img.naturalHeight - h) / 2,
      w,
      h,
      0,
      0,
      w,
      h
    );
    return off;
  }

  function averageColor(canvas) {
    const g = canvas.getContext('2d');
    const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
    let r = 0;
    let gg = 0;
    let b = 0;
    const step = Math.max(4, Math.floor(data.length / 4 / 4000)) * 4;
    let n = 0;
    for (let i = 0; i < data.length; i += step) {
      r += data[i];
      gg += data[i + 1];
      b += data[i + 2];
      n++;
    }
    return `rgb(${Math.round(r / n)}, ${Math.round(gg / n)}, ${Math.round(b / n)})`;
  }

  async function getTileTexture(tile) {
    if (textureCache.has(tile.id)) return textureCache.get(tile.id);
    const img = await loadImage(tile.file);
    const canvasEl = cropToCanvas(img, 0.75);
    const texture = new THREE.CanvasTexture(canvasEl);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    const aspect = img.naturalWidth / img.naturalHeight;
    let sizeU = 0.6;
    if (aspect > 2.2) sizeU = 1.2;
    else if (aspect > 1.6) sizeU = 0.9;
    const sizeV = sizeU / aspect;

    const info = { texture, sizeU, sizeV };
    textureCache.set(tile.id, info);
    colorCache.set(tile.id, averageColor(canvasEl));
    return info;
  }

  async function applyTile(roomId, tile) {
    const room = roomById(roomId);
    if (!room) return;
    let mesh = roomFloorMeshes.get(roomId);
    if (!mesh) {
      mesh = new THREE.Mesh(
        buildFloorGeometry(room),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 })
      );
      mesh.receiveShadow = true;
      mesh.name = 'floor-room-' + roomId;
      mesh.userData.roomId = roomId;
      world.add(mesh);
      roomFloorMeshes.set(roomId, mesh);
    }
    roomTiles.set(roomId, tile);

    try {
      const { texture, sizeU, sizeV } = await getTileTexture(tile);
      // world-space UVs: one UV unit == one physical tile, so the repeat is
      // realistic without touching texture.repeat per room
      const geo = mesh.geometry;
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        uv.setXY(i, pos.getX(i) / sizeU, pos.getZ(i) / sizeV);
      }
      uv.needsUpdate = true;
      mesh.material.map = texture;
      mesh.material.color.set(0xffffff);
      mesh.material.needsUpdate = true;
    } catch (err) {
      console.warn('[design] tile texture failed, using flat colour', err);
      mesh.material.map = null;
      mesh.material.color.set(colorCache.get(tile.id) || '#cfcac2');
      mesh.material.needsUpdate = true;
    }
    updateCurrentLabels();
  }

  /* ------------------------------------------------------------- highlight */

  function updateHighlight() {
    if (highlight) {
      world.remove(highlight);
      highlight.geometry.dispose();
      highlight.material.dispose();
      highlight = null;
    }
    const room = selectedRoom ? roomById(selectedRoom) : null;
    if (!room) return;
    const geo = buildFloorGeometry(room);
    geo.translate(0, 0.008, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x4f9dff,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    highlight = new THREE.Mesh(geo, mat);
    highlight.renderOrder = 2;
    highlight.name = 'room-highlight';
    world.add(highlight);
  }

  /* ------------------------------------------------------------------- ui */

  function updateCurrentLabels() {
    if (!panel) return;
    const wallSlot = panel.querySelector('[data-slot="wall-current"]');
    const tileSlot = panel.querySelector('[data-slot="tile-current"]');
    const roomSlot = panel.querySelector('[data-slot="room-current"]');
    const room = selectedRoom ? roomById(selectedRoom) : null;
    if (roomSlot) roomSlot.textContent = room ? roomName(room.id) : '—';

    if (wallSlot) {
      const hex = selectedRoom ? roomColors.get(selectedRoom) : null;
      const entry = WALL_COLORS.find((c) => c.hex === hex);
      wallSlot.textContent = entry ? entry.label : 'الافتراضي';
    }
    if (tileSlot) {
      const tile = selectedRoom ? roomTiles.get(selectedRoom) : null;
      tileSlot.textContent = tile ? `${tile.look} · ${tile.model}` : 'بدون بلاط';
    }
    if (panel) {
      panel.querySelectorAll('[data-room]').forEach((el) => {
        const on = Number(el.dataset.room) === selectedRoom;
        el.classList.toggle('is-selected', on);
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      panel.querySelectorAll('[data-color]').forEach((el) => {
        const on = selectedRoom && roomColors.get(selectedRoom) === el.dataset.color;
        el.classList.toggle('is-selected', Boolean(on));
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      panel.querySelectorAll('[data-tile]').forEach((el) => {
        const tile = selectedRoom ? roomTiles.get(selectedRoom) : null;
        const on = tile && tile.id === el.dataset.tile;
        el.classList.toggle('is-selected', Boolean(on));
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
  }

  function selectRoom(id, { scrollIntoView = false } = {}) {
    selectedRoom = id;
    updateHighlight();
    updateCurrentLabels();
    if (scrollIntoView && panel) {
      const el = panel.querySelector(`[data-room="${id}"]`);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function resetDesign() {
    roomColors.clear();
    roomTiles.clear();
    for (const [id, mesh] of roomFloorMeshes) {
      world.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      roomFloorMeshes.delete(id);
    }
    applyWallColors();
    updateCurrentLabels();
  }

  /* ------------------------------------------------------------ panel DOM */

  function buildPanel() {
    if (!panel) return;
    panel.innerHTML = `
      <div class="dp-head">
        <h2>تصميم الغرفة</h2>
        <button type="button" class="dp-close" data-dp="close" aria-label="إغلاق لوحة التصميم">✕</button>
      </div>
      <div class="dp-body">
        <p class="dp-selected">الغرفة المحددة: <strong data-slot="room-current">—</strong></p>
        <p class="dp-hint">اضغط على أي غرفة في المشهد لاختيارها</p>
        <div class="dp-rooms" role="group" aria-label="قائمة الغرف">
          ${rooms
            .map(
              (r) =>
                `<button type="button" class="dp-room" data-room="${r.id}" aria-pressed="false">${roomName(r.id)}</button>`
            )
            .join('')}
        </div>

        <section class="dp-section">
          <h3>لون الجدران <span class="dp-current" data-slot="wall-current">الافتراضي</span></h3>
          <div class="dp-swatches" role="group" aria-label="ألوان الجدران">
            ${WALL_COLORS.map(
              (c) => `<button type="button" class="dp-swatch" data-color="${c.hex}" aria-pressed="false" title="${c.label}">
                        <span class="dp-chip" style="background:${c.hex}"></span>
                        <span class="dp-swatch-label">${c.label}</span>
                      </button>`
            ).join('')}
          </div>
        </section>

        <section class="dp-section">
          <h3>بلاط الأرضيات <span class="dp-current" data-slot="tile-current">بدون بلاط</span></h3>
          <div class="dp-tiles" data-slot="tiles"></div>
        </section>
      </div>
      <div class="dp-foot">
        <button type="button" class="dp-reset" data-dp="reset">إعادة تعيين التصميم</button>
      </div>
    `;

    panel.addEventListener('click', (event) => {
      const target = event.target.closest('button');
      if (!target) return;
      if (target.dataset.dp === 'close') {
        setOpen(false);
        return;
      }
      if (target.dataset.dp === 'reset') {
        resetDesign();
        return;
      }
      if (target.dataset.room) {
        selectRoom(Number(target.dataset.room));
        return;
      }
      if (target.dataset.color) {
        if (!selectedRoom) selectRoom(rooms[0]?.id ?? null);
        if (!selectedRoom) return;
        roomColors.set(selectedRoom, target.dataset.color);
        applyWallColors();
        updateCurrentLabels();
        return;
      }
      if (target.dataset.tile) {
        const tile = tiles.find((t) => t.id === target.dataset.tile);
        if (!tile) return;
        if (!selectedRoom) selectRoom(rooms[0]?.id ?? null);
        if (!selectedRoom) return;
        applyTile(selectedRoom, tile);
      }
    });
  }

  function renderTileGallery(list) {
    const host = panel?.querySelector('[data-slot="tiles"]');
    if (!host) return;
    const groups = new Map();
    for (const tile of list) {
      if (!groups.has(tile.look)) groups.set(tile.look, []);
      groups.get(tile.look).push(tile);
    }
    host.innerHTML = [...groups.entries()]
      .map(
        ([look, items]) => `
        <div class="dp-tile-group">
          <h4>${look}</h4>
          <div class="dp-tile-grid">
            ${items
              .map(
                (tile) => `
              <button type="button" class="dp-tile" data-tile="${tile.id}" aria-pressed="false" title="${tile.look} · ${tile.model}">
                <img src="${tile.file}" alt="${tile.look} ${tile.model}" loading="lazy" decoding="async" />
                <span class="dp-tile-meta">
                  <span class="dp-tile-look">${tile.look}</span>
                  <span class="dp-tile-model">${tile.model}</span>
                </span>
              </button>`
              )
              .join('')}
          </div>
        </div>`
      )
      .join('');
  }

  /* ---------------------------------------------------------------- open */

  function setOpen(next) {
    open = next;
    if (panel) panel.hidden = !next;
    document.body.classList.toggle('design-open', next);
    if (openButton) openButton.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next && selectedRoom == null && rooms.length) selectRoom(rooms[0].id);
    updateCurrentLabels();
  }

  /* -------------------------------------------------------------- picking */

  let downPoint = null;
  let downTime = 0;
  let pointersDown = 0;
  let multiTouch = false;

  canvas.addEventListener('pointerdown', (event) => {
    pointersDown++;
    if (pointersDown > 1) multiTouch = true; // pinch/pan, never a pick
    if (event.isPrimary === false) return;
    downPoint = { x: event.clientX, y: event.clientY };
    downTime = performance.now();
  });

  const endPointer = () => {
    pointersDown = Math.max(0, pointersDown - 1);
    if (pointersDown === 0) multiTouch = false;
  };
  canvas.addEventListener('pointercancel', () => {
    endPointer();
    downPoint = null;
  });

  canvas.addEventListener('pointerup', (event) => {
    endPointer();
    if (multiTouch || !downPoint || event.isPrimary === false) {
      downPoint = null;
      return;
    }
    const dx = event.clientX - downPoint.x;
    const dy = event.clientY - downPoint.y;
    const moved = Math.hypot(dx, dy);
    const elapsed = performance.now() - downTime;
    downPoint = null;
    if (moved > 8 || elapsed > 700) return; // that was an orbit / pan, not a tap

    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(floorPlane, hit)) return;
    const gx = Math.round(hit.x / cell + cx);
    const gy = Math.round(hit.z / cell + cy);
    if (gx < 0 || gy < 0 || gx >= gridWidth || gy >= gridHeight) return;
    const id = labels[gy * gridWidth + gx];
    if (!id || id < 0) return;
    selectRoom(id, { scrollIntoView: false });
    if (!open) setOpen(true);
  });

  /* ----------------------------------------------------------------- boot */

  buildPanel();
  applyWallColors();

  fetch('assets/tiles/tiles.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('tiles.json ' + r.status))))
    .then((json) => {
      tiles = json.tiles || [];
      renderTileGallery(tiles);
      updateCurrentLabels();
    })
    .catch((err) => {
      console.warn('[design] tile catalogue unavailable', err);
      const host = panel?.querySelector('[data-slot="tiles"]');
      if (host) host.textContent = 'تعذّر تحميل معرض البلاط';
    });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    selectRoom,
    reset: resetDesign,
    floorFor: (id) => roomFloorMeshes.get(id) || null,
    screenPointForRoom: (id) => {
      const room = roomById(id);
      if (!room) return null;
      const v = new THREE.Vector3(toWorldX(room.center.x), 0.05, toWorldZ(room.center.y));
      v.project(camera);
      const rect = canvas.getBoundingClientRect();
      return {
        x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
        y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
      };
    },
    get selected() {
      return selectedRoom;
    },
    get state() {
      return {
        rooms: rooms.length,
        selected: selectedRoom,
        wallColors: Object.fromEntries(roomColors),
        tiles: Object.fromEntries([...roomTiles].map(([k, v]) => [k, v.id])),
        floors: roomFloorMeshes.size,
        open,
        tileCount: tiles.length,
      };
    },
  };
}
