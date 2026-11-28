// What the check says about a model board (platform=model): the model is there and builds, it fits
// the box the board gives it (size=, in metres) without running off any picture, it keeps to its
// triangle budget (tris=) and to the kit's palette, it fills its box and stands on the ground.
// Plain arithmetic on what Blender measured (bin/design-blender.py, via model-build).
import type { Finding } from './board-quality.ts';
import type { ModelSheet } from './check-drawing.ts';
import type { ModelView } from './model-build.ts';

const rgb = (value: string) => {
  const hex = value.replace('#', '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const far = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const metres = (n: number) => `${Math.round(n * 100) / 100} m`;
const viewWords: Record<ModelView, string> = {
  front: 'the front',
  side: 'the side',
  'three-quarter': 'the three-quarter view',
  top: 'the top',
  bottom: 'the view from underneath',
};
const axes = ['wide', 'deep', 'tall'];

export function modelFindings(input: { file: string; title: string; model: ModelSheet }) {
  const { file, title, model } = input;
  const problems: Finding[] = [];
  const notes: Finding[] = [];
  const name = model.name ?? 'The model';
  const finding = (code: string, label: string, detail: string, short: string, fix: string) => ({
    code,
    file,
    board: title,
    scheme: 'light' as const,
    label,
    detail,
    short,
    fix,
  });
  const missing = [
    model.missing,
    model.box ? null : 'its size= gives no box to fit (width x depth x height, in metres)',
  ].filter(Boolean) as string[];
  if (missing.length)
    problems.push(
      finding(
        'model_missing',
        `${title} does not say which model it shows, or in what box`,
        missing.join('; '),
        'model or box missing',
        'give the board meta model=<Name> and size=<w>x<d>x<h> (metres), and put the model in design/models/<Name>.py (or .glb, .gltf, .blend)',
      ),
    );
  if (model.unbuilt) {
    notes.push(
      finding(
        'model_not_drawn',
        `${name} is not drawn on ${title}`,
        model.unbuilt,
        'model not drawn',
        'install Blender, or pip install bpy, or point DEPLOY_BLENDER at either, and check again',
      ),
    );
    return { problems, notes };
  }
  const stats = model.stats;
  if (!stats) return { problems, notes };
  if (stats.error) {
    problems.push(
      finding(
        'model_build_failed',
        `${name} did not build`,
        `${stats.error}${stats.line ? ` (line ${stats.line} of design/models/${stats.model})` : ''}`,
        'model did not build',
        'fix the model script, then check again',
      ),
    );
    return { problems, notes };
  }
  const box = model.box ?? stats.box;
  const bounds = stats.bounds;
  if (bounds && model.box) {
    // The box stands on the ground at the origin, centred: x and y from -half to half, z from 0.
    const limits = [
      [-box[0] / 2, box[0] / 2],
      [-box[1] / 2, box[1] / 2],
      [0, box[2]],
    ];
    const sides = [
      ['left', 'right'],
      ['front', 'back'],
      ['bottom', 'top'],
    ];
    const over: string[] = [];
    for (let axis = 0; axis < 3; axis++) {
      const slack = Math.max(0.005, box[axis] * 0.01);
      const under = limits[axis][0] - bounds.min[axis];
      const past = bounds.max[axis] - limits[axis][1];
      if (under > slack && axis !== 2) over.push(`${metres(under)} past the ${sides[axis][0]}`);
      if (past > slack) over.push(`${metres(past)} past the ${sides[axis][1]}`);
    }
    // Which parts reach past the box, the furthest first: the script's names for them.
    const outside = (stats.parts ?? [])
      .map((part) => {
        let reach = 0;
        for (let axis = 0; axis < 3; axis++) {
          const slack = Math.max(0.005, box[axis] * 0.01);
          if (axis !== 2) reach = Math.max(reach, limits[axis][0] - part.min[axis] - slack);
          reach = Math.max(reach, part.max[axis] - limits[axis][1] - slack);
        }
        return { name: part.name, reach };
      })
      .filter((part) => part.reach > 0)
      .sort((a, b) => b.reach - a.reach);
    if (over.length && outside.length)
      over.push(
        `the part${outside.length === 1 ? '' : 's'} past it: ${outside
          .slice(0, 5)
          .map((part) => part.name)
          .join(', ')}${outside.length > 5 ? ` and ${outside.length - 5} more` : ''}`,
      );
    const cut = Object.entries(stats.views ?? {})
      .filter(([, picture]) => picture?.edges.length)
      .map(([view, picture]) => `${viewWords[view as ModelView]} (${picture!.edges.join(', ')})`);
    if (cut.length) over.push(`cut off in ${cut.join(', ')}`);
    if (over.length)
      problems.push(
        finding(
          'model_out_of_bounds',
          `${name} does not fit its ${box.join(' × ')} m box`,
          over.join('; '),
          'outside its box',
          'scale or move the parts so the model stands inside its box, or give the board the size it is meant to be',
        ),
      );
    const fill = [0, 1, 2].map((axis) => (bounds.max[axis] - bounds.min[axis]) / box[axis]);
    if (Math.max(...fill) < 0.5)
      notes.push(
        finding(
          'model_framing',
          `${name} is small in its box`,
          `it is ${fill.map((share, axis) => `${Math.round(share * 100)}% as ${axes[axis]}`).join(', ')} as its box, so it reads small in every picture`,
          'small in its box',
          'make the box the size the model is (size=) or the model the size of its box',
        ),
      );
    const ground = bounds.min[2];
    if (Math.abs(ground) > Math.max(0.01, box[2] * 0.01))
      notes.push(
        finding(
          'model_off_ground',
          ground > 0 ? `${name} floats above the ground` : `${name} sinks into the ground`,
          `its lowest point is ${metres(Math.abs(ground))} ${ground > 0 ? 'above' : 'below'} the ground (z = 0), where an engine stands it`,
          ground > 0 ? 'floats' : 'sinks',
          'move it so its lowest point is at z = 0, unless it is meant to hang',
        ),
      );
  }
  if (model.budget && (stats.tris ?? 0) > model.budget)
    problems.push(
      finding(
        'model_over_budget',
        `${name} is over its triangle budget`,
        `${stats.tris!.toLocaleString('en-US')} triangles, after modifiers, for a budget of ${model.budget.toLocaleString('en-US')}`,
        'over budget',
        'use fewer sides on round parts, drop bevels and hidden faces, or raise tris= if the budget was wrong',
      ),
    );
  const palette = Object.entries(model.palette);
  if (palette.length) {
    const off = (stats.colours ?? [])
      .filter((entry) => !palette.some(([, colour]) => far(rgb(colour), rgb(entry.colour)) <= 3))
      .map((entry) => `${entry.material} ${entry.colour} (${entry.tris} triangles)`);
    if (stats.uncoloured) off.push(`${stats.uncoloured} triangles with no material`);
    if (off.length)
      problems.push(
        finding(
          'model_off_palette',
          `${name} has colours that are not in the palette`,
          off.slice(0, 4).join('; ') + (off.length > 4 ? ` and ${off.length - 4} more` : ''),
          'off palette',
          "paint every part with pal('<name>') from the kit's --pal-* colours",
        ),
      );
  }
  const flush = stats.flush ?? [];
  if (flush.length) {
    const said = flush
      .slice(0, 3)
      .map((pair) => `${pair.a} and ${pair.b} (${Math.max(1, Math.round(pair.area * 10000))} cm²)`);
    problems.push(
      finding(
        'model_flush_faces',
        `${name} has faces that flicker`,
        `where parts in two colours lie flush, in one plane: ${said.join(', ')}${flush.length > 3 ? ` and ${flush.length - 3} more` : ''}. The surface flickers between the colours in every engine and speckles in the pictures`,
        'flush faces',
        'let one part sit a hair (a millimetre or two) inside or outside the other, or leave out the face nobody sees',
      ),
    );
  }
  return { problems, notes };
}
