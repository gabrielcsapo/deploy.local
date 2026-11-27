// A model board's model, built in Blender: its pictures from four sides, its .glb and what the
// check reads (triangles, bounds, colours, where each picture's model and box fall). The model is
// design/models/<Name>.py (a bpy script, with pal() and part() to hand), .glb, .gltf or .blend.
// Builds are kept by what went in, so a board drawn twice, or before and after with the model
// unchanged, builds once.

import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __DESIGN_BLENDER_RUNNER__: string | undefined;

export const modelViews = ['front', 'side', 'three-quarter', 'top'] as const;
export type ModelView = (typeof modelViews)[number];
export const modelExtensions = ['py', 'glb', 'gltf', 'blend'] as const;

export type ModelPicture = {
  /** The share of the picture the model covers. */
  drawn: number;
  /** Left, top, right, bottom of the model in the picture, as fractions; null when nothing drew. */
  bounds: [number, number, number, number] | null;
  /** The picture's edges the model runs into (it is cut off there). */
  edges: ('top' | 'bottom' | 'left' | 'right')[];
  /** The declared box's eight corners in the picture, as fractions, and the box's edges. */
  box: [number, number][];
  boxEdges: [number, number][];
};

export type ModelStats = {
  model: string;
  /** The declared box, in metres: width, depth, height. */
  box: [number, number, number];
  /** The script failed: its error and the script's line. */
  error?: string;
  line?: number | null;
  tris?: number;
  objects?: number;
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  colours?: { colour: string; material: string; tris: number }[];
  uncoloured?: number;
  views?: Partial<Record<ModelView, ModelPicture>>;
};

export type ModelBuild = {
  stats: ModelStats;
  views: Partial<Record<ModelView, Buffer>>;
  glb: Buffer | null;
};

/** Why a model could not be built at all (no Blender here), as against a model that failed. */
export type ModelUnbuilt = { unbuilt: string };

/** "1x1x1", "2×1×0.5" or "2x1x0.5m": width, depth and height in metres. */
export function parseModelBox(value: string | null | undefined): [number, number, number] | null {
  const parts = String(value ?? '')
    .trim()
    .replace(/m$/i, '')
    .split(/\s*[x×]\s*/i)
    .map(Number);
  return parts.length === 3 && parts.every((n) => Number.isFinite(n) && n > 0)
    ? (parts as [number, number, number])
    : null;
}

/** The palette a kit's stylesheet declares (--pal-ink: #1d1b26), by name without the prefix. */
export function paletteOfCss(css: string) {
  const palette: Record<string, string> = {};
  for (const match of css.matchAll(/--pal-([a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})\b/gi))
    palette[match[1].toLowerCase()] ??= match[2].toLowerCase();
  return palette;
}

type Blender = { command: string; args: string[] } | null;
let found: Blender | undefined;

/**
 * How this computer runs Blender: DEPLOY_BLENDER (a blender binary, or a Python with the bpy
 * module), else blender on the PATH, else python3 with bpy. Null when there is none.
 */
export function findBlender(env: NodeJS.ProcessEnv = process.env): Blender {
  if (found !== undefined && env === process.env) return found;
  const runs = (command: string, args: string[]) => {
    try {
      return spawnSync(command, args, { stdio: 'ignore', timeout: 30_000 }).status === 0;
    } catch {
      return false;
    }
  };
  const asPython = (command: string) => ({ command, args: ['-I'] });
  const asBlender = (command: string) => ({
    command,
    args: ['-b', '--factory-startup', '--python-exit-code', '2', '--python'],
  });
  let result: Blender = null;
  const named = env.DEPLOY_BLENDER;
  if (named) {
    if (/python[0-9.]*$/i.test(named))
      result = runs(named, ['-c', 'import bpy']) ? asPython(named) : null;
    else result = runs(named, ['-b', '--version']) ? asBlender(named) : null;
  } else if (runs('blender', ['-b', '--version'])) result = asBlender('blender');
  else if (runs('python3', ['-c', 'import bpy'])) result = asPython('python3');
  if (env === process.env) found = result;
  return result;
}

/** The runner script: baked into the CLI, else in this checkout's bin/. */
function runnerPath(cacheDir: string) {
  if (typeof __DESIGN_BLENDER_RUNNER__ === 'string') {
    const path = join(cacheDir, `runner-${hash(__DESIGN_BLENDER_RUNNER__).slice(0, 12)}.py`);
    if (!existsSync(path)) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(path, __DESIGN_BLENDER_RUNNER__);
    }
    return path;
  }
  // From source it is beside this module; the built server runs from the release's own checkout.
  const besideSource = fileURLToPath(new URL('../../bin/design-blender.py', import.meta.url));
  return existsSync(besideSource) ? besideSource : join(process.cwd(), 'bin', 'design-blender.py');
}

const hash = (...parts: (string | Buffer)[]) => {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part).update('\0');
  return digest.digest('hex');
};

export const modelCacheDir = () => join(tmpdir(), 'deploy-design-models');

const running = new Map<string, Promise<ModelBuild | ModelUnbuilt>>();

/**
 * Builds one model, or returns the build already made from the same model, palette, box and
 * runner. A script that fails is a build too: its stats carry the error.
 */
export function buildModel(input: {
  name: string;
  ext: (typeof modelExtensions)[number];
  source: Buffer;
  palette: Record<string, string>;
  box: [number, number, number];
  size?: number;
  cacheDir?: string;
  blender?: Blender;
  timeoutMs?: number;
}): Promise<ModelBuild | ModelUnbuilt> {
  const cacheDir = input.cacheDir ?? modelCacheDir();
  const blender = input.blender === undefined ? findBlender() : input.blender;
  if (!blender)
    return Promise.resolve({
      unbuilt: 'No Blender here: install Blender, or pip install bpy, or set DEPLOY_BLENDER',
    });
  const runner = runnerPath(cacheDir);
  if (!existsSync(runner))
    return Promise.resolve({
      unbuilt: 'This deploy carries no Blender runner (bin/design-blender.py)',
    });
  const size = input.size ?? 576;
  const key = hash(
    readFileSync(runner),
    input.ext,
    input.source,
    JSON.stringify(input.palette),
    input.box.join('x'),
    String(size),
  ).slice(0, 24);
  const out = join(cacheDir, key);
  const done = readBuild(out);
  if (done) return Promise.resolve(done);
  if (!running.has(key)) {
    const job = (async () => {
      const work = join(cacheDir, `${key}.work`);
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      const model = join(work, `${input.name.replace(/[^A-Za-z0-9_-]/g, '_')}.${input.ext}`);
      writeFileSync(model, input.source);
      const args = [
        ...blender.args,
        runner,
        '--',
        '--model',
        model,
        '--out',
        work,
        '--box',
        input.box.join('x'),
        '--palette',
        JSON.stringify(input.palette),
        '--size',
        String(size),
      ];
      const failed = await new Promise<string | null>((resolve) =>
        execFile(
          blender.command,
          args,
          { timeout: input.timeoutMs ?? 180_000, maxBuffer: 1 << 26, cwd: work },
          (error, _stdout, stderr) =>
            resolve(
              error && !existsSync(join(work, 'stats.json')) ? tail(stderr || error.message) : null,
            ),
        ),
      );
      if (failed) {
        rmSync(work, { recursive: true, force: true });
        return { unbuilt: `Blender stopped: ${failed}` };
      }
      rmSync(join(work, model.split('/').pop()!), { force: true });
      rmSync(out, { recursive: true, force: true });
      // One rename, so a build is whole or absent.
      renameSync(work, out);
      return readBuild(out) ?? { unbuilt: 'Blender wrote no build' };
    })().finally(() => running.delete(key));
    running.set(key, job);
  }
  return running.get(key)!;
}

const tail = (text: string) =>
  text
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .slice(-2)
    .join(' ')
    .slice(0, 300);

function readBuild(out: string): ModelBuild | null {
  const statsPath = join(out, 'stats.json');
  if (!existsSync(statsPath)) return null;
  let stats: ModelStats;
  try {
    stats = JSON.parse(readFileSync(statsPath, 'utf8'));
  } catch {
    return null;
  }
  const views: ModelBuild['views'] = {};
  const files = new Set(readdirSync(out));
  for (const view of modelViews)
    if (files.has(`${view}.png`)) views[view] = readFileSync(join(out, `${view}.png`));
  const glb = files.has('model.glb') ? readFileSync(join(out, 'model.glb')) : null;
  return { stats, views, glb };
}

/**
 * The model a board names, from wherever its drawing reads design/ files at a commit: the first
 * of models/<Name>.py, .glb, .gltf and .blend that is there.
 */
export async function modelSource(
  name: string,
  read: (path: string) => Promise<Buffer | null> | Buffer | null,
) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
  for (const ext of modelExtensions) {
    const source = await read(`models/${name}.${ext}`);
    if (source) return { ext, source };
  }
  return null;
}

/** The three.js a model's preview page loads: one pinned release, from unpkg. */
export const threeVersion = '0.187.0';

/**
 * A page that turns a model in three.js, the .glb inside it so it opens from a file: drag to turn
 * it, scroll to come closer. It loads three.js from unpkg (`threeBase` points it elsewhere).
 */
export function modelPreviewPage(input: {
  name: string;
  glb: Buffer;
  stats?: ModelStats | null;
  threeBase?: string;
}) {
  const base = input.threeBase ?? `https://unpkg.com/three@${threeVersion}`;
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const stats = input.stats;
  const facts = [
    stats?.tris !== undefined ? `${stats.tris.toLocaleString('en-US')} triangles` : null,
    stats?.bounds
      ? `${stats.bounds.max.map((high, i) => (high - stats.bounds!.min[i]).toFixed(2)).join(' × ')} m`
      : null,
  ].filter(Boolean);
  const box = stats?.box ?? [1, 1, 1];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(input.name)}</title>
<style>
html,body{margin:0;height:100%;background:#f3f3f5;font:14px/1.4 system-ui,sans-serif;color:#1d1b26}
canvas{display:block}
header{position:fixed;left:16px;top:12px;pointer-events:none}
header h1{margin:0;font-size:16px;font-weight:600}
header p{margin:2px 0 0;color:#5b5868}
</style>
<script type="importmap">{"imports":{"three":"${base}/build/three.module.js","three/addons/":"${base}/examples/jsm/"}}</script>
</head>
<body>
<header><h1>${escape(input.name)}</h1><p>${escape(facts.join(' · '))}${facts.length ? ' · ' : ''}drag to turn, scroll to zoom</p></header>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const glb = '${input.glb.toString('base64')}';
const bytes = Uint8Array.from(atob(glb), (c) => c.charCodeAt(0));
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf3f3f5);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8698, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-3, 6, 4);
scene.add(sun);
// The box the model must fit (glTF is y-up: width x, height y, depth z), and the ground.
const [w, d, h] = ${JSON.stringify(box)};
const frame = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
  new THREE.LineDashedMaterial({ color: 0x2f6fde, dashSize: 0.05 * Math.max(w, h, d), gapSize: 0.04 * Math.max(w, h, d) }),
);
frame.position.y = h / 2;
frame.computeLineDistances();
scene.add(frame);
const size = Math.max(w, d, h, ...${JSON.stringify(stats?.bounds ? stats.bounds.max.map((high, i) => high - stats.bounds!.min[i]) : [])});
const grid = new THREE.GridHelper(size * 4, 8, 0xc9c6d2, 0xdedce4);
scene.add(grid);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, size / 100, size * 100);
camera.position.set(size * 1.8, size * 1.4, size * 2.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, h / 2, 0);
controls.update();
const draw = () => renderer.render(scene, camera);
controls.addEventListener('change', draw);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  draw();
});
new GLTFLoader().parse(bytes.buffer, '', (gltf) => {
  scene.add(gltf.scene);
  draw();
  document.body.dataset.loaded = 'true';
}, (error) => {
  document.body.dataset.loaded = 'failed';
  document.querySelector('header p').textContent = 'This model did not load: ' + error.message;
});
draw();
</script>
</body>
</html>
`;
}
