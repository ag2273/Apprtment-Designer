import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { extractWalls } from './plan-extract.js';
import { detectRooms, assignWallsToRooms } from './rooms.js';
import { createDesigner } from './design.js';

const IMAGE_URL = 'assets/floorplan.jpg';

// The plan is drawn at 2400×1792 px. We map its long side to PLAN_WIDTH world
// units and keep wall height deliberately compressed — a full-height 2.7 m wall
// would hide the interior from every useful camera angle.
const PLAN_WIDTH = 24;
const WALL_HEIGHT = 2.6;
const WALL_PAD = 0.04; // world units added per side so thin lines read as walls
const WALL_BASE_COLOR = '#ece4d6';
const FLOOR_MARGIN_CELLS = 10;

const state = {
  ready: false,
  view: 'iso',
  walls: 0,
  rects: 0,
  wireframe: false,
  spin: false,
  errors: window.__errors || [],
  webgl: false,
};
window.__viewer = state;

const els = {
  canvas: document.getElementById('scene'),
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loading-text'),
  controls: document.querySelector('.controls'),
};

function setLoading(text) {
  if (els.loadingText) els.loadingText.textContent = text;
  if (els.loading) els.loading.hidden = false;
}
function hideLoading() {
  if (els.loading) els.loading.hidden = true;
}
function setStatus(text, kind = 'ok') {
  if (els.statusText) els.statusText.textContent = text;
  if (els.status) els.status.dataset.kind = kind;
  state.status = text;
}

/* -------------------------------------------------------------------------- */
/* scene                                                                      */
/* -------------------------------------------------------------------------- */

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas: els.canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
} catch (err) {
  setLoading('متصفحك لا يدعم WebGL.');
  throw err;
}
state.webgl = true;

// Small read-only probe used by the smoke test / debugging in devtools.
state.camera = () => ({
  pos: camera.position.toArray(),
  target: controls.target.toArray(),
  dist: camera.position.distanceTo(controls.target),
  autoRotate: controls.autoRotate,
  wireframe: wallMesh ? Boolean(wallMesh.material.wireframe) : null,
  triangles: renderer.info.render.triangles,
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = null;

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.rotateSpeed = 0.85;
controls.zoomSpeed = 0.8;
controls.panSpeed = 0.8;
controls.minDistance = 3;
controls.maxDistance = 120;
controls.maxPolarAngle = Math.PI / 2 - 0.02; // never below the floor slab
controls.autoRotateSpeed = 0.7;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

const hemi = new THREE.HemisphereLight(0xdfe9ff, 0x151a22, 0.75);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xfff3e2, 1.75);
key.position.set(19, 30, 14);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 90;
key.shadow.camera.left = -26;
key.shadow.camera.right = 26;
key.shadow.camera.top = 26;
key.shadow.camera.bottom = -26;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key);

const fill = new THREE.DirectionalLight(0x9dc0ff, 0.45);
fill.position.set(-22, 14, -16);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xffd9b8, 0.35);
rim.position.set(0, 8, 30);
scene.add(rim);

/* -------------------------------------------------------------------------- */
/* model                                                                      */
/* -------------------------------------------------------------------------- */

const world = new THREE.Group();
scene.add(world);

let wallMesh = null;
let designer = null;
let wallRooms = [];
let floorMesh = null;
let slab = null;
let planSize = { w: PLAN_WIDTH, d: PLAN_WIDTH };

function disposeObject(obj) {
  if (!obj) return;
  obj.geometry?.dispose();
  if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
  else obj.material?.dispose();
  world.remove(obj);
}

/**
 * Merge every wall rectangle into one BufferGeometry: one box per rectangle,
 * 24 vertices (per-face normals) and 36 indices. A few thousand boxes stay a
 * single draw call.
 */
function buildWallGeometry(rects, gridW, gridH, cell, offsetX, offsetY) {
  const per = 24;
  const positions = new Float32Array(rects.length * per * 3);
  const normals = new Float32Array(rects.length * per * 3);
  const colors = new Float32Array(rects.length * per * 3);
  const indices = new Uint32Array(rects.length * 36);

  const faces = [
    { n: [1, 0, 0], v: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { n: [-1, 0, 0], v: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { n: [0, 1, 0], v: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
    { n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { n: [0, 0, 1], v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { n: [0, 0, -1], v: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  ];
  const quadIndex = [0, 1, 2, 0, 2, 3];

  let vp = 0;
  let np = 0;
  let ip = 0;
  let vbase = 0;

  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const x0 = (r.x - offsetX) * cell - WALL_PAD;
    const x1 = (r.x + r.w - offsetX) * cell + WALL_PAD;
    const z0 = (r.y - offsetY) * cell - WALL_PAD;
    const z1 = (r.y + r.h - offsetY) * cell + WALL_PAD;
    const y0 = 0;
    const y1 = WALL_HEIGHT;

    for (let f = 0; f < faces.length; f++) {
      const face = faces[f];
      for (let c = 0; c < 4; c++) {
        const corner = face.v[c];
        positions[vp++] = corner[0] ? x1 : x0;
        positions[vp++] = corner[1] ? y1 : y0;
        positions[vp++] = corner[2] ? z1 : z0;
        normals[np++] = face.n[0];
        normals[np++] = face.n[1];
        normals[np++] = face.n[2];
      }
      for (let q = 0; q < 6; q++) indices[ip++] = vbase + quadIndex[q];
      vbase += 4;
    }
  }

  const base = new THREE.Color(WALL_BASE_COLOR);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = base.r;
    colors[i + 1] = base.g;
    colors[i + 2] = base.b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return { geometry: geo, colors };
}

async function buildModel() {
  setLoading('جارِ قراءة مخطط الشقة…');
  let analysis;
  try {
    analysis = await extractWalls(IMAGE_URL);
  } catch (err) {
    console.error('[viewer] wall extraction failed', err);
    state.errors.push('wall extraction: ' + (err && err.message));
    // Clean fallback: flat textured plan, still fully navigable.
    await buildFloorOnly();
    setStatus('عرض مسطّح — تعذّر استخراج الجدران', 'warn');
    hideLoading();
    state.ready = true;
    return;
  }

  setLoading('جارِ بناء الجدران ثلاثية الأبعاد…');
  const { rects, bounds, gridWidth, gridHeight, imageWidth, imageHeight } = analysis;
  const cell = PLAN_WIDTH / gridWidth;
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;

  disposeObject(wallMesh);
  disposeObject(floorMesh);
  disposeObject(slab);

  // --- walls ----------------------------------------------------------------
  const built = buildWallGeometry(rects, gridWidth, gridHeight, cell, cx, cy);
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.75,
    metalness: 0.03,
  });
  wallMesh = new THREE.Mesh(built.geometry, wallMat);
  wallMesh.userData.colors = built.colors;
  wallMesh.userData.baseColor = WALL_BASE_COLOR;
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  wallMesh.name = 'walls';
  world.add(wallMesh);

  // --- floor: the plan texture itself ---------------------------------------
  const tex = await loadTexture(IMAGE_URL);
  const m = FLOOR_MARGIN_CELLS;
  const fx = Math.max(0, bounds.x - m);
  const fy = Math.max(0, bounds.y - m);
  const fw = Math.min(gridWidth - fx, bounds.w + 2 * m);
  const fh = Math.min(gridHeight - fy, bounds.h + 2 * m);

  tex.repeat.set(fw / gridWidth, fh / gridHeight);
  tex.offset.set(fx / gridWidth, 1 - (fy + fh) / gridHeight);

  const floorW = fw * cell;
  const floorD = fh * cell;
  const floorGeo = new THREE.PlaneGeometry(floorW, floorD);
  const floorMat = new THREE.MeshStandardMaterial({
    map: tex,
    color: 0xf7f3ea,
    roughness: 0.95,
    metalness: 0,
    emissive: 0xffffff,
    emissiveMap: tex,
    emissiveIntensity: 0.05,
  });
  floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.set((fx + fw / 2 - cx) * cell, 0.004, (fy + fh / 2 - cy) * cell);
  floorMesh.receiveShadow = true;
  floorMesh.name = 'floor';
  world.add(floorMesh);

  // --- base slab ------------------------------------------------------------
  const slabGeo = new THREE.BoxGeometry(floorW + 0.9, 0.55, floorD + 0.9);
  const slabMat = new THREE.MeshStandardMaterial({ color: 0x1b212b, roughness: 0.9, metalness: 0.05 });
  slab = new THREE.Mesh(slabGeo, slabMat);
  slab.position.copy(floorMesh.position);
  slab.position.y = -0.28;
  slab.receiveShadow = true;
  slab.name = 'slab';
  world.add(slab);

  planSize = { w: floorW, d: floorD };

  state.walls = analysis.stats.keptComponents;
  state.rects = rects.length;
  state.analysis = {
    grid: [gridWidth, gridHeight],
    image: [imageWidth, imageHeight],
    rects: rects.length,
    wallComponents: analysis.stats.keptComponents,
    minRun: analysis.stats.minRun,
    closeRadius: analysis.stats.closeRadius,
  };

  // --- rooms + per-room design ---------------------------------------------
  let roomData = null;
  try {
    const detected = detectRooms(analysis.wallMask, gridWidth, gridHeight, {
      sealRadius: Math.round(0.037 * gridWidth),
    });
    if (detected.rooms.length >= 2) {
      roomData = detected;
    } else {
      console.warn('[viewer] room detection found too few rooms, using one room');
    }
  } catch (err) {
    console.warn('[viewer] room detection failed', err);
  }
  if (!roomData) {
    // graceful fallback: one room spanning the whole plan
    const labels = new Int32Array(gridWidth * gridHeight);
    const rects1 = [{ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }];
    for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
      for (let x = bounds.x; x < bounds.x + bounds.w; x++) labels[y * gridWidth + x] = 1;
    }
    roomData = {
      rooms: [{ id: 1, rects: rects1, cells: bounds.w * bounds.h, bbox: bounds, center: { x: 0, y: 0 } }],
      labels,
      fallback: true,
    };
  }
  state.rooms = roomData.rooms.length;
  state.roomsFallback = Boolean(roomData.fallback);
  state.roomDetail = roomData.rooms.map((r) => ({ id: r.id, area: r.cells, rects: r.rects.length }));

  wallRooms = assignWallsToRooms(rects, roomData.labels, gridWidth, gridHeight);
  designer = createDesigner({
    world,
    camera,
    canvas: renderer.domElement,
    renderer,
    wallMesh,
    rooms: roomData.rooms,
    labels: roomData.labels,
    wallRooms,
    cell,
    cx,
    cy,
    gridWidth,
    gridHeight,
    imageAspect: imageHeight / imageWidth,
  });
  state.design = () => designer.state;
  state.wallColorStats = () => {
    const c = wallMesh.geometry.attributes.color.array;
    const base = new THREE.Color(WALL_BASE_COLOR);
    let changed = 0;
    for (let i = 0; i < c.length; i += 72) {
      if (
        Math.abs(c[i] - base.r) > 0.004 ||
        Math.abs(c[i + 1] - base.g) > 0.004 ||
        Math.abs(c[i + 2] - base.b) > 0.004
      ) {
        changed++;
      }
    }
    return { total: c.length / 72, changed };
  };
  state.wallRoomsFor = (id) => wallRooms.filter((list) => list.some((b) => b.room === id)).length;
  state.floorFor = (id) => (designer ? designer.floorFor(id) : null);
  state.roomScreenPoint = (id) => (designer ? designer.screenPointForRoom(id) : null);
  state.world = () => world;

  key.shadow.camera.left = -planSize.w * 0.8;
  key.shadow.camera.right = planSize.w * 0.8;
  key.shadow.camera.top = planSize.d * 0.9;
  key.shadow.camera.bottom = -planSize.d * 0.9;
  key.shadow.camera.updateProjectionMatrix();

  setStatus(`الجدران: ${rects.length} · الغرف: ${roomData.rooms.length}`, 'ok');
  hideLoading();
  state.ready = true;
  goHome(0);
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        resolve(tex);
      },
      undefined,
      () => reject(new Error('Could not load floor texture'))
    );
  });
}

async function buildFloorOnly() {
  disposeObject(wallMesh);
  disposeObject(floorMesh);
  disposeObject(slab);
  const img = await loadPlanImage();
  const tex = await loadTexture(IMAGE_URL);
  const aspect = (img.naturalHeight || 1792) / (img.naturalWidth || 2400);
  const floorW = PLAN_WIDTH;
  const floorD = PLAN_WIDTH * aspect;
  const geo = new THREE.PlaneGeometry(floorW, floorD);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 });
  floorMesh = new THREE.Mesh(geo, mat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = 0.004;
  floorMesh.receiveShadow = true;
  world.add(floorMesh);

  const slabGeo = new THREE.BoxGeometry(floorW + 0.9, 0.55, floorD + 0.9);
  slab = new THREE.Mesh(
    slabGeo,
    new THREE.MeshStandardMaterial({ color: 0x1b212b, roughness: 0.9 })
  );
  slab.position.y = -0.28;
  world.add(slab);

  planSize = { w: floorW, d: floorD };
  state.walls = 0;
  state.rects = 0;
  goHome(0);
}

function loadPlanImage() {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('floor plan image missing'));
    img.src = IMAGE_URL;
  });
}

/* -------------------------------------------------------------------------- */
/* camera views                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Distance at which the whole plan (floor box + wall tops) fits the viewport,
 * found by projecting the bounding-box corners and scaling the distance.
 * Used instead of a fixed camera offset so it is correct on any aspect ratio.
 */
function framedDistance(dir, target, margin = 0.78) {
  const probe = camera.clone();
  const pts = [];
  const hw = planSize.w / 2;
  const hd = planSize.d / 2;
  for (const x of [-hw, hw]) {
    for (const y of [0, WALL_HEIGHT]) {
      for (const z of [-hd, hd]) pts.push(new THREE.Vector3(x, y, z));
    }
  }
  let dist = Math.max(planSize.w, planSize.d) * 2.5;
  for (let i = 0; i < 24; i++) {
    probe.position.copy(dir).multiplyScalar(dist).add(target);
    probe.lookAt(target);
    probe.updateMatrixWorld(true);
    let m = 0;
    for (const p of pts) {
      const v = p.clone().project(probe);
      m = Math.max(m, Math.abs(v.x), Math.abs(v.y));
    }
    if (Math.abs(m - margin) < 0.005) break;
    dist *= m / margin;
  }
  return dist;
}

const VIEW_DIRS = {
  iso: new THREE.Vector3(0.8, 1.5, 1.05),
  top: new THREE.Vector3(0, 1, 0.0008),
  front: new THREE.Vector3(0, 0.26, 1),
  side: new THREE.Vector3(1, 0.26, 0),
};

// On a portrait phone the plan's long axis should run up the screen, not across,
// otherwise most of the width is wasted and the model ends up tiny.
const VIEW_DIRS_PORTRAIT = {
  iso: new THREE.Vector3(1, 1.15, 0.04),
  top: new THREE.Vector3(0, 1, 0.0008),
  front: new THREE.Vector3(0, 0.26, 1),
  side: new THREE.Vector3(1, 0.26, 0),
};

function viewFor(view) {
  const set = camera.aspect < 0.9 ? VIEW_DIRS_PORTRAIT : VIEW_DIRS;
  const dir = (set[view] || set.iso).clone().normalize();
  const target = new THREE.Vector3(0, view === 'top' ? 0 : 0.35, 0);
  const dist = framedDistance(dir, target, camera.aspect < 0.9 ? 0.9 : 0.8);
  return { pos: dir.multiplyScalar(dist).add(target), target };
}

let tween = null;

function flyTo(view, ms = 700) {
  const spec = viewFor(view);
  state.view = view;
  tween = {
    fromPos: camera.position.clone(),
    toPos: spec.pos,
    fromTarget: controls.target.clone(),
    toTarget: spec.target,
    start: performance.now(),
    ms,
  };
}

function goHome(ms = 700) {
  flyTo('iso', ms);
}

// Re-frame the model when the viewport changes, until the user takes over.
let userMoved = false;
controls.addEventListener('start', () => {
  userMoved = true;
  tween = null;
});

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function zoomBy(factor) {
  const offset = camera.position.clone().sub(controls.target);
  const len = offset.length() * factor;
  const clamped = Math.min(controls.maxDistance, Math.max(controls.minDistance, len));
  offset.setLength(clamped);
  camera.position.copy(controls.target).add(offset);
  controls.update();
}

/* -------------------------------------------------------------------------- */
/* ui                                                                         */
/* -------------------------------------------------------------------------- */

const toggleButtons = {
  spin: els.controls?.querySelector('[data-action="spin"]'),
  wire: els.controls?.querySelector('[data-action="wire"]'),
};

function setPressed(btn, on) {
  if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function handleAction(action) {
  switch (action) {
    case 'reset':
      goHome();
      break;
    case 'iso':
    case 'top':
    case 'front':
    case 'side':
      flyTo(action);
      break;
    case 'zoom-in':
      zoomBy(0.78);
      break;
    case 'zoom-out':
      zoomBy(1.28);
      break;
    case 'spin':
      state.spin = !state.spin;
      controls.autoRotate = state.spin;
      setPressed(toggleButtons.spin, state.spin);
      break;
    case 'design':
      if (designer) designer.toggle();
      break;
    case 'wire':
      if (wallMesh) {
        state.wireframe = !state.wireframe;
        wallMesh.material.wireframe = state.wireframe;
        setPressed(toggleButtons.wire, state.wireframe);
      }
      break;
    default:
      break;
  }
}

if (els.controls) {
  els.controls.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    handleAction(btn.dataset.action);
  });
}

els.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// keyboard shortcuts (desktop nicety, no hover-only UI)
window.addEventListener('keydown', (e) => {
  if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
  const map = { r: 'reset', t: 'top', f: 'front', s: 'side', '3': 'iso' };
  if (map[e.key]) handleAction(map[e.key]);
  else if (e.key === '+' || e.key === '=') handleAction('zoom-in');
  else if (e.key === '-') handleAction('zoom-out');
});

/* -------------------------------------------------------------------------- */
/* loop                                                                       */
/* -------------------------------------------------------------------------- */

function resize() {
  const w = els.canvas.clientWidth || window.innerWidth;
  const h = els.canvas.clientHeight || window.innerHeight;
  if (!w || !h) return;
  camera.aspect = w / h;

  // A narrow phone sees a very narrow horizontal slice at 42°, so open it up.
  camera.fov = camera.aspect < 0.9 ? 46 : 42;

  // The control bar covers the bottom of the viewport and the title the top;
  // shift the projection so the model centres in the space between them.
  const barH = els.controls ? els.controls.getBoundingClientRect().height : 0;
  const topH = document.querySelector('.topbar')?.getBoundingClientRect().height || 0;
  const shift = Math.max(-h * 0.18, Math.min(h * 0.18, (barH - topH) / 2));
  if (Math.abs(shift) > 6) camera.setViewOffset(w, h, 0, shift, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();

  renderer.setSize(w, h, false);
  if (state.ready && !userMoved) flyTo(state.view, 0);
}

window.addEventListener('resize', resize);
if (window.ResizeObserver) new ResizeObserver(resize).observe(els.canvas);

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();

  if (tween) {
    const t = Math.min(1, (now - tween.start) / Math.max(1, tween.ms));
    const k = easeInOut(t);
    camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
    controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
    if (t >= 1) tween = null;
  }

  controls.update();
  renderer.render(scene, camera);
}

/* -------------------------------------------------------------------------- */
/* boot                                                                       */
/* -------------------------------------------------------------------------- */

resize();
// Sensible camera before the model exists, so the first frame is not a black hole.
camera.position.set(PLAN_WIDTH * 0.9, PLAN_WIDTH * 0.85, PLAN_WIDTH * 1.15);
controls.target.set(0, 0.8, 0);
controls.update();
animate();

buildModel().catch((err) => {
  console.error('[viewer] build failed', err);
  state.errors.push('build: ' + (err && err.message));
  setStatus('تعذّر بناء النموذج ثلاثي الأبعاد', 'error');
  hideLoading();
});
