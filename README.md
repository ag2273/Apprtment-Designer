# Apartment Design — 3D Viewer

A single-page, static 3D viewer for the apartment floor plan. No build step, no
dependencies installed locally — Three.js comes from a CDN, everything else is
plain HTML/CSS/JS.

Orbit, pan and zoom with a mouse or a touchscreen. The plan is extruded into
walls by analysing the drawing in the browser, and the original drawing stays on
the floor so nothing is lost.

## Run it

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Any static host works, including GitHub Pages (the repo root is the site root).
Opening `index.html` straight from the filesystem will not work: ES modules and
the image read need `http(s)://`.

## Design mode

The **تصميم** button opens a panel (a side panel on desktop, a bottom sheet on
phones) that designs one room at a time:

- **Rooms** — detected from the plan (7 on this drawing). Pick one from the list
  or tap it in the 3D view; the picked room is tinted and named in the panel.
- **Walls** — 16 wall colours. Applying one recolours only the walls that touch
  that room; the rest of the plan keeps the default colour.
- **Floors** — 28 ceramic tiles from two manufacturers (كليوباترا / Cleopatra and
  رويال سيراميكا / Royal Ceramica), grouped by brand and then by look
  (رخام / حجر / أسمنتي / تيرازو / خشب / لون / نقش / ديكور), with the brand on every
  tile. The room gets a tiled floor mesh while the original drawing stays on the
  floor everywhere else.
- **إعادة تعيين التصميم** clears every colour and tile.

Tile photos: public product catalogue images from Ceramica Cleopatra
(cleopatraceramics.com) and Royal Ceramica, used here as swatches for a personal
design preview — verify usage rights before any commercial use.

## Controls

| Button | What it does |
| --- | --- |
| **تصميم** | Open the per-room design panel |
| **Reset** | Back to the default perspective view |
| **3D** | Perspective (dollhouse) view |
| **Top** | Top-down view (best for reading the plan) |
| **Front** / **Side** | Elevation views |
| **Zoom + / −** | Dolly in / out |
| **Spin** | Toggle auto-rotate |
| **Wire** | Toggle wireframe walls |

Direct manipulation: drag to orbit, scroll/pinch to zoom, two fingers or
right-drag to pan. Keyboard: `R` reset, `T` top, `F` front, `S` side, `3`
perspective, `+` / `-` zoom.

## Files

```
index.html          markup, import map for Three.js, control bar
css/styles.css      layout, mobile-first control bar, dark UI
js/main.js          scene, lights, camera views, controls, UI wiring
js/plan-extract.js  floor plan image → wall rectangles (no deps)
js/rooms.js         wall mask → rooms, plus wall↔room adjacency
js/design.js        per-room wall colours + tiled floors, design panel
assets/floorplan.jpg  the source drawing (2400×1792)
assets/tiles/       28 tile photos (cleopatra/ + royal/) + tiles.json manifest
```

## How the walls are extracted

`js/plan-extract.js` runs the whole pipeline in the browser on a canvas:

1. **Adaptive threshold** (local mean − 16) so faint gray lines survive JPEG
   falloff, at a 1200 px working width.
2. **Morphological closing** — walls are drawn as double lines with a hollow
   core, so closing fills them into solid bands.
3. **Long-run filter** — only horizontal/vertical runs longer than ~35 px are
   kept. This removes the Arabic room labels, door swing arcs, dimension marks
   and furniture symbols, which are all shorter or curved.
4. **Component filter** — keeps large wall networks plus large hollow outlines
   (an isolated room such as the storeroom is a thin loop, not a solid blob),
   and drops leftover glyph fragments.
5. **Greedy rectangle merge** — the pixel mask becomes ~170 axis-aligned
   rectangles, each drawn as one box in a single merged `BufferGeometry`
   (one draw call).

Nothing is pre-baked: the geometry is regenerated from the JPEG every load, so
replacing `assets/floorplan.jpg` with another drawing of the same style rebuilds
the model.

### Rooms

`js/rooms.js` dilates the wall mask by roughly half a door width, which plugs
the door openings in a sealed copy; flood filling that copy gives the rooms.
Regions that touch the image border (the outside of the apartment) or that are
too small are dropped, then the labels are grown back over the raw free space so
the rooms recover the area the dilation ate and doorways are split between the
two rooms they join. Each room is decomposed into rectangles again, which gives
cheap floor geometry and a picking map.

Wall colour is written into the wall geometry's vertex-colour buffer (one
`needsUpdate` per change, still a single draw call). A wall between two rooms
takes the colour of the room it touches most; if that room has no colour yet it
falls back to the other side, and with no coloured neighbour it stays default.

## Decisions and assumptions

- **Wall height is compressed** (2.6 units against a 24-unit-wide plan). Full
  height would hide the interior from any useful camera angle.
- **Walls are padded ~4 cm** in world space so the thin linework reads as a wall
  rather than a sheet of paper.
- **Portrait screens rotate the default view** so the plan's long side runs up
  the screen; otherwise a phone wastes most of its width. The **Top** button
  always faces the plan the right way up for reading labels.
- The camera auto-frames the model by projecting the bounding box, and shifts
  the projection so the model sits between the title and the control bar.
- **Fallback:** if extraction throws, the page still renders the flat textured
  plan with the same controls and says so in the status pill, instead of failing
  to load.

## Verified

Served with `python3 -m http.server` and driven in headless Chrome (SwiftShader
WebGL): 29/29 checks pass on the design build — model renders with 166 wall
boxes / 2006 triangles and 7 detected rooms, the panel opens with 16 swatches and
28 tiles in 2 brand groups, a wall colour recolours only the selected room's walls (24 of 166
boxes), a tile creates a textured floor for that room only, tapping a room in
3D selects it, reset clears everything, every existing view/zoom/spin/wire
control still works, the 390 px layout has no horizontal overflow with ≥44 px
targets, and there are no console errors.
