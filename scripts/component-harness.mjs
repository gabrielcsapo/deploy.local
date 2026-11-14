// Execute component event handlers without a browser. Dependencies are explicit stubs;
// native dialog focus trapping and visual layout still require browser verification.
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('tsx')] }));
export async function componentHarness(entry, stubs, globals = {}) {
  let cursor = 0;
  const slots = [];
  let effects = [];
  const cleanups = [];
  const hooks = {
    createElement: require('react').createElement,
    createContext(value) {
      return { _currentValue: value };
    },
    useContext(context) {
      return context._currentValue;
    },
    useSyncExternalStore(_subscribe, _getSnapshot, getServerSnapshot) {
      return getServerSnapshot();
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (value) => {
          slots[index] = typeof value === 'function' ? value(slots[index]) : value;
        },
      ];
    },
    useRef(initial) {
      return hooks.useState(() => ({ current: initial }))[0];
    },
    useId() {
      return hooks.useState('fixture-id')[0];
    },
    // Recomputed on every render: the harness renders once per assertion.
    useMemo(fn) {
      return fn();
    },
    useCallback(fn) {
      return fn;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !deps || deps.some((dep, i) => !Object.is(dep, previous[i]))) {
        slots[index] = deps;
        effects.push(() => {
          cleanups[index]?.();
          cleanups[index] = fn();
        });
      }
    },
    Suspense: 'Suspense',
  };
  // Portals (dialogs, the search box) render their children in place: there is no DOM here.
  const modules = { react: hooks, 'react-dom': { createPortal: (node) => node }, ...stubs };
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    plugins: [
      {
        name: 'component-stubs',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (args.path in modules) return { path: args.path, namespace: 'stub' };
            if (args.path === 'react/jsx-runtime') return { path: args.path, external: true };
          });
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
            contents: Object.keys(modules[args.path])
              .map(
                (key) =>
                  `exports.${key} = modules[${JSON.stringify(args.path)}][${JSON.stringify(key)}];`,
              )
              .join('\n'),
          }));
          b.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
        },
      },
    ],
  });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    modules,
    console,
    URLSearchParams,
    URL,
    Error,
    setInterval,
    clearInterval,
    ...globals,
  });
  return {
    exports: module.exports,
    render(component, props = {}) {
      cursor = 0;
      return component(props);
    },
    effects() {
      const pending = effects;
      effects = [];
      pending.forEach((run) => run());
    },
    dispose() {
      cleanups.forEach((cleanup) => cleanup?.());
    },
  };
}
export function elements(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, type));
  if (tree.type === 'Dialog' && !tree.props.open) return type === 'Dialog' ? [tree] : [];
  return [
    ...(tree.type === type ? [tree] : []),
    ...Object.values(tree.props || {}).flatMap((value) => elements(value, type)),
  ];
}
export const uiStubs = Object.fromEntries(
  [
    'Action',
    'Banner',
    'Dialog',
    'Empty',
    'Field',
    'Group',
    'Icon',
    'Item',
    'Skeleton',
    'Setting',
    'Switch',
    'Glyph',
    'Head',
    'Sidebar',
    'Nav',
    'IconButton',
    'Status',
  ].map((name) => [name, name]),
);
export const settle = () => new Promise((resolve) => setImmediate(resolve));
