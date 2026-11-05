import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const LOGMIN = Math.log(0.002), LOGMAX = Math.log(0.6);
const R = 6, S = 4.4, STACK = 11;
const $ = (s) => document.querySelector(s);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);
const easeInOut = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a, b, x) => ease(clamp((x - a) / (b - a)));
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// palettes: fluorophores under a confocal, and a plain spectrum along the chain
const PALETTES = [
  { name: 'FLUOROPHORE · SUPPORT', by: 'support', stops: ['#ff2d55', '#ff9f1c', '#46ff9b', '#62e6ff'] },
  { name: 'SPECTRUM · N → C', by: 'position', stops: ['#5b6cff', '#3fe0ff', '#7dff8a', '#ffd84a', '#ff5470'] },
  { name: 'EMBER · CONSERVATION', by: 'entropy', stops: ['#2a1a6e', '#c2308a', '#ff7a3d', '#ffe7a8'] },
];
let pal = 0;

const st = { mode: 'fold', D: null, L: 0, N: 0, t: 0, tTo: 0, draw: 0, drawStart: 0, hover: -1, hoverLayer: -1, contacts: true, spin: !REDUCED };

// ─── renderer ────────────────────────────────────────────────────────
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(new THREE.Color('#030406'));
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.9;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.06;
controls.autoRotate = st.spin; controls.autoRotateSpeed = 1.4; // ≈ 45 s per turn
controls.minDistance = 5; controls.maxDistance = 70;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.35, 0.14);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const world = new THREE.Group(); scene.add(world);
const U = { uDotOp: { value: 1 }, uTime: { value: 0 }, uDraw: { value: 0 }, uL: { value: 1 }, uHover: { value: -1 }, uScale: { value: 1 },
            uNear: { value: 10 }, uFar: { value: 40 } };

// depth falloff shared by every shader: near things burn, far things dim to the field
const DEPTH = /* glsl */`
  uniform float uNear, uFar;
  float depthFade(float z) { return mix(1.0, 0.12, smoothstep(uNear, uFar, z)); }`;

// ─── materials ───────────────────────────────────────────────────────
// filament: fresnel glow + a pulse of light that runs N → C
const tubeMat = new THREE.ShaderMaterial({
  uniforms: { ...U, uOpacity: { value: 1 } },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    attribute vec3 color; varying vec3 vColor; varying vec3 vN; varying vec3 vV; varying float vU; varying float vZ;
    void main() {
      vColor = color; vU = uv.x;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vZ = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uTime, uOpacity; ${DEPTH}
    varying vec3 vColor; varying vec3 vN; varying vec3 vV; varying float vU; varying float vZ;
    void main() {
      float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
      float glow = 0.07 + 0.55 * pow(f, 2.4);
      float ph = fract(uTime * 0.045);
      float pulse = exp(-pow((vU - ph) * 26.0, 2.0)) * 1.6 + exp(-pow((vU - fract(ph + 0.5)) * 40.0, 2.0)) * 0.6;
      vec3 col = vColor * (glow + pulse) + vec3(1.0) * pulse * 0.25;
      gl_FragColor = vec4(col * depthFade(vZ) * uOpacity, 1.0);
    }`,
});

// residues: soft fluorescent puncta
const dotMat = new THREE.ShaderMaterial({
  uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    attribute vec3 color; attribute float size; attribute float alpha; attribute float res;
    uniform float uScale, uDraw, uL, uHover, uTime;
    varying vec3 vColor; varying float vA; varying float vHi; varying float vZ;
    void main() {
      vColor = color;
      vHi = 1.0 - step(0.5, abs(res - uHover));
      float drawn = 1.0 - smoothstep(uDraw * (uL + 8.0) - 8.0, uDraw * (uL + 8.0), res);
      float tw = 0.85 + 0.15 * sin(uTime * 1.7 + res * 2.39);
      vA = alpha * drawn * tw;
      vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z;
      gl_PointSize = size * (1.0 + 1.6 * vHi) * uScale / -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uDotOp; ${DEPTH}
    varying vec3 vColor; varying float vA; varying float vHi; varying float vZ;
    void main() {
      vec2 c = gl_PointCoord * 2.0 - 1.0; float r2 = dot(c, c);
      if (r2 > 1.0 || vA < 0.005 || uDotOp < 0.01) discard;
      float core = smoothstep(0.22, 0.0, r2), halo = exp(-r2 * 5.0);
      vec3 col = vColor * (halo * 0.45 + core * 0.7) + vec3(1.0) * core * (0.12 + 0.8 * vHi);
      gl_FragColor = vec4(col * vA * uDotOp * depthFade(vZ) * (1.0 + vHi), 1.0);
    }`,
});

// dust: a slow cloud around the chain, densest where ESM-2 backs the residue
const dustMat = new THREE.ShaderMaterial({
  uniforms: { ...U, uOpacity: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    attribute vec3 center; attribute vec3 offs; attribute float seed; attribute vec3 color; attribute float res;
    uniform float uTime, uScale, uDraw, uL;
    varying vec3 vColor; varying float vA; varying float vZ;
    mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
    void main() {
      vColor = color;
      vec3 o = offs;
      float a = uTime * (0.05 + 0.22 * seed) + seed * 6.283;
      o.xz = rot(a) * o.xz; o.xy = rot(a * 0.7) * o.xy;
      o *= 1.0 + 0.18 * sin(uTime * 0.6 + seed * 40.0);
      vec4 mv = modelViewMatrix * vec4(center + o, 1.0); vZ = -mv.z;
      float drawn = 1.0 - smoothstep(uDraw * (uL + 8.0) - 8.0, uDraw * (uL + 8.0), res);
      vA = drawn * (0.45 + 0.55 * sin(uTime * (0.8 + 2.4 * seed) + seed * 91.0));
      gl_PointSize = (0.035 + 0.05 * seed) * uScale / -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uOpacity; ${DEPTH}
    varying vec3 vColor; varying float vA; varying float vZ;
    void main() {
      vec2 c = gl_PointCoord * 2.0 - 1.0; float r2 = dot(c, c);
      if (r2 > 1.0) discard;
      gl_FragColor = vec4(vColor * exp(-r2 * 3.5) * max(vA, 0.0) * 0.3 * uOpacity * depthFade(vZ), 1.0);
    }`,
});

// contacts: hairline arcs with light travelling along them
const arcMat = new THREE.ShaderMaterial({
  uniforms: { ...U, uOpacity: { value: 1 }, uTint: { value: new THREE.Color('#bfe9ff') } },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    attribute float aU; attribute float aP; attribute float aPh; attribute vec2 aIJ;
    uniform float uHover; varying float vU; varying float vP; varying float vPh; varying float vHi; varying float vZ;
    void main() {
      vU = aU; vP = aP; vPh = aPh;
      vHi = max(1.0 - step(0.5, abs(aIJ.x - uHover)), 1.0 - step(0.5, abs(aIJ.y - uHover)));
      vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uTime, uOpacity, uHover; uniform vec3 uTint; ${DEPTH}
    varying float vU; varying float vP; varying float vPh; varying float vHi; varying float vZ;
    void main() {
      float run = exp(-pow((vU - fract(uTime * 0.12 + vPh)) * 9.0, 2.0));
      float base = (0.03 + 0.12 * vP * vP) * (uHover >= 0.0 ? mix(0.25, 4.0, vHi) : 1.0);
      float a = base + run * (0.25 + 0.6 * vP) * (uHover >= 0.0 ? mix(0.2, 2.0, vHi) : 1.0);
      gl_FragColor = vec4(uTint * a * uOpacity * depthFade(vZ), 1.0);
    }`,
});

const glowLine = (opacity = 1) => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });

// ─── labels ──────────────────────────────────────────────────────────
const labelsEl = $('#labels'); let labels = [];
function addLabel(text, pos, group, cls = '') {
  const el = document.createElement('div'); el.textContent = text; if (cls) el.className = cls;
  labelsEl.appendChild(el); const L = { el, pos: pos.clone(), group, dx: 8, dy: -6 }; labels.push(L); return L;
}
const _v = new THREE.Vector3();
function placeLabels(explA) {
  for (const L of labels) {
    const a = L.group === 'expl' ? explA * 0.75 : 1;
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
  if (by === 'support') { const v = D.logp_wt[i]; return v == null ? 0.5 : clamp((v - LOGMIN) / (LOGMAX - LOGMIN)); }
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
const keep = new Set([tubeMat, dotMat, dustMat, arcMat]);
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

  // filament
  const curve = new THREE.CatmullRomCurve3(P, false, 'centripetal', 0.5);
  const segs = Math.min(L * 10, 12000), radial = 12;
  const tube = new THREE.TubeGeometry(curve, segs, base * 0.22, radial, false);
  tube.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tube.attributes.position.count * 3), 3));
  G.tube = new THREE.Mesh(tube, tubeMat); G.tubeMeta = { segs, radial };
  world.add(G.tube);

  // dust
  const per = Array.from({ length: L }, (_, i) => Math.round((2 + 22 * Math.pow(support(i), 1.6)) * G.gain));
  const total = per.reduce((a, b) => a + b, 0);
  const dg = new THREE.BufferGeometry();
  const cen = new Float32Array(total * 3), off = new Float32Array(total * 3), seed = new Float32Array(total), dres = new Float32Array(total);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) * Math.cos(6.283 * Math.random());
  let n = 0;
  per.forEach((c, i) => {
    for (let k = 0; k < c; k++, n++) {
      const sp = base * (1.2 + 3.5 * Math.random() ** 2);
      cen.set([P[i].x, P[i].y, P[i].z], n * 3);
      off.set([gauss() * sp, gauss() * sp, gauss() * sp], n * 3);
      seed[n] = Math.random(); dres[n] = i;
    }
  });
  dg.setAttribute('position', new THREE.BufferAttribute(cen, 3));
  dg.setAttribute('center', new THREE.BufferAttribute(cen, 3));
  dg.setAttribute('offs', new THREE.BufferAttribute(off, 3));
  dg.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  dg.setAttribute('res', new THREE.BufferAttribute(dres, 1));
  dg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
  G.dust = new THREE.Points(dg, dustMat); G.dust.frustumCulled = false; G.dustRes = dres;
  world.add(G.dust);

  // contacts
  const C = D.contacts, segA = 24;
  const cpos = new Float32Array(C.length * segA * 6), cu = new Float32Array(C.length * segA * 2),
    cp = new Float32Array(C.length * segA * 2), cph = new Float32Array(C.length * segA * 2), cij = new Float32Array(C.length * segA * 4);
  const q = new THREE.Vector3(), q2 = new THREE.Vector3(), cent = new THREE.Vector3();
  P.forEach((p) => cent.add(p)); cent.multiplyScalar(1 / L);
  C.forEach(([i, j, p], k) => {
    const a = P[i], b = P[j], m = a.clone().add(b).multiplyScalar(0.5), d = a.distanceTo(b);
    const ctrl = m.clone().add(m.clone().sub(cent).normalize().multiplyScalar(0.4 + d * 0.45));
    const bez = (t, o) => o.set(0, 0, 0).addScaledVector(a, (1 - t) ** 2).addScaledVector(ctrl, 2 * (1 - t) * t).addScaledVector(b, t * t);
    const ph = Math.random();
    for (let s = 0; s < segA; s++) {
      const o = k * segA + s;
      bez(s / segA, q); bez((s + 1) / segA, q2);
      cpos.set([q.x, q.y, q.z, q2.x, q2.y, q2.z], o * 6);
      cu.set([s / segA, (s + 1) / segA], o * 2); cp.set([p, p], o * 2); cph.set([ph, ph], o * 2); cij.set([i, j, i, j], o * 4);
    }
  });
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(cpos, 3));
  cg.setAttribute('aU', new THREE.BufferAttribute(cu, 1));
  cg.setAttribute('aP', new THREE.BufferAttribute(cp, 1));
  cg.setAttribute('aPh', new THREE.BufferAttribute(cph, 1));
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
  G.dots = new THREE.Points(pg, dotMat); G.dots.frustumCulled = false;
  world.add(G.dots);

  // exploded: chains, threads, sheets
  const seg = (count) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    return g;
  };
  G.chain = new THREE.LineSegments(seg((N + 1) * (L - 1)), glowLine()); G.chain.frustumCulled = false;
  G.threads = new THREE.LineSegments(seg(N * L), glowLine()); G.threads.frustumCulled = false;
  const hl = new THREE.BufferGeometry(); hl.setAttribute('position', new THREE.BufferAttribute(new Float32Array((N + 1) * 3), 3));
  G.hl = new THREE.Line(hl, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  world.add(G.chain, G.threads, G.hl);
  G.sheets = [];
  const half = S * 1.14, corners = [[-half, -half], [half, -half], [half, half], [-half, half]];
  for (let k = 0; k <= N; k++) {
    const y = layerY(k);
    const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners.map(([x, z]) => new THREE.Vector3(x, y, z))),
      new THREE.LineBasicMaterial({ color: k === N ? '#62e6ff' : '#3a4250', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    world.add(edge); G.sheets.push({ edge, k });
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
  const uc = G.dust.geometry.attributes.color;
  for (let n = 0; n < G.dustRes.length; n++) { const k = cols[G.dustRes[n]]; uc.setXYZ(n, k.r, k.g, k.b); }
  uc.needsUpdate = true;
  const cc = G.chain.geometry.attributes.color;
  for (let k = 0; k <= N; k++) {
    const a = (k === N ? 0.4 : 0.05 + 0.1 * (k / N)) * G.gain * G.gain;
    for (let i = 0; i < L - 1; i++) {
      const o = (k * (L - 1) + i) * 2;
      cc.setXYZ(o, cols[i].r * a, cols[i].g * a, cols[i].b * a); cc.setXYZ(o + 1, cols[i + 1].r * a, cols[i + 1].g * a, cols[i + 1].b * a);
    }
  }
  cc.needsUpdate = true;
  const th = G.threads.geometry.attributes.color, ta = clamp(3 / Math.sqrt(L), 0.02, 0.12);
  for (let k = 0; k < N; k++) for (let i = 0; i < L; i++) {
    const o = (k * L + i) * 2, x = cols[i];
    th.setXYZ(o, x.r * ta, x.g * ta, x.b * ta); th.setXYZ(o + 1, x.r * ta, x.g * ta, x.b * ta);
  }
  th.needsUpdate = true;
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
  const bead = G.base * 0.95, dot = G.base * 0.75;
  for (let k = 0; k <= N; k++) {
    const vis = k === N ? 1 : smooth(0.05 + 0.25 * (1 - k / N), 0.55 + 0.25 * (1 - k / N), t);
    for (let i = 0; i < L; i++) {
      const n = k * L + i;
      dotPos(k, i, t, _p); g.position.setXYZ(n, _p.x, _p.y, _p.z);
      g.size.setX(n, k === N ? lerp(bead, dot * 1.2, ease(t)) : dot);
      g.alpha.setX(n, vis * (k === N ? 1 : 0.45));
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

// ─── landscape: the protein as a folding funnel, with a city on it ───
// map = final-layer embedding (PC1, PC3). terrain = "energy": residues
// ESM-2 believes carve basins, residues it doubts push up ridges, and the
// whole map bowls down toward the middle like a folding funnel.
// towers = residues, taller = more support. road = the chain. skyways = contacts.
const land = { a: 0, to: 0, ride: false, s: 0, towersOn: true, G: null };
const MAPW = 15;

function shareTime(mat) { for (const k of ['uTime', 'uNear', 'uFar']) mat.uniforms[k] = U[k]; return mat; }

const terrainMat = () => new THREE.ShaderMaterial({
  uniforms: { uOpacity: { value: 0 }, uHmin: { value: -1 }, uHmax: { value: 1 }, uW: { value: MAPW },
    uC: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()] }, uNear: U.uNear, uFar: U.uFar },
  transparent: true,
  vertexShader: /* glsl */`
    varying float vH; varying vec3 vW; varying float vZ;
    void main() { vH = position.y; vW = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: /* glsl */`
    uniform float uOpacity, uHmin, uHmax, uW; uniform vec3 uC[4]; ${DEPTH}
    varying float vH; varying vec3 vW; varying float vZ;
    vec3 ramp4(float t) { t = clamp(t, 0.0, 1.0) * 3.0;
      return t < 1.0 ? mix(uC[0], uC[1], t) : t < 2.0 ? mix(uC[1], uC[2], t - 1.0) : mix(uC[2], uC[3], t - 2.0); }
    float iso(float f) { float d = abs(fract(f - 0.5) - 0.5) / max(fwidth(f), 1e-4); return 1.0 - min(d, 1.0); }
    void main() {
      float hn = (vH - uHmin) / (uHmax - uHmin);
      vec3 col = ramp4(1.0 - hn);                       // basins wear the "confident" end of the palette
      float minor = iso(vH * 3.0), major = iso(vH * 0.6);
      vec2 g = vW.xz * 0.5; float grid = max(iso(g.x), iso(g.y));
      float r = length(vW.xz), edge = smoothstep(uW * 1.25, uW * 0.85, r);
      float rimDim = 0.35 + 0.65 * (1.0 - smoothstep(0.55, 1.0, hn));  // keep the rim quiet, the basin is the subject
      vec3 c = col * 0.03 + (col * minor * 0.5 + col * major * 0.9) * rimDim + vec3(0.6, 0.7, 0.8) * grid * 0.03;
      gl_FragColor = vec4(c * edge * depthFade(vZ), uOpacity);
    }`,
});

const towerMat = () => new THREE.ShaderMaterial({
  uniforms: { uOpacity: { value: 0 }, uGrow: { value: 0 }, uTime: U.uTime, uNear: U.uNear, uFar: U.uFar },
  transparent: true,
  vertexShader: /* glsl */`
    attribute float aH; attribute float aSeed; uniform float uGrow;
    varying vec3 vP; varying vec3 vN; varying vec3 vC; varying float vZ; varying float vH; varying float vSeed;
    void main() {
      vP = position; vN = normal; vC = instanceColor; vH = aH; vSeed = aSeed;
      vec3 p = position; p.y *= uGrow;
      vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0); vZ = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uOpacity, uTime; ${DEPTH}
    varying vec3 vP; varying vec3 vN; varying vec3 vC; varying float vZ; varying float vH; varying float vSeed;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
      float fade = uOpacity * depthFade(vZ);
      if (vN.y > 0.5) { gl_FragColor = vec4(vC * 0.9 * fade, uOpacity); return; }
      float u = abs(vN.x) > 0.5 ? vP.z : vP.x, v = vP.y * vH;
      vec2 cell = vec2(floor((u + 0.5) * 3.0) + (vN.x + 2.0 * vN.z) * 7.0, floor(v * 6.0));
      vec2 f = vec2(fract((u + 0.5) * 3.0), fract(v * 6.0));
      float win = step(0.22, f.x) * step(f.x, 0.78) * step(0.3, f.y) * step(f.y, 0.75);
      float h = hash(cell + vSeed * 31.0);
      float lit = step(0.42, h) * (0.7 + 0.3 * sin(uTime * (0.5 + 2.0 * h) + h * 40.0));
      float edgeGlow = smoothstep(0.44, 0.5, abs(u));
      vec3 c = vC * 0.03 + vC * win * lit * 0.75 + vC * edgeGlow * 0.35;
      gl_FragColor = vec4(c * fade, uOpacity);
    }`,
});

function buildLand(D) {
  const L = st.L, k = (MAPW * 0.8) / 1.2;
  const Q = D.emb3d.map((p) => new THREE.Vector2(p[0] * k, p[2] * k));
  const sup = Array.from({ length: L }, (_, i) => support(i));
  const w = clamp(1.25 * Math.sqrt(150 / L), 0.5, 1.5), inv = 1 / (2 * w * w), cut = 9 * w * w;
  const field = (x, z) => { let F = 0; for (let i = 0; i < L; i++) { const dx = x - Q[i].x, dz = z - Q[i].y, d2 = dx * dx + dz * dz; if (d2 < cut) F += (sup[i] - 0.5) * Math.exp(-d2 * inv); } return F; };
  const bowl = (r) => 0.016 * r * r - 3.2 * Math.exp(-(r * r) / (2 * (MAPW * 0.42) ** 2));

  // terrain
  const ext = MAPW * 1.25, res = L > 600 ? 150 : 190;
  const tg = new THREE.PlaneGeometry(ext * 2, ext * 2, res, res); tg.rotateX(-Math.PI / 2);
  const tp = tg.attributes.position, Fs = new Float32Array(tp.count);
  for (let n = 0; n < tp.count; n++) Fs[n] = field(tp.getX(n), tp.getZ(n));
  const sorted = Float32Array.from(Fs, Math.abs).sort(), Fref = sorted[Math.floor(sorted.length * 0.97)] || 1;
  const hOf = (F, r) => -2.4 * Math.tanh((F / Fref) * 1.4) + bowl(r);
  let hmin = Infinity, hmax = -Infinity;
  for (let n = 0; n < tp.count; n++) {
    const x = tp.getX(n), z = tp.getZ(n), h = hOf(Fs[n], Math.hypot(x, z));
    tp.setY(n, h); if (Math.hypot(x, z) < MAPW) { hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); }
  }
  tg.computeVertexNormals();
  const hAt = (x, z) => hOf(field(x, z), Math.hypot(x, z));
  const tm = terrainMat(); tm.uniforms.uHmin.value = hmin; tm.uniforms.uHmax.value = hmax;
  const terrain = new THREE.Mesh(tg, tm);

  // towers
  const wd = clamp(0.36 * Math.sqrt(150 / L), 0.14, 0.42);
  const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
  const aH = new Float32Array(L), aSeed = new Float32Array(L);
  const towers = new THREE.InstancedMesh(box, towerMat(), L);
  const m = new THREE.Matrix4(), qn = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const ground = Q.map((q) => hAt(q.x, q.y)), tops = [];
  for (let i = 0; i < L; i++) {
    const a = Q[Math.max(0, i - 1)], b = Q[Math.min(L - 1, i + 1)];
    const ht = 0.25 + 3.4 * Math.pow(sup[i], 1.7);
    aH[i] = ht; aSeed[i] = Math.random();
    qn.setFromAxisAngle(up, Math.atan2(b.x - a.x, b.y - a.y));
    ps.set(Q[i].x, ground[i] - 0.05, Q[i].y); sc.set(wd, ht, wd);
    towers.setMatrixAt(i, m.compose(ps, qn, sc)); towers.setColorAt(i, new THREE.Color());
    tops.push(new THREE.Vector3(Q[i].x, ground[i] + ht, Q[i].y));
  }
  box.setAttribute('aH', new THREE.InstancedBufferAttribute(aH, 1));
  box.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));

  // road: the chain laid on the terrain
  const flat = new THREE.CatmullRomCurve3(Q.map((q, i) => new THREE.Vector3(q.x, ground[i], q.y)), false, 'centripetal');
  const roadPts = flat.getPoints(Math.min(L * 6, 6000)).map((p) => new THREE.Vector3(p.x, hAt(p.x, p.z) + 0.1, p.z));
  const roadCurve = new THREE.CatmullRomCurve3(roadPts, false, 'centripetal');
  const rsegs = Math.min(L * 8, 8000), rrad = 8;
  const rg = new THREE.TubeGeometry(roadCurve, rsegs, wd * 0.24, rrad, false);
  rg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rg.attributes.position.count * 3), 3));
  const roadMat = shareTime(tubeMat.clone());
  const road = new THREE.Mesh(rg, roadMat);

  // skyways: contacts arch between tower tops
  const C = D.contacts, segA = 20, sp = new Float32Array(C.length * segA * 6), su = new Float32Array(C.length * segA * 2),
    spp = new Float32Array(C.length * segA * 2), sph = new Float32Array(C.length * segA * 2), sij = new Float32Array(C.length * segA * 4).fill(-9);
  const q1 = new THREE.Vector3(), q2 = new THREE.Vector3();
  C.forEach(([i, j, p], c) => {
    const a = tops[i], b = tops[j], ctrl = a.clone().add(b).multiplyScalar(0.5); ctrl.y += 0.6 + 0.35 * a.distanceTo(b);
    const bez = (t, o) => o.set(0, 0, 0).addScaledVector(a, (1 - t) ** 2).addScaledVector(ctrl, 2 * (1 - t) * t).addScaledVector(b, t * t);
    const ph = Math.random();
    for (let s = 0; s < segA; s++) {
      const o = c * segA + s; bez(s / segA, q1); bez((s + 1) / segA, q2);
      sp.set([q1.x, q1.y, q1.z, q2.x, q2.y, q2.z], o * 6); su.set([s / segA, (s + 1) / segA], o * 2); spp.set([p, p], o * 2); sph.set([ph, ph], o * 2);
    }
  });
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3)); sg.setAttribute('aU', new THREE.BufferAttribute(su, 1));
  sg.setAttribute('aP', new THREE.BufferAttribute(spp, 1)); sg.setAttribute('aPh', new THREE.BufferAttribute(sph, 1)); sg.setAttribute('aIJ', new THREE.BufferAttribute(sij, 2));
  const skyMat = shareTime(arcMat.clone()); skyMat.uniforms.uHover = { value: -1 };
  const sky = new THREE.LineSegments(sg, skyMat); sky.frustumCulled = false;

  // stars
  const NS = 1800, stp = new Float32Array(NS * 3);
  for (let n = 0; n < NS; n++) {
    const th = Math.random() * 6.283, ph = Math.acos(Math.random() * 0.95), r = 140;
    stp.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) - 10, r * Math.sin(ph) * Math.sin(th)], n * 3);
  }
  const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(stp, 3)),
    new THREE.PointsMaterial({ color: '#9fb3c8', size: 1.3, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false }));

  const g = new THREE.Group(); g.add(terrain, road, towers, sky, stars); g.visible = false; world.add(g);
  land.G = { g, terrain, towers, road, sky, stars, roadCurve, rsegs, rrad, sup };
  land.s = 0;
}

function colorLand() {
  const Gl = land.G; if (!Gl) return;
  const c = new THREE.Color();
  for (let i = 0; i < st.L; i++) Gl.towers.setColorAt(i, ramp(value(i), c));
  Gl.towers.instanceColor.needsUpdate = true;
  [0, 1 / 3, 2 / 3, 1].forEach((t, k) => ramp(t, Gl.terrain.material.uniforms.uC.value[k]));
  const rc = Gl.road.geometry.attributes.color;
  for (let s = 0; s <= Gl.rsegs; s++) {
    const f = (s / Gl.rsegs) * (st.L - 1), i = Math.floor(f), j = Math.min(st.L - 1, i + 1);
    ramp(lerp(value(i), value(j), f - i), c);
    for (let r = 0; r <= Gl.rrad; r++) rc.setXYZ(s * (Gl.rrad + 1) + r, c.r, c.g, c.b);
  }
  rc.needsUpdate = true;
}

function updateLand(dt, la) {
  const Gl = land.G; if (!Gl) return;
  Gl.g.visible = la > 0.01; if (!Gl.g.visible) return;
  Gl.terrain.material.uniforms.uOpacity.value = la;
  Gl.towers.visible = land.towersOn;
  Gl.towers.material.uniforms.uOpacity.value = la;
  const gr = Gl.towers.material.uniforms.uGrow;
  gr.value = lerp(gr.value, land.towersOn ? smooth(0.35, 1, la) : 0, Math.min(1, dt * 4));
  Gl.road.material.uniforms.uOpacity.value = la * 0.9;
  Gl.sky.visible = st.contacts; Gl.sky.material.uniforms.uOpacity.value = la * 0.8;
  Gl.stars.material.opacity = la * 0.7;
}

// ride the chain from N to C, a little above the road
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
function setRide(on) {
  land.ride = on; controls.enabled = !on; controls.autoRotate = st.spin && !on;
  if (on) { camTween = null; toast('RIDING N → C · ESC TO STOP'); }
}
function rideStep(dt) {
  const c = land.G.roadCurve, len = c.getLength();
  land.s = (land.s + (dt * 2.6) / len) % 1;
  c.getPointAt(land.s, _a); c.getPointAt(Math.min(0.9999, land.s + 5 / len), _b);
  _a.y += 1.1; _b.y += 0.5;
  camera.position.lerp(_a, Math.min(1, dt * 3)); controls.target.lerp(_b, Math.min(1, dt * 3));
  camera.lookAt(controls.target);
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

const VIEWS = { fold: { d: 24, el: 0.16, target: new THREE.Vector3(0, -0.3, 0) }, expl: { d: 31, el: 0.4, target: new THREE.Vector3(0, -0.4, 0) },
  land: { d: 34, el: 0.62, target: new THREE.Vector3(0, -2, 0) } };
const fit = () => (camera.aspect < 1 ? Math.min(1.7, 0.55 / camera.aspect + 0.3) : 1);
let camTween = null;
function goto(mode, instant = false) {
  if (land.ride && mode !== 'land') setRide(false);
  st.mode = mode; st.tTo = mode === 'expl' ? 1 : 0; land.to = mode === 'land' ? 1 : 0;
  controls.minDistance = mode === 'land' ? 2 : 5;
  if (!instant) toast(mode === 'land' ? 'LANDSCAPE · F TO RIDE THE CHAIN' : mode === 'expl' ? 'LAYERS' : 'FOLD');
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
  else if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); goto('fold'); }
  else if (e.code === 'KeyK') { pal = (pal + 1) % PALETTES.length; colorize(); }
  else if (e.code === 'KeyC') st.contacts = !st.contacts;
  else if (e.code === 'Space') { e.preventDefault(); st.spin = !st.spin; controls.autoRotate = st.spin && !land.ride; toast(st.spin ? 'SPIN ON' : 'SPIN OFF'); }
  else if (e.shiftKey && e.code === 'Digit2') { e.preventDefault(); goto(st.mode === 'land' ? 'fold' : 'land'); }
  else if (e.code === 'KeyF' && st.mode === 'land') { setRide(!land.ride); }
  else if (e.code === 'KeyB' && st.mode === 'land') { land.towersOn = !land.towersOn; toast(land.towersOn ? 'CITY' : 'TERRAIN'); }
  else if (e.key === 'Escape') { if (land.ride) setRide(false); else goto('fold'); }
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
  renderer.setSize(w, h, false); composer.setSize(w, h); bloom.setSize(w, h);
  camera.aspect = w / h; camera.fov = w < h ? 48 : 34; camera.updateProjectionMatrix();
  U.uScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
}
addEventListener('resize', resize); resize();

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!REDUCED) U.uTime.value += dt;
  if (st.D) {
    if (st.t !== st.tTo) { st.t = st.tTo > st.t ? Math.min(1, st.t + dt * 0.8) : Math.max(0, st.t - dt * 0.8); layout(); }
    if (st.draw < 1) st.draw = clamp((now - st.drawStart) / (2200 + st.L * 3));
    const d = 1 - Math.pow(1 - st.draw, 3);
    U.uDraw.value = d;
    G.tube.geometry.setDrawRange(0, Math.floor(d * G.tubeMeta.segs) * G.tubeMeta.radial * 6);
    if (land.a !== land.to) land.a = land.to > land.a ? Math.min(1, land.a + dt * 0.7) : Math.max(0, land.a - dt * 0.7);
    const la = ease(land.a), keepW = 1 - la, gn = G.gain;
    const fold = (1 - smooth(0, 0.4, st.t)) * keepW, expl = smooth(0.35, 0.95, st.t) * keepW;
    U.uDotOp.value = (0.55 + 0.45 * gn) * keepW;
    updateLand(dt, la);
    tubeMat.uniforms.uOpacity.value = fold * Math.pow(gn, 0.6); G.tube.visible = fold > 0.01;
    dustMat.uniforms.uOpacity.value = fold * gn * smooth(0.2, 1, st.draw); G.dust.visible = fold > 0.01;
    arcMat.uniforms.uOpacity.value = fold * gn * smooth(0.7, 1, st.draw); G.arcs.visible = st.contacts && fold > 0.01;
    G.chain.material.opacity = G.threads.material.opacity = expl * (0.5 + 0.5 * gn); G.hl.material.opacity = expl;
    G.chain.visible = G.threads.visible = expl > 0.01;
    for (const s of G.sheets) { const a = smooth(0.25, 0.9, st.t) * keepW; s.edge.material.opacity = (s.k === st.N ? 0.55 : 0.22) * a; s.edge.visible = a > 0.01; }
    placeLabels(expl);
  }
  if (camTween) {
    const u = clamp((now - camTween.start) / camTween.dur), e = easeInOut(u);
    camera.position.lerpVectors(camTween.p0, camTween.p1, e); controls.target.lerpVectors(camTween.t0, camTween.t1, e);
    if (u >= 1) camTween = null;
  }
  if (land.ride) rideStep(dt); else controls.update(dt);
  const cd = camera.position.distanceTo(controls.target), span = st.t > 0.5 ? 13 : 8;
  const fn = cd - span * 0.6, ff = cd + span * 1.6, la = ease(land.a);
  U.uNear.value = lerp(fn, land.ride ? 3 : cd - 12, la); U.uFar.value = lerp(ff, land.ride ? 34 : cd + 30, la);
  composer.render();
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
  if (q.has('t')) U.uTime.value = +q.get('t');
  if (q.has('still')) { st.spin = controls.autoRotate = false; }
  if (q.get('view') === 'explode') { st.draw = 1; goto('expl', true); }
  else if (q.get('view') === 'land') { st.draw = 1; goto('land', true); if (q.has('ride')) { setRide(true); land.s = +q.get('ride') || 0.3; } }
  else goto('fold', true);
  wake();
  requestAnimationFrame(frame);
})();
