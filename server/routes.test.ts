import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { compilePath, dispatch, routes } from './routes.ts';

function request(method: string, url: string, body = '') {
  return {
    method,
    url,
    async *iterator() {
      if (body) yield Buffer.from(body);
    },
  } as unknown as IncomingMessage;
}
const res = {} as ServerResponse;

test('patterns take one segment for :name and the rest for :name*', () => {
  assert.deepEqual(compilePath('/a/:id/b')('/a/x%2Fy/b'), { id: 'x%2Fy' });
  assert.equal(compilePath('/a/:id/b')('/a/x/y/b'), null);
  assert.deepEqual(
    compilePath('/npm/:name*/versions/:v/deprecate')('/npm/@s/p/versions/1/deprecate'),
    {
      name: '@s/p',
      v: '1',
    },
  );
  assert.deepEqual(compilePath('/npm/:name*')('/npm/@s/p'), { name: '@s/p' });
  assert.equal(compilePath('/npm/:name*')('/npm/'), null);
  assert.equal(compilePath('/a.b')('/aXb'), null);
});

test('routes run in order, by method, with input, and fall through on false', async () => {
  const seen: string[] = [];
  const route = routes<{ who: string }>();
  const handle = dispatch(
    [
      route({
        method: 'GET',
        path: '/x/:id',
        handler: ({ params }) => seen.push(`get ${params.id}`),
      }),
      route({
        method: ['POST', 'PUT'],
        path: '/x/:id',
        input: async (req) => {
          let text = '';
          for await (const chunk of req.iterator()) text += chunk;
          return JSON.parse(text) as { n: number };
        },
        handler: ({ params, input, context }) =>
          seen.push(`write ${params.id} ${input.n} ${context.who}`),
      }),
      route({ method: '*', path: '/x/:id', handler: () => false }),
      route({
        method: '*',
        path: '/x/:id',
        handler: ({ req }) => seen.push(`other ${req.method}`),
      }),
    ],
    { scope: '/x/', notFound: ({ path }) => seen.push(`404 ${path}`) },
  );
  assert.equal(await handle(request('GET', '/x/1?q=1'), res, { who: 'a' }), true);
  assert.equal(await handle(request('PUT', '/x/2', '{"n":3}'), res, { who: 'b' }), true);
  assert.equal(await handle(request('DELETE', '/x/3'), res, { who: 'c' }), true);
  assert.equal(await handle(request('GET', '/x/'), res, { who: 'd' }), true);
  assert.equal(await handle(request('GET', '/y/1'), res, { who: 'e' }), false);
  assert.deepEqual(seen, ['get 1', 'write 2 3 b', 'other DELETE', '404 /x/']);
});

test('without notFound an unmatched request is not handled', async () => {
  const route = routes<null>();
  const handle = dispatch([route({ method: 'GET', path: '/only', handler: () => undefined })]);
  assert.equal(await handle(request('POST', '/only'), res, null), false);
  assert.equal(await handle(request('GET', '/only'), res, null), true);
});
