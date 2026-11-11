import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';

const port = 43100 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let serverOutput = '';

function cookieFrom(response) {
  const header = response.headers.get('set-cookie') || '';
  const match = header.match(/vortex_workspace=([^;]+)/);
  assert.ok(match, 'server must issue a workspace cookie');
  return `vortex_workspace=${match[1]}`;
}

async function request(path, cookie, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('cookie', cookie);
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}

before(async () => {
  server = spawn(process.execPath, ['dist-server/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      WORKSPACE_SECRET: 'ci-workspace-isolation-test-secret',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      WORKSPACE_MIGRATION_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Test server exited early:\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/logs`);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Test server did not become ready:\n${serverOutput}`);
});

after(async () => {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    delay(5_000),
  ]);
  if (server.exitCode === null) server.kill('SIGKILL');
});

test('issues distinct signed browser workspaces and private API cache headers', async () => {
  const firstResponse = await fetch(`${baseUrl}/api/logs`);
  const secondResponse = await fetch(`${baseUrl}/api/logs`);
  const firstCookie = cookieFrom(firstResponse);
  const secondCookie = cookieFrom(secondResponse);

  assert.notEqual(firstCookie, secondCookie, 'separate browser clients must receive separate workspaces');
  assert.match(firstResponse.headers.get('set-cookie') || '', /HttpOnly/);
  assert.match(firstResponse.headers.get('set-cookie') || '', /SameSite=Lax/);
  assert.match(firstResponse.headers.get('cache-control') || '', /private/);
  assert.match(firstResponse.headers.get('cache-control') || '', /no-store/);
  assert.match(firstResponse.headers.get('vary') || '', /Cookie/i);

  const firstAgain = await request('/api/logs', firstCookie);
  const secondAgain = await request('/api/logs', secondCookie);
  assert.equal(firstAgain.status, 200);
  assert.equal(secondAgain.status, 200);
  assert.equal(firstAgain.headers.get('set-cookie'), null, 'valid workspace cookie should be retained');
});

test('settings and Telegram secrets stay inside their browser workspace', async () => {
  const firstInit = await fetch(`${baseUrl}/api/settings`);
  const firstCookie = cookieFrom(firstInit);
  const secondInit = await fetch(`${baseUrl}/api/settings`);
  const secondCookie = cookieFrom(secondInit);

  const save = await request('/api/settings', firstCookie, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      default_resolution: '720p',
      telegram_bot_token: 'ci-private-telegram-token',
      telegram_api_hash: 'ci-private-api-hash',
    }),
  });
  assert.equal(save.status, 200);

  const firstSettingsResponse = await request('/api/settings', firstCookie);
  const secondSettingsResponse = await request('/api/settings', secondCookie);
  const firstSettings = (await firstSettingsResponse.json()).settings;
  const secondSettings = (await secondSettingsResponse.json()).settings;

  assert.equal(firstSettings.default_resolution, '720p');
  assert.equal(secondSettings.default_resolution, 'best');
  assert.equal(firstSettings.telegram_bot_token, '');
  assert.equal(firstSettings.telegram_api_hash, '');
  assert.equal(firstSettings.telegram_credentials_configured, false);
  assert.equal(JSON.stringify(firstSettings).includes('ci-private-telegram-token'), false);
  assert.equal(JSON.stringify(firstSettings).includes('ci-private-api-hash'), false);
});

test('tampered workspace cookies are rejected and replaced', async () => {
  const initial = await fetch(`${baseUrl}/api/logs`);
  const cookie = cookieFrom(initial);
  const value = cookie.slice('vortex_workspace='.length);
  const tamperedValue = value.slice(0, -1) + (value.endsWith('0') ? '1' : '0');
  const response = await request('/api/logs', `vortex_workspace=${tamperedValue}`);

  assert.equal(response.status, 200);
  const replacementCookie = cookieFrom(response);
  assert.notEqual(replacementCookie, `vortex_workspace=${tamperedValue}`);
});

test('workspace APIs do not reveal jobs or crawl tasks from another workspace', async () => {
  const firstInit = await fetch(`${baseUrl}/api/jobs`);
  const firstCookie = cookieFrom(firstInit);
  const secondInit = await fetch(`${baseUrl}/api/jobs`);
  const secondCookie = cookieFrom(secondInit);

  const firstJobs = await request('/api/jobs', firstCookie);
  const secondJobs = await request('/api/jobs', secondCookie);
  assert.equal(firstJobs.status, 200);
  assert.equal(secondJobs.status, 200);
  assert.ok(Array.isArray((await firstJobs.json()).jobs));
  assert.ok(Array.isArray((await secondJobs.json()).jobs));

  const foreignJob = await request('/api/jobs/ci-foreign-job', secondCookie, { method: 'DELETE' });
  assert.equal(foreignJob.status, 404);

  const foreignCrawl = await request('/api/scrape/status/crawl_ci_foreign', secondCookie);
  assert.equal(foreignCrawl.status, 404);
});
