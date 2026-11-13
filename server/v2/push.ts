import { dispatch, routes } from '../routes.ts';
import { sendJson } from '../http.ts';
import {
  notificationPreferences,
  putNotificationPreferences,
  shouldNotify,
} from './phone-preferences.ts';
import { pairedDeviceForRequest, pairedDeviceActive } from './devices.ts';
import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:http2';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppHealth, InboxItem } from '../../shared/v2/contracts.ts';
import { cursor, db, events, list, save } from '../workspace/store.ts';
import { syncInbox } from './inbox.ts';
import { fail } from '../errors.ts';
import { getLive } from './live.ts';

type RequireAuth = (req: IncomingMessage, res: ServerResponse) => { username: string } | null;
type Device = {
  id: string;
  token: string;
  environment: 'sandbox' | 'production';
  registeredAt: number;
  scope?: string;
  pairedDeviceId?: string;
};
type PushPayload = {
  aps: {
    alert: { title: string; body: string };
    sound: string;
    category: string;
    'thread-id': string;
  };
  inboxItemId?: string;
  approveActionId?: string;
  notNowActionId?: string;
  appId?: string;
  deviceScope?: string;
};
export type APNsConfiguration = {
  key: KeyObject;
  keyId: string;
  teamId: string;
  topic: string;
  endpoint?: string;
};

export function pushConfiguration(env = process.env): APNsConfiguration | undefined {
  const { DEPLOY_APNS_KEY_PATH, DEPLOY_APNS_KEY_ID, DEPLOY_APNS_TEAM_ID, DEPLOY_APNS_TOPIC } = env;
  if (!DEPLOY_APNS_KEY_PATH || !DEPLOY_APNS_KEY_ID || !DEPLOY_APNS_TEAM_ID || !DEPLOY_APNS_TOPIC)
    return;
  const key = createPrivateKey(readFileSync(DEPLOY_APNS_KEY_PATH));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('APNs requires a P-256 .p8 signing key');
  return { key, keyId: DEPLOY_APNS_KEY_ID, teamId: DEPLOY_APNS_TEAM_ID, topic: DEPLOY_APNS_TOPIC };
}

export class APNsClient {
  private jwt?: { value: string; at: number };
  private config: APNsConfiguration;
  constructor(config: APNsConfiguration) {
    this.config = config;
  }
  authorization(now = Date.now()) {
    if (this.jwt && now - this.jwt.at < 50 * 60_000) return this.jwt.value;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const message = `${encode({ alg: 'ES256', kid: this.config.keyId })}.${encode({ iss: this.config.teamId, iat: Math.floor(now / 1000) })}`;
    const signature = sign('sha256', Buffer.from(message), {
      key: this.config.key,
      dsaEncoding: 'ieee-p1363',
    });
    this.jwt = { value: message + '.' + signature.toString('base64url'), at: now };
    return this.jwt.value;
  }
  async send(
    device: Device,
    payload: PushPayload,
    collapseId: string,
  ): Promise<{ status: number; reason?: string; timestamp?: number }> {
    const endpoint =
      this.config.endpoint ??
      (device.environment === 'sandbox'
        ? 'https://api.sandbox.push.apple.com'
        : 'https://api.push.apple.com');
    return new Promise((resolve, reject) => {
      const session = connect(endpoint);
      session.on('error', reject);
      session.setTimeout(10_000, () => session.destroy(new Error('APNs timed out')));
      const request = session.request({
        ':method': 'POST',
        ':path': '/3/device/' + device.token,
        authorization: 'bearer ' + this.authorization(),
        'apns-topic': this.config.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
        'apns-collapse-id': createHash('sha256').update(collapseId).digest('hex'),
      });
      let status = 0,
        body = '';
      request.on('response', (headers) => {
        status = Number(headers[':status']);
      });
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        if (body.length < 8192) body += chunk;
      });
      request.on('error', (error) => {
        session.destroy();
        reject(error);
      });
      request.on('end', () => {
        session.close();
        let result: { reason?: string; timestamp?: number } = {};
        try {
          result = JSON.parse(body || '{}');
        } catch {
          /* Status remains authoritative. */
        }
        resolve({ ...result, status });
      });
      request.end(
        JSON.stringify({ ...payload, ...(device.scope ? { deviceScope: device.scope } : {}) }),
      );
    });
  }
}

export function inboxPush(item: InboxItem): PushPayload {
  // Free-form questions and confirmation-required commands must be reviewed in the app.
  const primary = item.actions.find(
    (action) => action.primary && !action.confirm && action.id !== 'answer',
  );
  const dismiss = item.actions.find((action) => ['dismiss', 'skip', 'deny'].includes(action.id));
  return {
    aps: {
      alert: { title: item.title.slice(0, 160), body: item.text.slice(0, 700) },
      sound: 'default',
      category: primary && dismiss ? 'DEPLOY_DECISION' : 'DEPLOY_OPEN',
      'thread-id': 'waiting-on-you',
    },
    inboxItemId: item.id,
    ...(primary && dismiss ? { approveActionId: primary.id, notNowActionId: dismiss.id } : {}),
  };
}
function healthPush(app: AppHealth): PushPayload {
  return {
    aps: {
      alert: { title: `${app.appId} is failing`, body: app.summary.slice(0, 700) },
      sound: 'default',
      category: 'DEPLOY_OPEN',
      'thread-id': 'live',
    },
    appId: app.appId,
  };
}

export function registerDevice(owner: string, body: any, pairedDeviceId?: string) {
  if (typeof body?.token !== 'string' || !/^[a-f0-9]{64,200}$/i.test(body.token))
    fail('A hexadecimal APNs token is required');
  if (!['sandbox', 'production'].includes(body.environment))
    fail('environment must be sandbox or production');
  if (
    body.scope !== undefined &&
    (typeof body.scope !== 'string' || !/^[a-f0-9]{64}$/.test(body.scope))
  )
    fail('Invalid device scope');
  const token = body.token.toLowerCase();
  const id = createHash('sha256').update(token).digest('hex');
  db.transaction(() => {
    // A phone changing accounts must never keep receiving the previous account's decisions.
    db.prepare("DELETE FROM records WHERE kind='v2-device' AND id=? AND owner<>?").run(id, owner);
    if (!list('v2-push-cursor', owner).length)
      save('v2-push-cursor', owner, { id: 'cursor', cursor: cursor(owner) });
    save('v2-device', owner, {
      id,
      token,
      environment: body.environment,
      registeredAt: Date.now(),
      ...(pairedDeviceId ? { pairedDeviceId } : {}),
      ...(body.scope ? { scope: body.scope } : {}),
    });
  }).immediate();
  return { id };
}
export function removeDevice(owner: string, token: unknown) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64,200}$/i.test(token))
    fail('A hexadecimal APNs token is required');
  const id = createHash('sha256')
    .update((token as string).toLowerCase())
    .digest('hex');
  db.prepare("DELETE FROM records WHERE kind='v2-device' AND owner=? AND id=?").run(owner, id);
}

/** Durable event consumer also sees inbox writes from independent workspace workers. */
export async function deliverPushEvents(owner: string, client: Pick<APNsClient, 'send'>) {
  const saved = list('v2-push-cursor', owner)[0] ?? { id: 'cursor', cursor: cursor(owner) };
  for (const row of events(owner, saved.cursor)) {
    let payload: PushPayload | undefined;
    if (row.type === 'v2.inbox') {
      const item = row.payload.item as InboxItem;
      const current = list('v2-inbox', owner).find((entry) => entry.id === item.id);
      if (
        (!current || current.state === 'waiting') &&
        item.state === 'waiting' &&
        !list('v2-push-inbox', owner).some((entry) => entry.id === item.id)
      )
        if (shouldNotify(owner, 'decision', item.from, item.kind === 'rollback'))
          payload = inboxPush(item);
    } else if (row.type === 'v2.health') {
      const app = row.payload.app as AppHealth;
      const previous = list('v2-push-health', owner).find((entry) => entry.id === app.appId);
      if (app.state === 'failing' && previous?.state !== 'failing' && shouldNotify(owner, 'health'))
        payload = healthPush(app);
    }
    if (payload) {
      for (const device of list('v2-device', owner) as Device[]) {
        if (device.pairedDeviceId && !pairedDeviceActive(owner, device.pairedDeviceId)) {
          removeDevice(owner, device.token);
          continue;
        }
        // Persist per-device acknowledgement so a transient failure doesn't redeliver to peers.
        const deliveryId = `${row.cursor}:${device.id}`;
        if (list('v2-push-delivered', owner).some((entry) => entry.id === deliveryId)) continue;
        const response = await client.send(device, payload, payload.inboxItemId ?? payload.appId!);
        if (
          response.status === 410 ||
          response.reason === 'BadDeviceToken' ||
          response.reason === 'DeviceTokenNotForTopic'
        ) {
          if (!response.timestamp || device.registeredAt <= response.timestamp)
            removeDevice(owner, device.token);
        } else if (response.status !== 200) {
          // Leave cursor unchanged. The next tick retries; no token/key/payload in logs.
          throw new Error(
            `APNs delivery failed (${response.status}: ${response.reason ?? 'unavailable'})`,
          );
        }
        save('v2-push-delivered', owner, { id: deliveryId });
      }
    }
    db.transaction(() => {
      if (row.type === 'v2.inbox') save('v2-push-inbox', owner, { id: row.payload.item.id });
      if (row.type === 'v2.health')
        save('v2-push-health', owner, { id: row.payload.app.appId, state: row.payload.app.state });
      save('v2-push-cursor', owner, { id: 'cursor', cursor: row.cursor });
      db.prepare(
        "DELETE FROM records WHERE kind='v2-push-delivered' AND owner=? AND id LIKE ?",
      ).run(owner, `${row.cursor}:%`);
    }).immediate();
  }
}

let started = false;
function startPush() {
  if (started) return;
  started = true;
  let config: APNsConfiguration | undefined;
  try {
    config = pushConfiguration();
  } catch {
    console.warn('[push] Disabled: APNs signing key could not be loaded.');
    return;
  }
  if (!config) {
    console.info(
      '[push] Disabled: set DEPLOY_APNS_KEY_PATH, DEPLOY_APNS_KEY_ID, DEPLOY_APNS_TEAM_ID and DEPLOY_APNS_TOPIC.',
    );
    return;
  }
  const client = new APNsClient(config);
  let running = false;
  const failures = new Map<string, { count: number; retryAt: number }>();
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const owners = db
        .prepare("SELECT DISTINCT owner FROM records WHERE kind='v2-device'")
        .all() as { owner: string }[];
      for (const { owner } of owners) {
        if ((failures.get(owner)?.retryAt ?? 0) > Date.now()) continue;
        try {
          syncInbox(owner);
          await getLive(owner);
          await deliverPushEvents(owner, client);
          failures.delete(owner);
        } catch (error) {
          const count = (failures.get(owner)?.count ?? 0) + 1;
          failures.set(owner, { count, retryAt: Date.now() + Math.min(60_000, 1000 * 2 ** count) });
          console.warn('[push]', error instanceof Error ? error.message : 'Delivery will retry');
        }
      }
    } finally {
      running = false;
    }
  }, 1000);
  timer.unref();
}

// Importing the sub-router starts delivery even when all phones are asleep after a server restart.
startPush();
export async function pushApi(
  req: IncomingMessage,
  res: ServerResponse,
  requireAuth: RequireAuth,
): Promise<boolean> {
  const path = new URL(req.url!, 'http://localhost').pathname;
  if (!['/api/v2/devices', '/api/v2/notifications'].includes(path)) return false;
  const send = (body: unknown, status = 200) => {
    sendJson(res, body, status);
  };
  try {
    const auth = requireAuth(req, res);
    if (!auth) return true;
    if (req.headers['x-deploy-agent-token'] || req.headers['x-deploy-worker-token'])
      fail('Only signed-in users can register devices', 403);
    const route = routes<undefined>();
    const input = async () => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 4096) {
          req.resume();
          fail('Device body too large', 413);
        }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      return body;
    };
    await dispatch(
      [
        route({
          method: 'GET',
          path: '/api/v2/notifications',
          handler: () => send(notificationPreferences(auth.username)),
        }),
        route({
          method: 'PATCH',
          path: '/api/v2/notifications',
          input,
          handler: ({ input }) => send(putNotificationPreferences(auth.username, input)),
        }),
        route({
          method: 'POST',
          path: '/api/v2/devices',
          input,
          handler: ({ input }) =>
            send(registerDevice(auth.username, input, pairedDeviceForRequest(auth.username, req))),
        }),
        route({
          method: 'DELETE',
          path: '/api/v2/devices',
          input,
          handler: ({ input }) => {
            removeDevice(auth.username, input.token);
            send({ removed: true });
          },
        }),
      ],
      { notFound: () => send({ error: 'Method not allowed' }, 405) },
    )(req, res, undefined);
  } catch (error: any) {
    send({ error: error.message }, error.status ?? 400);
  }
  return true;
}
