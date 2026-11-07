import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  HEALTH_EVENT_BATCH_SIZE,
  pruneHealthEventBatch,
  pruneHealthEvents,
} from './health-event-retention.ts';

test('retention bounds every scan, keeps recent health, other history and owner heads', async () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, type TEXT, createdAt TEXT);
      CREATE INDEX event_owner_cursor ON events(owner,cursor)`);
    const insert = db.prepare('INSERT INTO events(owner,type,createdAt) VALUES(?,?,?)');
    for (let i = 0; i < 600; i++) insert.run('a', 'v2.health', '2020-01-01');
    insert.run('only-health', 'v2.health', '2020-01-01');
    insert.run('a', 'v2.inbox', '2020-01-01');
    insert.run('a', 'v2.health', '2026-11-07T12:00:00.000Z');
    const first = pruneHealthEventBatch(db, 0, 603, '2026-11-07T11:00:00.000Z');
    assert.equal(first.cursor, HEALTH_EVENT_BATCH_SIZE);
    assert.equal(first.deleted, HEALTH_EVENT_BATCH_SIZE);
    assert.equal(await pruneHealthEvents(db, Date.parse('2026-11-07T12:00:00Z')), 350);
    assert.deepEqual(db.prepare('SELECT cursor FROM events ORDER BY cursor').all(), [
      { cursor: 601 },
      { cursor: 602 },
      { cursor: 603 },
    ]);
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
    assert.equal(insert.run('a', 'v2.health', '2026-11-07T12:00:16Z').lastInsertRowid, 604);
  } finally {
    db.close();
  }
});
