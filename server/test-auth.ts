import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Provision the first owner exactly as the local installer and /setup do. The
// subprocess keeps the test coordinator's database separate from this process.
export async function setupTestAccount(
  origin: string,
  dataDirectory: string,
  username = 'test-admin',
  password = 'test-password-123',
) {
  const module = new URL('./v2/setup.ts', import.meta.url).href;
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const { issueSetupCode } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(issueSetupCode()));`,
    ],
    { env: { ...process.env, DEPLOY_DATA_DIR: dataDirectory }, encoding: 'utf8' },
  );
  const { code } = JSON.parse(output.trim().split('\n').at(-1)!);
  const response = await fetch(`${origin}/api/v2/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, username, password }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return { username, token: body.token as string };
}

export function testAuthHeaders(account: { username: string; token: string }) {
  return { 'x-deploy-username': account.username, 'x-deploy-token': account.token };
}
