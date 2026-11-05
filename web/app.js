import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const LOGMIN = Math.log(0.002), LOGMAX = Math.log(0.6);
const R = 6, S = 4.4, STACK = 11;
const $ = (s) => document.querySelector(s);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);
const easeInOut = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a, b, x) => ease(clamp((x - a) / (b - a)));
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// pastel palettes, matte like painted clay
const PALETTES = [
  { name: 'SUPPORT', by: 'support', stops: ['#e99a94', '#f2c39b', '#f1e2a6', '#b7d7b0', '#9cc3e4'] },
  { name: 'N → C', by: 'position', stops: ['#c4b6e6', '#a6cbec', '#afdfcb', '#f2d9a3', '#efb0b6'] },
  { name: 'CONSERVATION', by: 'entropy', stops: ['#ece2d3', '#e2bfa9', '#c6a3c0', '#929fc4'] },
];
let pal = 0;

const st = { mode: 'fold', D: null, L: 0, N: 0, t: 0, tTo: 0, draw: 0, drawStart: 0, hover: -1, hoverLayer: -1, contacts: true, spin: !REDUCED };

// ─── renderer ────────────────────────────────────────────────────────
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const BG = new THREE.Color(css('--field') || '#f1ede7');
scene.fog = new THREE.Fog(BG, 20, 60);
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.06;
controls.autoRotate = st.spin; controls.autoRotateSpeed = 1.4; // ≈ 45 s per turn
controls.minDistance = 5; controls.maxDistance = 70;

// soft daylight: a sky/ground fill, a warm key that casts shadows, a cool kick from behind
scene.add(new THREE.HemisphereLight('#ffffff', '#d8cdc1', 1.55));
const sun = new THREE.DirectionalLight('#fff3e6', 2.1);
sun.position.set(9, 18, 11); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 70 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 6;
scene.add(sun);
const fill = new THREE.DirectionalLight('#e3ebff', 0.55); fill.position.set(-10, 4, -8); scene.add(fill);

const world = new THREE.Group(); scene.add(world);
const U = { uDotOp: { value: 1 }, uDraw: { value: 0 }, uL: { value: 1 }, uHover: { value: -1 }, uScale: { value: 1 },
            uNear: { value: 20 }, uFar: { value: 60 }, uBg: { value: BG.clone() }, uInk: { value: new THREE.Color('#4b4f60') } };

// custom shaders fade into the paper the same way the built-in fog does
const FOG = /* glsl */`
  uniform float uNear, uFar; uniform vec3 uBg;
  vec3 fogMix(vec3 c, float z) { return mix(c, uBg, smoothstep(uNear, uFar, z) * 0.9); }`;

// ─── materials ───────────────────────────────────────────────────────
const tubeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0, transparent: true });

// residues: matte beads (sphere impostors, lit like the clay around them)
const dotMat = new THREE.ShaderMaterial({
  uniforms: U, transparent: true, depthWrite: true,
  vertexShader: /* glsl */`
    attribute vec3 color; attribute float size; attribute float alpha; attribute float res;
    uniform float uScale, uDraw, uL, uHover;
    varying vec3 vColor; varying float vA; varying float vHi; varying float vZ;
    void main() {
      vColor = color;
      vHi = 1.0 - step(0.5, abs(res - uHover));
      float drawn = 1.0 - smoothstep(uDraw * (uL + 8.0) - 8.0, uDraw * (uL + 8.0), res);
      vA = alpha * drawn;
      vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z;
      gl_PointSize = size * (1.0 + 0.6 * vHi) * uScale / -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uDotOp; uniform vec3 uInk; ${FOG}
    varying vec3 vColor; varying float vA; varying float vHi; varying float vZ;
    void main() {
      vec2 c = gl_PointCoord * 2.0 - 1.0; c.y = -c.y; float r2 = dot(c, c);
      if (r2 > 1.0 || vA < 0.01 || uDotOp < 0.01) discard;
      vec3 n = vec3(c, sqrt(1.0 - r2));
      float lam = 0.62 + 0.38 * max(dot(n, normalize(vec3(-0.35, 0.6, 0.72))), 0.0);
      vec3 col = vColor * lam * (1.0 - smoothstep(0.7, 1.0, r2) * 0.1);
      col = mix(col, uInk, vHi * smoothstep(0.5, 0.75, r2));
      gl_FragColor = vec4(fogMix(col, vZ), vA * uDotOp);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});

// contacts: pencil-thin arcs
const arcMat = new THREE.ShaderMaterial({
  uniforms: { ...U, uOpacity: { value: 1 }, uTint: { value: new THREE.Color('#8f93a6') } },
  transparent: true, depthWrite: false,
  vertexShader: /* glsl */`
    attribute float aP; attribute vec2 aIJ;
    uniform float uHover; varying float vP; varying float vHi; varying float vZ;
    void main() {
      vP = aP;
      vHi = max(1.0 - step(0.5, abs(aIJ.x - uHover)), 1.0 - step(0.5, abs(aIJ.y - uHover)));
      vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uOpacity, uHover; uniform vec3 uTint, uInk; ${FOG}
    varying float vP; varying float vHi; varying float vZ;
    void main() {
      float a = (0.1 + 0.3 * vP * vP);
      if (uHover >= 0.0) a = mix(a * 0.3, 0.85, vHi);
      gl_FragColor = vec4(fogMix(mix(uTint, uInk, vHi), vZ), a * uOpacity);
      #include <colorspace_fragment>
    }`,
});

const flatLine = (color) => new THREE.LineBasicMaterial({ color, vertexColors: !color, transparent: true, depthWrite: false });

// ─── labels ──────────────────────────────────────────────────────────
const labelsEl = $('#labels'); let labels = [];
function addLabel(text, pos, group, cls = '') {
  const el = document.createElement('div'); el.textContent = text; if (cls) el.className = cls;
  labelsEl.appendChild(el); const L = { el, pos: pos.clone(), group, dx: 8, dy: -6 }; labels.push(L); return L;
}
const _v = new THREE.Vector3();
function placeLabels(explA) {
  for (const L of labels) {
    const a = L.group === 'expl' ? explA * 0.8 : 1;
    if (L.hidden || a < 0.02) { L.el.style.opacity = 0; continue; }
    _v.copy(L.pos).project(camera);
    if (_v.z > 1) { L.el.style.opacity = 0; continue; }
    L.el.style.opacity = a;
    L.el.style.transform = `translate(${((_v.x + 1) / 2 * innerWidth).toFixed(1)}px, ${((1 - _v.y) / 2 * innerHeight).toFixed(1)}px) translate(${L.dx}px, ${L.dy}px)`;
  }
}

// ─── colour ──────────────────────────────────────────────────────────
function value(i) {
  const D = st.D, by = PALETTES[pal].by;
  if (by === 'support') return support(i);
  if (by === 'entropy') return clamp(1 - D.entropy[i] / Math.log2(20));
  return st.L > 1 ? i / (st.L - 1) : 0;
}
const support = (i) => { const v = st.D.logp_wt[i]; return v == null ? 0.5 : clamp((v - LOGMIN) / (LOGMAX - LOGMIN)); };
function ramp(t, out = new THREE.Color()) {
  const s = PALETTES[pal].stops.map((h) => new THREE.Color(h)), n = s.length - 1;
  const k = Math.min(n - 1, Math.floor(t * n));
  return out.copy(s[k]).lerp(s[k + 1], t * n - k);
}

// ─── build ───────────────────────────────────────────────────────────
let G = {};
const keep = new Set([tubeMat, dotMat, arcMat]);
function dispose() {
  world.traverse((o) => { o.geometry?.dispose(); if (o.material && !keep.has(o.material)) o.material.dispose(); });
  world.clear(); labelsEl.innerHTML = ''; labels = [];
}
// a deep model's 33 layers would be mush; show ~12 evenly spaced sheets
const G0 = { ids: [] };
function pickLayers(n) { const m = Math.min(n, 12); return [...new Set(Array.from({ length: m + 1 }, (_, j) => Math.round((j * n) / m)))]; }
const layerY = (k) => -STACK / 2 + (k * STACK) / st.N;

function build(D) {
  dispose();
  st.D = D; st.L = D.seq.length; st.hover = -1;
  const ids = pickLayers(D.n_layers); G0.ids = ids; st.layers = ids.map((k) => D.layers2d[k]); st.N = ids.length - 1;
  const L = st.L, N = st.N;
  const base = clamp(0.3 * Math.sqrt(76 / L), 0.08, 0.3);
  G = { base, gain: clamp(Math.sqrt(110 / L), 0.3, 1) };
  U.uL.value = L; U.uHover.value = -1;

  const P = D.emb3d.map((p) => new THREE.Vector3(p[0] * R, p[1] * R, p[2] * R));
  G.P = P;

  // the chain: a matte clay tube
  const curve = new THREE.CatmullRomCurve3(P, false, 'centripetal', 0.5);
  const segs = Math.min(L * 10, 12000), radial = 14;
  const tube = new THREE.TubeGeometry(curve, segs, Math.max(base * 0.34, 0.05), radial, false);
  tube.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tube.attributes.position.count * 3), 3));
  G.tube = new THREE.Mesh(tube, tubeMat); G.tube.castShadow = true; G.tubeMeta = { segs, radial };
  world.add(G.tube);

  // a floor that only shows the shadow
  const bb = new THREE.Box3().setFromPoints(P);
  G.floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.11, transparent: true }));
  G.floor.rotation.x = -Math.PI / 2; G.floor.position.y = bb.min.y - 1.4; G.floor.receiveShadow = true;
  world.add(G.floor);

  // contacts
  const C = D.contacts, segA = 22;
  const cpos = new Float32Array(C.length * segA * 6), cp = new Float32Array(C.length * segA * 2), cij = new Float32Array(C.length * segA * 4);
  const q = new THREE.Vector3(), q2 = new THREE.Vector3(), cent = new THREE.Vector3();
  P.forEach((p) => cent.add(p)); cent.multiplyScalar(1 / L);
  C.forEach(([i, j, p], k) => {
    const a = P[i], b = P[j], m = a.clone().add(b).multiplyScalar(0.5), d = a.distanceTo(b);
    const ctrl = m.clone().add(m.clone().sub(cent).normalize().multiplyScalar(0.4 + d * 0.45));
    const bez = (t, o) => o.set(0, 0, 0).addScaledVector(a, (1 - t) ** 2).addScaledVector(ctrl, 2 * (1 - t) * t).addScaledVector(b, t * t);
    for (let s = 0; s < segA; s++) {
      const o = k * segA + s;
      bez(s / segA, q); bez((s + 1) / segA, q2);
      cpos.set([q.x, q.y, q.z, q2.x, q2.y, q2.z], o * 6); cp.set([p, p], o * 2); cij.set([i, j, i, j], o * 4);
    }
  });
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(cpos, 3));
  cg.setAttribute('aP', new THREE.BufferAttribute(cp, 1));
  cg.setAttribute('aIJ', new THREE.BufferAttribute(cij, 2));
  G.arcs = new THREE.LineSegments(cg, arcMat); G.arcs.frustumCulled = false;
  world.add(G.arcs);

  // residues across all layers (layer N doubles as the fold's beads)
  const nn = (N + 1) * L;
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nn * 3), 3));
  pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nn * 3), 3));
  pg.setAttribute('size', new THREE.BufferAttribute(new Float32Array(nn), 1));
  pg.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(nn), 1));
  const res = new Float32Array(nn); for (let k = 0; k <= N; k++) for (let i = 0; i < L; i++) res[k * L + i] = i;
  pg.setAttribute('res', new THREE.BufferAttribute(res, 1));
  G.dots = new THREE.Points(pg, dotMat); G.dots.frustumCulled = false; G.dots.renderOrder = 2;
  world.add(G.dots);

  // exploded: chains, threads, paper sheets
  const seg = (count, colored) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    if (colored) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    return g;
  };
  G.chain = new THREE.LineSegments(seg((N + 1) * (L - 1), true), flatLine()); G.chain.frustumCulled = false;
  G.threads = new THREE.LineSegments(seg(N * L, false), flatLine('#b9b1a7')); G.threads.frustumCulled = false;
  const hl = new THREE.BufferGeometry(); hl.setAttribute('position', new THREE.BufferAttribute(new Float32Array((N + 1) * 3), 3));
  G.hl = new THREE.Line(hl, new THREE.LineBasicMaterial({ color: '#4b4f60', transparent: true, depthTest: false })); G.hl.renderOrder = 5;
  world.add(G.chain, G.threads, G.hl);
  G.sheets = [];
  const half = S * 1.14, corners = [[-half, -half], [half, -half], [half, half], [-half, half]];
  for (let k = 0; k <= N; k++) {
    const y = layerY(k);
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true }));
    fill.rotation.x = -Math.PI / 2; fill.position.y = y; fill.renderOrder = -1;
    const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners.map(([x, z]) => new THREE.Vector3(x, y, z))),
      flatLine(k === N ? '#8c8478' : '#cfc7bc'));
    world.add(fill, edge); G.sheets.push({ fill, edge, k });
    const lab = addLabel(`L${String(G0.ids[k]).padStart(2, '0')}`, new THREE.Vector3(-half, y, half), 'expl');
    lab.dx = -34; lab.dy = -7;
  }
  G.resLabel = addLabel('', new THREE.Vector3(), 'all', 'res'); G.resLabel.hidden = true;

  buildLand(D);
  colorize(); layout(true);
  st.draw = 0; st.drawStart = performance.now();
  caption();
}

function colorize() {
  if (!st.D) return;
  const L = st.L, N = st.N;
  const cols = Array.from({ length: L }, (_, i) => ramp(value(i)));
  const c = new THREE.Color();
  const tc = G.tube.geometry.attributes.color, { segs, radial } = G.tubeMeta;
  for (let s = 0; s <= segs; s++) {
    const f = (s / segs) * (L - 1), i = Math.floor(f), j = Math.min(L - 1, i + 1);
    c.copy(cols[i]).lerp(cols[j], f - i);
    for (let r = 0; r <= radial; r++) tc.setXYZ(s * (radial + 1) + r, c.r, c.g, c.b);
  }
  tc.needsUpdate = true;
  const dc = G.dots.geometry.attributes.color;
  for (let k = 0; k <= N; k++) for (let i = 0; i < L; i++) dc.setXYZ(k * L + i, cols[i].r, cols[i].g, cols[i].b);
  dc.needsUpdate = true;
  const cc = G.chain.geometry.attributes.color, dark = 0.78;
  for (let k = 0; k <= N; k++) for (let i = 0; i < L - 1; i++) {
    const o = (k * (L - 1) + i) * 2, a = cols[i], b = cols[i + 1];
    cc.setXYZ(o, a.r * dark, a.g * dark, a.b * dark); cc.setXYZ(o + 1, b.r * dark, b.g * dark, b.b * dark);
  }
  cc.needsUpdate = true;
  colorLand();
  $('#scaletxt').textContent = PALETTES[pal].name;
  $('#scale i').style.background = `linear-gradient(90deg, ${PALETTES[pal].stops.join(',')})`;
}

const _p = new THREE.Vector3();
function dotPos(k, i, t, out) {
  const l = st.layers[k][i], ex = l[0] * S, ez = l[1] * S;
  if (k === st.N) {
    const f = G.P[i], e = ease(t);
    return out.set(lerp(f.x, ex, e), lerp(f.y, layerY(k), e), lerp(f.z, ez, e));
  }
  const lag = clamp(t * 1.25 - 0.25 * (1 - k / st.N));
  return out.set(ex, lerp(layerY(st.N), layerY(k), easeInOut(lag)), ez);
}
function layout(force = false) {
  const L = st.L, N = st.N, t = st.t, g = G.dots.geometry.attributes;
  const bead = G.base * 1.15, dot = G.base * 0.7;
  for (let k = 0; k <= N; k++) {
    const vis = k === N ? 1 : smooth(0.05 + 0.25 * (1 - k / N), 0.55 + 0.25 * (1 - k / N), t);
    for (let i = 0; i < L; i++) {
      const n = k * L + i;
      dotPos(k, i, t, _p); g.position.setXYZ(n, _p.x, _p.y, _p.z);
      g.size.setX(n, k === N ? lerp(bead, dot * 1.2, ease(t)) : dot);
      g.alpha.setX(n, vis);
    }
  }
  g.position.needsUpdate = g.size.needsUpdate = g.alpha.needsUpdate = true;
  if (t > 0.001 || force) {
    const pos = g.position, cp = G.chain.geometry.attributes.position, tp = G.threads.geometry.attributes.position;
    for (let k = 0; k <= N; k++) for (let i = 0; i < L - 1; i++) {
      const o = (k * (L - 1) + i) * 2, a = k * L + i;
      cp.setXYZ(o, pos.getX(a), pos.getY(a), pos.getZ(a)); cp.setXYZ(o + 1, pos.getX(a + 1), pos.getY(a + 1), pos.getZ(a + 1));
    }
    for (let k = 0; k < N; k++) for (let i = 0; i < L; i++) {
      const o = (k * L + i) * 2, a = k * L + i, b = a + L;
      tp.setXYZ(o, pos.getX(a), pos.getY(a), pos.getZ(a)); tp.setXYZ(o + 1, pos.getX(b), pos.getY(b), pos.getZ(b));
    }
    cp.needsUpdate = tp.needsUpdate = true;
  }
  updateHover();
}

function updateHover() {
  const h = st.hover; U.uHover.value = h;
  G.hl.visible = h >= 0;
  if (h < 0) { G.resLabel.hidden = true; return; }
  const pos = G.dots.geometry.attributes.position, p = G.hl.geometry.attributes.position;
  for (let k = 0; k <= st.N; k++) { const n = k * st.L + h; p.setXYZ(k, pos.getX(n), pos.getY(n), pos.getZ(n)); }
  p.needsUpdate = true;
  const k = st.t > 0.5 && st.hoverLayer >= 0 ? st.hoverLayer : st.N, n = k * st.L + h;
  G.resLabel.hidden = false; G.resLabel.el.textContent = `${st.D.seq[h]}${h + 1}`;
  G.resLabel.pos.set(pos.getX(n), pos.getY(n), pos.getZ(n)); G.resLabel.dx = 12; G.resLabel.dy = -20;
}

function caption() {
  const D = st.D, size = ((D.model || '').match(/_(\d+[MB])_/) || [])[1] || '';
  $('#name').textContent = (D.name || 'QUERY').toUpperCase();
  $('#meta').textContent = `${D.seq.length} AA · ${D.contacts.length} CONTACTS`;
  $('#model').textContent = `ESM-2 ${size} · ${D.n_layers} LAYERS · ${D.dim}-D`;
}

// ─── landscape: the protein as terrain, with a town on it ────────────
// map = final-layer embedding (PC1, PC3). terrain = "energy": residues
// ESM-2 believes carve basins, residues it doubts push up ridges.
// towers = residues, taller = more support. road = the chain. arcs = contacts.
const land = { a: 0, to: 0, towersOn: true, grow: 0, G: null };
const MAPW = 15;

function terrainMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, transparent: true });
  // faint topographic lines pressed into the clay
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vH;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = position.y;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vH;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float f1 = vH * 2.5, d1 = abs(fract(f1 - 0.5) - 0.5) / max(fwidth(f1), 1e-4);
        float f2 = vH * 0.5, d2 = abs(fract(f2 - 0.5) - 0.5) / max(fwidth(f2), 1e-4);
        diffuseColor.rgb *= 1.0 - 0.07 * (1.0 - min(d1, 1.0)) - 0.1 * (1.0 - min(d2, 1.0));`);
  };
  return m;
}

function buildLand(D) {
  const L = st.L, k = (MAPW * 0.8) / 1.2;
  const Q = D.emb3d.map((p) => new THREE.Vector2(p[0] * k, p[2] * k));
  const sup = Array.from({ length: L }, (_, i) => support(i));
  const w = clamp(1.25 * Math.sqrt(150 / L), 0.5, 1.5), inv = 1 / (2 * w * w), cut = 9 * w * w;
  const field = (x, z) => { let F = 0; for (let i = 0; i < L; i++) { const dx = x - Q[i].x, dz = z - Q[i].y, d2 = dx * dx + dz * dz; if (d2 < cut) F += (sup[i] - 0.5) * Math.exp(-d2 * inv); } return F; };

  // terrain
  const ext = MAPW * 1.5, res = L > 600 ? 160 : 200;
  const tg = new THREE.PlaneGeometry(ext * 2, ext * 2, res, res); tg.rotateX(-Math.PI / 2);
  const tp = tg.attributes.position, Fs = new Float32Array(tp.count);
  for (let n = 0; n < tp.count; n++) Fs[n] = field(tp.getX(n), tp.getZ(n));
  const sorted = Float32Array.from(Fs, Math.abs).sort(), Fref = sorted[Math.floor(sorted.length * 0.97)] || 1;
  const hOf = (F) => -2.4 * Math.tanh((F / Fref) * 1.4);
  const H = new Float32Array(tp.count), T = new Float32Array(tp.count), Rr = new Float32Array(tp.count);
  let hmin = Infinity, hmax = -Infinity;
  for (let n = 0; n < tp.count; n++) {
    const x = tp.getX(n), z = tp.getZ(n), h = hOf(Fs[n]);
    T[n] = Math.tanh((Fs[n] / Fref) * 1.4); Rr[n] = Math.hypot(x, z);
    tp.setY(n, h); H[n] = h; if (Math.hypot(x, z) < MAPW) { hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); }
  }
  tg.computeVertexNormals();
  tg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tp.count * 3), 3));
  const hAt = (x, z) => hOf(field(x, z));
  const terrain = new THREE.Mesh(tg, terrainMaterial()); terrain.receiveShadow = true;

  // towers
  const wd = clamp(0.4 * Math.sqrt(150 / L), 0.16, 0.46);
  const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
  const towers = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, transparent: true }), L);
  towers.castShadow = towers.receiveShadow = true;
  const ground = Q.map((q) => hAt(q.x, q.y)), tops = [], spec = [];
  for (let i = 0; i < L; i++) {
    const a = Q[Math.max(0, i - 1)], b = Q[Math.min(L - 1, i + 1)];
    const ht = 0.2 + 3.2 * Math.pow(sup[i], 1.7);
    spec.push({ x: Q[i].x, y: ground[i] - 0.05, z: Q[i].y, ht, rot: Math.atan2(b.x - a.x, b.y - a.y) });
    towers.setColorAt(i, new THREE.Color());
    tops.push(new THREE.Vector3(Q[i].x, ground[i] + ht, Q[i].y));
  }

  // road: the chain laid on the terrain
  const flat = new THREE.CatmullRomCurve3(Q.map((q, i) => new THREE.Vector3(q.x, ground[i], q.y)), false, 'centripetal');
  const roadPts = flat.getPoints(Math.min(L * 6, 6000)).map((p) => new THREE.Vector3(p.x, hAt(p.x, p.z) + 0.08, p.z));
  const roadCurve = new THREE.CatmullRomCurve3(roadPts, false, 'centripetal');
  const rsegs = Math.min(L * 8, 8000), rrad = 8;
  const rg = new THREE.TubeGeometry(roadCurve, rsegs, wd * 0.2, rrad, false);
  rg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rg.attributes.position.count * 3), 3));
  const road = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, transparent: true }));
  road.castShadow = true;

  // contacts arch between tower tops
  const C = D.contacts, segA = 20, sp = new Float32Array(C.length * segA * 6), spp = new Float32Array(C.length * segA * 2),
    sij = new Float32Array(C.length * segA * 4).fill(-9);
  const q1 = new THREE.Vector3(), q2 = new THREE.Vector3();
  C.forEach(([i, j, p], c) => {
    const a = tops[i], b = tops[j], ctrl = a.clone().add(b).multiplyScalar(0.5); ctrl.y += 0.6 + 0.35 * a.distanceTo(b);
    const bez = (t, o) => o.set(0, 0, 0).addScaledVector(a, (1 - t) ** 2).addScaledVector(ctrl, 2 * (1 - t) * t).addScaledVector(b, t * t);
    for (let s = 0; s < segA; s++) {
      const o = c * segA + s; bez(s / segA, q1); bez((s + 1) / segA, q2);
      sp.set([q1.x, q1.y, q1.z, q2.x, q2.y, q2.z], o * 6); spp.set([p, p], o * 2);
    }
  });
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  sg.setAttribute('aP', new THREE.BufferAttribute(spp, 1)); sg.setAttribute('aIJ', new THREE.BufferAttribute(sij, 2));
  const skyMat = arcMat.clone(); for (const k of ['uNear', 'uFar', 'uBg', 'uInk']) skyMat.uniforms[k] = U[k];
  skyMat.uniforms.uHover = { value: -1 };
  const sky = new THREE.LineSegments(sg, skyMat); sky.frustumCulled = false;

  const g = new THREE.Group(); g.add(terrain, road, towers, sky); g.visible = false; world.add(g);
  land.G = { g, terrain, towers, road, sky, rsegs, rrad, T, Rr, spec, wd };
  land.grow = -1; setGrow(0);
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _t = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
function setGrow(gv) {
  const Gl = land.G; if (Math.abs(gv - land.grow) < 0.002) return;
  land.grow = gv;
  Gl.spec.forEach((s, i) => {
    _q.setFromAxisAngle(_up, s.rot); _t.set(s.x, s.y, s.z); _s.set(Gl.wd, Math.max(0.001, s.ht * gv), Gl.wd);
    Gl.towers.setMatrixAt(i, _m.compose(_t, _q, _s));
  });
  Gl.towers.instanceMatrix.needsUpdate = true;
}

function colorLand() {
  const Gl = land.G; if (!Gl) return;
  const c = new THREE.Color(), paper = new THREE.Color('#fbf8f3');
  for (let i = 0; i < st.L; i++) Gl.towers.setColorAt(i, ramp(value(i), c));
  Gl.towers.instanceColor.needsUpdate = true;
  // terrain: tinted by its basins (believed) and ridges (doubted),
  // washed toward paper and fading to plain paper at the edges
  const tc = Gl.terrain.geometry.attributes.color;
  for (let n = 0; n < Gl.T.length; n++) {
    const wash = lerp(0.5, 0.92, smooth(MAPW * 0.55, MAPW * 1.15, Gl.Rr[n]));
    ramp(0.5 + 0.5 * Gl.T[n], c).lerp(paper, wash);
    tc.setXYZ(n, c.r, c.g, c.b);
  }
  tc.needsUpdate = true;
  const rc = Gl.road.geometry.attributes.color;
  for (let s = 0; s <= Gl.rsegs; s++) {
    const f = (s / Gl.rsegs) * (st.L - 1), i = Math.floor(f), j = Math.min(st.L - 1, i + 1);
    ramp(lerp(value(i), value(j), f - i), c).multiplyScalar(0.85);
    for (let r = 0; r <= Gl.rrad; r++) rc.setXYZ(s * (Gl.rrad + 1) + r, c.r, c.g, c.b);
  }
  rc.needsUpdate = true;
}

function updateLand(dt, la) {
  const Gl = land.G; if (!Gl) return;
  Gl.g.visible = la > 0.01; if (!Gl.g.visible) return;
  Gl.terrain.material.opacity = la;
  Gl.towers.visible = land.towersOn || land.grow > 0.01;
  Gl.towers.material.opacity = la;
  setGrow(lerp(land.grow, land.towersOn ? smooth(0.35, 1, la) : 0, Math.min(1, dt * 4)));
  Gl.road.material.opacity = la;
  Gl.sky.visible = st.contacts; Gl.sky.material.uniforms.uOpacity.value = la * 0.7;
}

let toastT;
function toast(txt) { const t = $('#toast'); t.textContent = txt; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1600); }

// ─── interaction ─────────────────────────────────────────────────────
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
canvas.addEventListener('pointermove', (e) => {
  wake();
  if (!st.D || e.buttons || land.a > 0.5) return;
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera); ray.params.Points.threshold = G.base * 0.6;
  const alpha = G.dots.geometry.attributes.alpha;
  const hit = ray.intersectObject(G.dots).find((h) => alpha.getX(h.index) > 0.4);
  const i = hit ? hit.index % st.L : -1, k = hit ? Math.floor(hit.index / st.L) : -1;
  if (i !== st.hover || k !== st.hoverLayer) { st.hover = i; st.hoverLayer = k; updateHover(); }
});
canvas.addEventListener('pointerleave', () => { st.hover = -1; updateHover(); });

const VIEWS = { fold: { d: 24, el: 0.2, target: new THREE.Vector3(0, -0.3, 0) }, expl: { d: 31, el: 0.4, target: new THREE.Vector3(0, -0.4, 0) },
  land: { d: 34, el: 0.62, target: new THREE.Vector3(0, -0.5, 0) } };
const fit = () => (camera.aspect < 1 ? Math.min(1.7, 0.55 / camera.aspect + 0.3) : 1);
let camTween = null;
function goto(mode, instant = false) {
  st.mode = mode; st.tTo = mode === 'expl' ? 1 : 0; land.to = mode === 'land' ? 1 : 0;
  controls.minDistance = mode === 'land' ? 2 : 5;
  if (!instant) toast(mode === 'land' ? 'LANDSCAPE' : mode === 'expl' ? 'LAYERS' : 'FOLD');
  const v = VIEWS[mode], dir = camera.position.clone().sub(controls.target);
  const az = Math.atan2(dir.x, dir.z) || 0.6, d = v.d * fit();
  const pos = new THREE.Vector3(Math.sin(az) * Math.cos(v.el), Math.sin(v.el), Math.cos(az) * Math.cos(v.el)).multiplyScalar(d).add(v.target);
  if (instant) { camera.position.copy(pos); controls.target.copy(v.target); st.t = st.tTo; land.a = land.to; layout(); return; }
  camTween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: v.target.clone(), start: performance.now(), dur: 1600 };
}

const typing = (t) => t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
addEventListener('keydown', (e) => {
  wake();
  if (e.metaKey || e.ctrlKey || e.altKey || !st.D) return;
  if (typing(e.target)) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.shiftKey && e.code === 'Digit3') { e.preventDefault(); goto(st.mode === 'expl' ? 'fold' : 'expl'); }
  else if (e.shiftKey && e.code === 'Digit2') { e.preventDefault(); goto(st.mode === 'land' ? 'fold' : 'land'); }
  else if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); goto('fold'); }
  else if (e.code === 'KeyK') { pal = (pal + 1) % PALETTES.length; colorize(); toast(PALETTES[pal].name); }
  else if (e.code === 'KeyC') st.contacts = !st.contacts;
  else if (e.code === 'Space') { e.preventDefault(); st.spin = !st.spin; controls.autoRotate = st.spin; toast(st.spin ? 'SPIN ON' : 'SPIN OFF'); }
  else if (e.code === 'KeyB' && st.mode === 'land') { land.towersOn = !land.towersOn; toast(land.towersOn ? 'TOWN' : 'TERRAIN'); }
  else if (e.key === 'Escape') goto('fold');
  else if (e.key === '/') { e.preventDefault(); $('#seq').focus(); }
});

// UI fades away when you stop moving, so it's just the protein
let idleT;
function wake() { document.body.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => { if (!typing(document.activeElement)) document.body.classList.add('idle'); }, 4500); }

// ─── data ────────────────────────────────────────────────────────────
const INLINE = window.PROTVIS_DEMOS || null;
async function loadDemo(key) {
  setStatus('');
  document.querySelectorAll('#demos a').forEach((a) => a.classList.toggle('on', a.dataset.key === key));
  const D = INLINE ? INLINE.data[key] : await (await fetch(`demos/${key}.json`)).json();
  try { history.replaceState(null, '', `${location.search}#${key}`); } catch {}
  build(D);
}
function setStatus(txt, err = false) { const s = $('#status'); s.textContent = txt; s.classList.toggle('err', err); }
async function embedQuery(seq) {
  seq = seq.replace(/^>.*$/m, '').replace(/[\s\d]/g, '').toUpperCase();
  if (!seq) return;
  setStatus(`Embedding ${seq.length} residues…`);
  try {
    const r = await fetch('api/embed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sequence: seq }) });
    const D = await r.json().catch(() => { throw new Error('no-server'); });
    if (!r.ok) throw new Error(D.error || r.statusText);
    document.querySelectorAll('#demos a').forEach((a) => a.classList.remove('on'));
    build(D); setStatus('');
  } catch (err) {
    setStatus(err.message === 'no-server' || err instanceof TypeError ? 'New sequences need the local server (python serve.py). The proteins above work anywhere.' : err.message, true);
  }
}
$('#seq').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); embedQuery(e.target.value); e.target.blur(); } });

// ─── loop ────────────────────────────────────────────────────────────
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.fov = w < h ? 48 : 34; camera.updateProjectionMatrix();
  U.uScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
}
addEventListener('resize', resize); resize();

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (st.D) {
    if (st.t !== st.tTo) { st.t = st.tTo > st.t ? Math.min(1, st.t + dt * 0.8) : Math.max(0, st.t - dt * 0.8); layout(); }
    if (st.draw < 1) st.draw = clamp((now - st.drawStart) / (2000 + st.L * 3));
    const d = 1 - Math.pow(1 - st.draw, 3);
    U.uDraw.value = d;
    G.tube.geometry.setDrawRange(0, Math.floor(d * G.tubeMeta.segs) * G.tubeMeta.radial * 6);
    if (land.a !== land.to) land.a = land.to > land.a ? Math.min(1, land.a + dt * 0.7) : Math.max(0, land.a - dt * 0.7);
    const la = ease(land.a), keepW = 1 - la;
    const fold = (1 - smooth(0, 0.4, st.t)) * keepW, expl = smooth(0.35, 0.95, st.t) * keepW;
    U.uDotOp.value = keepW;
    updateLand(dt, la);
    tubeMat.opacity = fold; G.tube.visible = fold > 0.01;
    G.floor.material.opacity = 0.11 * fold; G.floor.visible = fold > 0.01;
    arcMat.uniforms.uOpacity.value = fold * (0.4 + 0.6 * G.gain) * smooth(0.7, 1, st.draw); G.arcs.visible = st.contacts && fold > 0.01;
    G.chain.material.opacity = expl * 0.7; G.threads.material.opacity = expl * 0.35 * G.gain; G.hl.material.opacity = expl;
    G.chain.visible = G.threads.visible = expl > 0.01;
    for (const s of G.sheets) {
      const a = smooth(0.25, 0.9, st.t) * keepW;
      s.fill.material.opacity = 0.32 * a; s.edge.material.opacity = (s.k === st.N ? 0.8 : 0.6) * a;
      s.fill.visible = s.edge.visible = a > 0.01;
    }
    placeLabels(expl);
  }
  if (camTween) {
    const u = clamp((now - camTween.start) / camTween.dur), e = easeInOut(u);
    camera.position.lerpVectors(camTween.p0, camTween.p1, e); controls.target.lerpVectors(camTween.t0, camTween.t1, e);
    if (u >= 1) camTween = null;
  }
  controls.update(dt);
  // fog band hugs the object: front stays crisp, the far side melts into the paper
  const cd = camera.position.distanceTo(controls.target), la = ease(land.a);
  const span = lerp(st.t > 0.5 ? 14 : 10, 30, la);
  U.uNear.value = scene.fog.near = cd - span * 0.2; U.uFar.value = scene.fog.far = cd + span * 2.2;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

(async () => {
  const index = INLINE ? INLINE.index : await (await fetch('demos/index.json')).json();
  const box = $('#demos');
  index.forEach((d) => box.insertAdjacentHTML('beforeend', `<a data-key="${d.key}" tabindex="0">${d.name.toUpperCase()}</a>`));
  box.addEventListener('click', (e) => { const k = e.target.dataset?.key; if (k) loadDemo(k); });
  box.addEventListener('keydown', (e) => { const k = e.target.dataset?.key; if (k && e.key === 'Enter') loadDemo(k); });
  const want = location.hash.slice(1);
  camera.position.set(0, 4, 24 * fit());
  await loadDemo(index.some((d) => d.key === want) ? want : 'ubiquitin');
  const q = new URLSearchParams(location.search);
  if (q.has('still')) { st.spin = controls.autoRotate = false; }
  if (q.get('view') === 'explode') { st.draw = 1; goto('expl', true); }
  else if (q.get('view') === 'land') { st.draw = 1; goto('land', true); }
  else goto('fold', true);
  wake();
  requestAnimationFrame(frame);
})();
