import test from 'node:test';
import assert from 'node:assert/strict';
import { materialized } from './materialized.ts';

test('sync values, cadence, per-key isolation, invalidation and LRU eviction', () => {
  let time = 0;
  let computes = 0;
  const view = materialized((key: string) => ({ key, computes: ++computes }), {
    cadenceMs: 100,
    clock: () => time,
    maxEntries: 2,
  });
  const a = view.read('a');
  assert.equal(view.read('a'), a);
  time = 99;
  assert.equal(view.read('a'), a);
  const b = view.read('b');
  assert.notEqual(b, a);
  time = 100;
  assert.notEqual(view.read('a'), a);
  assert.equal(view.read('b'), b);
  view.invalidate('a');
  assert.equal(view.read('a').computes, 4);
  view.read('c');
  assert.equal(view.read('a').computes, 4, 'recent key retained');
  assert.equal(view.read('b').computes, 6, 'least recently read key evicted');
  view.invalidate();
  assert.equal(view.read('b').computes, 7);
});

test('concurrent async reads share computation; invalidation cannot resurrect old work', async () => {
  const resolvers: ((value: { generation: number }) => void)[] = [];
  const view = materialized(
    (_key: string) => new Promise<{ generation: number }>((resolve) => resolvers.push(resolve)),
    { cadenceMs: 10 },
  );
  const old = view.read('a');
  assert.equal(view.read('a'), old);
  view.invalidate('a');
  const current = view.read('a');
  resolvers[1]({ generation: 2 });
  await current;
  resolvers[0]({ generation: 1 });
  await old;
  assert.equal(view.read('a'), current);
});

test('failures retry, including rejection of an invalidated generation', async () => {
  let fail = true;
  const sync = materialized(
    () => {
      if (fail) throw new Error('retry');
      return 1;
    },
    { cadenceMs: 10 },
  );
  assert.throws(() => sync.read('a'), /retry/);
  fail = false;
  assert.equal(sync.read('a'), 1);
  let reject!: (error: Error) => void;
  let calls = 0;
  const view = materialized(
    () =>
      ++calls === 1
        ? new Promise<number>((_, no) => {
            reject = no;
          })
        : Promise.resolve(2),
    { cadenceMs: 100 },
  );
  const old = view.read('a');
  view.invalidate();
  const current = view.read('a');
  reject(new Error('old'));
  await assert.rejects(old, /old/);
  assert.equal(await current, 2);
  assert.equal(view.read('a'), current);
  const retry = materialized(
    async () => {
      throw new Error('failed');
    },
    { cadenceMs: 10 },
  );
  const first = retry.read('a');
  await assert.rejects(first);
  const second = retry.read('a');
  assert.notEqual(first, second);
  await assert.rejects(second);
});

test('deeply freezes shared sync and async results in tests', async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const view = materialized(() => [{ nested: { value: 1 } }], { cadenceMs: 100 });
  assert.throws(() => {
    view.read('a')[0].nested.value = 2;
  }, TypeError);
  const asyncView = materialized(async () => ({ nested: [1] }), { cadenceMs: 100 });
  const awaited = await asyncView.read('a');
  assert.throws(() => awaited.nested.push(2), TypeError);
});

test('in-flight sharing survives cache pressure and completion starts the cadence', async () => {
  let time = 0;
  const finish: (() => void)[] = [];
  const view = materialized(
    (_key: string) => new Promise<void>((resolve) => finish.push(resolve)),
    {
      cadenceMs: 100,
      clock: () => time,
      maxEntries: 1,
    },
  );
  const a = view.read('a');
  const b = view.read('b');
  time = 1000;
  assert.equal(view.read('a'), a);
  finish[0]();
  await a;
  time = 1099;
  assert.equal(view.read('a'), a);
  finish[1]();
  await b;
  const newA = view.read('a');
  assert.notEqual(newA, a);
  finish[2]();
  await newA;
});

test('uncommitted computations can consume a view but are not retained', () => {
  let value = 1;
  const view = materialized(() => ({ value }), { cadenceMs: 1000 });
  const committed = view.read('a');
  assert.equal(view.read('a', false), committed);
  view.invalidate('a');
  value = 2;
  assert.equal(view.read('a', false).value, 2);
  value = 1;
  assert.equal(view.read('a').value, 1);
});

test('immutable results are LRU bounded by count and retained bytes', async () => {
  const { immutable } = await import('./materialized.ts');
  let computes = 0;
  const view = immutable(
    (key: string) => {
      computes++;
      return key;
    },
    2,
    {
      maxWeight: 5,
      weigh: (value) => Buffer.byteLength(value),
    },
  );
  view.read('aa');
  view.read('bb');
  view.read('aa');
  assert.equal(computes, 2);
  view.read('cc'); // Evict bb, most recently used aa survives.
  view.read('aa');
  assert.equal(computes, 3);
  view.read('bb');
  assert.equal(computes, 4);
  view.read('cccc'); // Four bytes displace all two-byte entries, despite count < 2.
  view.read('bb');
  assert.equal(computes, 6);
  view.read('oversize');
  view.read('oversize');
  assert.equal(computes, 8, 'oversize values are returned but never retained');
  view.invalidate();
  view.read('bb');
  assert.equal(computes, 9);
});

test('targeted invalidation removes only matching settled and pending entries', async () => {
  const finish: ((value: number) => void)[] = [];
  const view = materialized((_key: string) => new Promise<number>((done) => finish.push(done)), {
    cadenceMs: 1000,
  });
  const a = view.read('a');
  const b = view.read('b');
  finish[1](2);
  await b;
  view.invalidateWhere((key) => key === 'a');
  finish[0](1);
  await a;
  assert.equal(view.read('b'), b);
  const freshA = view.read('a');
  assert.notEqual(freshA, a);
  finish[2](3);
  assert.equal(await freshA, 3);
});

test('strict observation cadence includes time spent computing', async () => {
  let time = 0;
  let computes = 0;
  const view = materialized(
    async () => {
      computes++;
      time += 60;
      return computes;
    },
    {
      cadenceMs: 100,
      cadenceFromStart: true,
      clock: () => time,
    },
  );
  assert.equal(await view.read('a'), 1);
  time = 99;
  assert.equal(await view.read('a'), 1);
  time = 100;
  assert.equal(await view.read('a'), 2);
});
