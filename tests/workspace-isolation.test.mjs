import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

test('reports API strips absolute filesystem paths', async () => {
  const initial = await fetch(`${baseUrl}/api/reports`);
  const cookie = cookieFrom(initial);
  const workspaceId = cookie.slice('vortex_workspace='.length).split('.')[0];
  const reportsDir = path.join(process.cwd(), 'data', 'workspaces', workspaceId, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, 'ci-path-redaction.json'), JSON.stringify({
    output_filename: 'sample-video.mp4',
    output_file: path.join(reportsDir, '..', 'downloads', 'sample-video.mp4'),
    output_path: '/srv/private/workspace/downloads/sample-video.mp4',
    file_path: '/srv/private/workspace/secret.txt',
  }));

  const response = await request('/api/reports', cookie);
  assert.equal(response.status, 200);
  const reports = (await response.json()).reports;
  const report = reports.find((item) => item.report_id === 'ci-path-redaction');
  assert.ok(report);
  assert.equal(report.output_file, 'sample-video.mp4');
  assert.equal(Object.hasOwn(report, 'output_path'), false);
  assert.equal(Object.hasOwn(report, 'file_path'), false);
  assert.equal(JSON.stringify(report).includes('/srv/private'), false);
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


test('queue restore diagnostics identify the signed browser workspace', async () => {
  const initial = await fetch(`${baseUrl}/api/nonstop-queue/restore-status`);
  const cookie = cookieFrom(initial);
  const workspaceId = cookie.slice('vortex_workspace='.length).split('.')[0];
  const response = await request('/api/nonstop-queue/restore-status', cookie);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.success, true);
  assert.equal(data.restore.workspace_id, workspaceId);
  assert.equal(data.restore.browser_id, `BRW-${workspaceId.replace(/-/g, '').slice(0, 10).toUpperCase()}`);
  assert.equal(typeof data.restore.message, 'string');
  assert.ok(data.restore.message.includes(data.restore.browser_id));
});


test('nonstop queue is not accepted without a verified durable Supabase backup', async () => {
  const initial = await fetch(`${baseUrl}/api/nonstop-queue/status`);
  const cookie = cookieFrom(initial);
  const response = await request('/api/download-all-nonstop', cookie, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videos: [{ media_url: 'https://example.com/video.mp4', title: 'CI backup test' }] }),
  });
  assert.equal(response.status, 503);
  const data = await response.json();
  assert.equal(data.success, false);
  assert.match(data.error, /durably backed up to Supabase/i);
  const status = await request('/api/nonstop-queue/status', cookie);
  const queue = (await status.json()).queue;
  assert.equal(queue.is_running, true);
  assert.equal(queue.durable_backup.confirmed, false);
});
