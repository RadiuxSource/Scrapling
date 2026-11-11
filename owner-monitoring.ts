import type { Express, Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

type OwnerOptions = {
  rootDir: string;
  getWorkspaceIds: () => string[];
  stopWorkspace: (workspaceId: string) => { stopped: number; details: string[] };
};

const COOKIE = 'vortex_owner';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const OWNER_SECRET = (process.env.OWNER_ACCESS_SECRET || '').trim();
const OWNER_TELEGRAM_ID = (process.env.OWNER_TELEGRAM_USER_ID || '').trim();
const LOG_CHAT_ID = (process.env.LOG_TELEGRAM_CHAT_ID || '').trim();
const LOG_BOT_TOKEN = (process.env.LOG_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const messageIndexFile = (root: string) => path.join(root, 'data', 'owner-monitoring', 'telegram-message-index.json');
let polling = false;
let pollingOffset = 0;

function safeJson(file: string, fallback: any = null): any {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}
function atomicJson(file: string, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomBytes(5).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function browserLabel(workspaceId: string) { return 'BRW-' + workspaceId.replace(/-/g, '').slice(0, 10).toUpperCase(); }
function workspaceRoot(root: string, id: string) { return path.join(root, 'data', 'workspaces', id); }
function metaFile(root: string, id: string) { return path.join(workspaceRoot(root, id), 'workspace.json'); }
function mask(value: string) { if (!value) return null; return value.length <= 8 ? '••••' : value.slice(0, 4) + '••••' + value.slice(-4); }
function sign(value: string) { return createHmac('sha256', OWNER_SECRET).update(value).digest('hex'); }
function issueSession() { const expires = Date.now() + SESSION_TTL; const payload = String(expires); return payload + '.' + sign(payload); }
function validSession(value: string) {
  if (!OWNER_SECRET) return false;
  const [expires, signature] = value.split('.');
  if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(sign(expires), 'hex'), supplied = Buffer.from(signature, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
function isOwnerTelegram(fromId: unknown) {
  return Boolean(OWNER_TELEGRAM_ID && String(fromId) === OWNER_TELEGRAM_ID);
}
function html(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c] || c));
}
async function telegram(method: string, body: Record<string, any>) {
  if (!LOG_BOT_TOKEN) return null;
  const response = await fetch('https://api.telegram.org/bot' + LOG_BOT_TOKEN + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || 'Telegram ' + method + ' failed (' + response.status + ')');
  return data.result;
}
function appendActionLog(root: string, actionId: string, line: string) {
  const file = path.join(root, 'data', 'owner-monitoring', 'actions', actionId + '.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, '[' + new Date().toISOString() + '] ' + line.replace(/[\r\n]+/g, ' ') + '\n');
  return file;
}
function rememberMessage(root: string, messageId: number, actionId: string, phase: 'start' | 'end') {
  const file = messageIndexFile(root);
  const index = safeJson(file, {});
  index[String(messageId)] = { action_id: actionId, phase, saved_at: Date.now() };
  const keys = Object.keys(index);
  for (const key of keys.slice(0, Math.max(0, keys.length - 10000))) delete index[key];
  atomicJson(file, index);
}
async function sendActionMessage(root: string, text: string, actionId?: string, phase?: 'start' | 'end') {
  if (!LOG_BOT_TOKEN || !LOG_CHAT_ID) return null;
  try {
    const result: any = await telegram('sendMessage', {
      chat_id: LOG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true,
    });
    if (actionId && phase && result?.message_id) rememberMessage(root, result.message_id, actionId, phase);
    return result?.message_id ?? null;
  } catch (error: any) {
    console.error('[Owner monitoring] Telegram delivery failed:', error.message);
    return null;
  }
}
export async function recordOperationalEvent(root: string, event: {
  category: string; summary: string; workspaceId?: string; actionId?: string;
  phase?: 'start' | 'end'; details?: Record<string, unknown>;
}) {
  const actionId = event.actionId || ('evt_' + Date.now() + '_' + randomBytes(4).toString('hex'));
  const browser = event.workspaceId ? browserLabel(event.workspaceId) : 'SERVER';
  const detailLines = Object.entries(event.details || {}).map(([key, value]) => key + ': ' + String(value ?? 'null'));
  const text = '<b>' + html(event.category.toUpperCase()) + '</b>\n' +
    '<b>Browser:</b> <code>' + html(browser) + '</code>\n' +
    '<b>Event:</b> ' + html(event.summary) + '\n' +
    '<b>Action ID:</b> <code>' + html(actionId) + '</code>\n' +
    '<b>Time:</b> ' + new Date().toISOString() +
    (detailLines.length ? '\n' + detailLines.map(x => html(x)).join('\n') : '');
  appendActionLog(root, actionId, event.category + ' | ' + event.summary + ' | browser=' + browser + ' | ' + detailLines.join(' | '));
  const messageId = await sendActionMessage(root, text, event.actionId ? actionId : undefined, event.phase);
  return { actionId, messageId };
}
function loadWorkspaceSummary(root: string, id: string) {
  const base = workspaceRoot(root, id);
  const metadata = safeJson(metaFile(root, id), {});
  const settings = safeJson(path.join(base, 'settings.json'), {});
  const tasks = safeJson(path.join(base, 'logs', 'crawl-tasks.json'), []);
  const jobsDir = path.join(base, 'logs', 'jobs');
  const jobs = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).filter(x => x.endsWith('.json')).map(x => safeJson(path.join(jobsDir, x), null)).filter(Boolean) : [];
  const queue = safeJson(path.join(root, 'logs', 'nonstop-queue-' + id + '.json'), null);
  const reportsDir = path.join(base, 'reports'), downloadsDir = path.join(base, 'downloads');
  const countFiles = (dir: string) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => fs.statSync(path.join(dir, x)).isFile()).length : 0;
  const activeTasks = (Array.isArray(tasks) ? tasks : []).filter((x: any) => x?.status === 'running');
  const recentErrors = [
    ...(Array.isArray(tasks) ? tasks.filter((x: any) => x?.error).map((x: any) => ({ at: x.finished_at || x.started_at, type: 'crawl', id: x.task_id, message: String(x.error).slice(0, 500) })) : []),
    ...jobs.filter((x: any) => x?.error).map((x: any) => ({ at: x.finished_at || x.started_at, type: 'download', id: x.job_id, message: String(x.error).slice(0, 500) })),
  ].sort((a: any, b: any) => (b.at || 0) - (a.at || 0)).slice(0, 20);
  return {
    browser_id: browserLabel(id), workspace_id: id,
    name: metadata.name || null, created_at: metadata.created_at || null, last_seen_at: metadata.last_seen_at || null,
    status: metadata.last_seen_at && Date.now() - metadata.last_seen_at < 5 * 60 * 1000 ? 'recently_active' : 'inactive',
    settings: {
      telegram_bot_configured: Boolean(settings.telegram_bot_token),
      telegram_bot_token_masked: mask(settings.telegram_bot_token || ''),
      telegram_chat_id: settings.telegram_chat_id || null,
      telegram_api_id_configured: Boolean(settings.telegram_api_id),
      telegram_api_hash_configured: Boolean(settings.telegram_api_hash),
      telegram_thread_id: settings.telegram_thread_id || null,
      auto_upload_telegram: Boolean(settings.auto_upload_telegram),
      bot_username: metadata.telegram_bot_username || null,
      invite_link: metadata.telegram_invite_link || null,
      invite_link_status: metadata.telegram_invite_link_status || 'not_checked',
    },
    activity: {
      crawl_count: Array.isArray(tasks) ? tasks.length : 0, active_crawls: activeTasks,
      recent_crawls: (Array.isArray(tasks) ? tasks : []).slice(-20).reverse(),
      download_jobs: jobs.length, recent_jobs: jobs.sort((a: any, b: any) => (b.started_at || 0) - (a.started_at || 0)).slice(0, 20),
      queue: queue ? { is_running: Boolean(queue.is_running), total_items: queue.total_items || 0, current_index: queue.current_index || 0, completed_count: queue.completed_count || 0, failed_count: queue.failed_count || 0, pending_count: Array.isArray(queue.pending_items) ? queue.pending_items.length : 0, current_item: queue.current_item?.title || null, saved_at: queue.saved_at || null } : null,
      errors: recentErrors, reports: countFiles(reportsDir), downloads: countFiles(downloadsDir),
    },
  };
}
function ownerMiddleware(req: Request, res: Response, next: NextFunction) {
  const cookie = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
  let value = '';
  try { value = decodeURIComponent(cookie); } catch {}
  if (!validSession(value)) return res.status(401).json({ success: false, error: 'Owner authentication required.' });
  next();
}
async function sendDocument(chatId: string | number, file: string, caption: string) {
  if (!LOG_BOT_TOKEN || !fs.existsSync(file)) return;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption.slice(0, 900));
  const bytes = fs.readFileSync(file);
  form.append('document', new Blob([bytes]), path.basename(file));
  const response = await fetch('https://api.telegram.org/bot' + LOG_BOT_TOKEN + '/sendDocument', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  const data: any = await response.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || 'sendDocument failed');
}
async function handleOwnerCommand(root: string, message: any, options: OwnerOptions) {
  if (!isOwnerTelegram(message?.from?.id)) return;
  const text = String(message.text || '').trim();
  const chatId = message.chat?.id;
  if (!chatId) return;
  if (text.startsWith('/logs')) {
    const replyId = message.reply_to_message?.message_id;
    if (!replyId) { await telegram('sendMessage', { chat_id: chatId, text: 'Reply to an action start/end message with /logs to receive its .txt log.' }); return; }
    const item = safeJson(messageIndexFile(root), {})[String(replyId)];
    if (!item?.action_id) { await telegram('sendMessage', { chat_id: chatId, text: 'No action log is indexed for that message. Only monitoring action messages are supported.' }); return; }
    const file = path.join(root, 'data', 'owner-monitoring', 'actions', path.basename(item.action_id) + '.txt');
    await sendDocument(chatId, file, 'Action log: ' + item.action_id + ' (' + item.phase + ' message)');
    return;
  }
  if (text.startsWith('/userinfo')) {
    const requested = text.split(/\s+/)[1] || '';
    const id = options.getWorkspaceIds().find(x => browserLabel(x).toLowerCase() === requested.toLowerCase() || x.toLowerCase() === requested.toLowerCase());
    if (!id) { await telegram('sendMessage', { chat_id: chatId, text: 'Browser ID not found. Use /workspaces to list known browsers.' }); return; }
    const data = loadWorkspaceSummary(root, id);
    const report = JSON.stringify(data, null, 2);
    const file = path.join(root, 'data', 'owner-monitoring', 'exports', data.browser_id + '-userinfo.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, report);
    await sendDocument(chatId, file, 'Workspace details for ' + data.browser_id + '. Secrets are masked.');
    return;
  }
  if (text.startsWith('/botinfos')) {
    const ids = options.getWorkspaceIds();
    const rows = ids.map(id => loadWorkspaceSummary(root, id)).map(x =>
      x.browser_id + ' | name=' + (x.name || 'null') + ' | bot=' + (x.settings.bot_username || 'unknown') +
      ' | token=' + (x.settings.telegram_bot_token_masked || 'null') + ' | channel=' + (x.settings.telegram_chat_id || 'null') +
      ' | invite=' + (x.settings.invite_link || 'null') + ' | invite_status=' + x.settings.invite_link_status
    );
    const file = path.join(root, 'data', 'owner-monitoring', 'exports', 'botinfos.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ['BROWSER TELEGRAM CONFIGURATIONS', 'Generated: ' + new Date().toISOString(), '', ...(rows.length ? rows : ['No browser workspaces found.']), '', 'Raw bot tokens and API hashes are never exported.'].join('\n'));
    await sendDocument(chatId, file, 'Telegram configuration inventory. Credentials are masked.');
    return;
  }
  if (text.startsWith('/workspaces')) {
    const rows = options.getWorkspaceIds().map(id => loadWorkspaceSummary(root, id));
    const summary = rows.map(x => x.browser_id + ' — ' + x.status + ' — crawls ' + x.activity.crawl_count + ' — jobs ' + x.activity.download_jobs).join('\n') || 'No browser workspaces yet.';
    await telegram('sendMessage', { chat_id: chatId, text: summary.slice(0, 3900) });
    return;
  }
  if (text.startsWith('/help')) {
    await telegram('sendMessage', { chat_id: chatId, text: '/workspaces — list browser workspaces\n/userinfo <browserid> — detailed workspace report\n/botinfos — Telegram configuration inventory\nReply to an action message with /logs — get its .txt log' });
  }
}
export function initializeOwnerMonitoring(app: Express, options: OwnerOptions) {
  app.get('/api/telegram/default-bot', async (_req: Request, res: Response) => {
    if (!LOG_BOT_TOKEN) return res.json({ success: true, configured: false, username: null });
    try {
      const me = await telegram('getMe', {});
      res.json({ success: true, configured: true, username: me?.username || null, display_name: me?.first_name || null });
    } catch {
      res.json({ success: true, configured: true, username: null, error: 'Default bot is configured but Telegram identity lookup failed.' });
    }
  });
  app.post('/api/owner/login', (req: Request, res: Response) => {
    const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
    const now = Date.now();
    const limit = rateLimits.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
    if (now > limit.resetAt) { limit.count = 0; limit.resetAt = now + 15 * 60 * 1000; }
    if (limit.count >= 8) return res.status(429).json({ success: false, error: 'Too many login attempts. Try again later.' });
    limit.count++; rateLimits.set(ip, limit);
    const supplied = typeof req.body?.secret === 'string' ? req.body.secret : '';
    const expected = Buffer.from(OWNER_SECRET), actual = Buffer.from(supplied);
    if (!OWNER_SECRET || expected.length !== actual.length || !timingSafeEqual(expected, actual)) return res.status(401).json({ success: false, error: 'Invalid owner secret.' });
    const session = issueSession();
    res.setHeader('Set-Cookie', COOKIE + '=' + encodeURIComponent(session) + '; Path=/api/owner; HttpOnly; SameSite=Strict; Secure; Max-Age=' + Math.floor(SESSION_TTL / 1000));
    res.json({ success: true, expires_at: Date.now() + SESSION_TTL });
  });
  app.post('/api/owner/logout', ownerMiddleware, (_req: Request, res: Response) => {
    res.setHeader('Set-Cookie', COOKIE + '=; Path=/api/owner; HttpOnly; SameSite=Strict; Secure; Max-Age=0');
    res.json({ success: true });
  });
  app.get('/api/owner/summary', ownerMiddleware, (_req: Request, res: Response) => {
    const workspaces = options.getWorkspaceIds().map(id => loadWorkspaceSummary(options.rootDir, id));
    res.json({ success: true, server: { uptime_seconds: Math.floor(process.uptime()), node_version: process.version, started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(), log_bot_configured: Boolean(LOG_BOT_TOKEN), log_chat_configured: Boolean(LOG_CHAT_ID), owner_telegram_configured: Boolean(OWNER_TELEGRAM_ID) }, workspaces });
  });
  app.get('/api/owner/workspaces/:browserId', ownerMiddleware, (req: Request, res: Response) => {
    const id = options.getWorkspaceIds().find(x => browserLabel(x).toLowerCase() === String(req.params.browserId).toLowerCase() || x === req.params.browserId);
    if (!id) return res.status(404).json({ success: false, error: 'Browser workspace not found.' });
    res.json({ success: true, workspace: loadWorkspaceSummary(options.rootDir, id) });
  });
  app.post('/api/owner/workspaces/:browserId/stop', ownerMiddleware, (req: Request, res: Response) => {
    const id = options.getWorkspaceIds().find(x => browserLabel(x).toLowerCase() === String(req.params.browserId).toLowerCase() || x === req.params.browserId);
    if (!id) return res.status(404).json({ success: false, error: 'Browser workspace not found.' });
    res.json({ success: true, ...options.stopWorkspace(id) });
  });

  if (LOG_BOT_TOKEN && OWNER_TELEGRAM_ID && !polling) {
    polling = true;
    void (async () => {
      while (polling) {
        try {
          const response = await fetch('https://api.telegram.org/bot' + LOG_BOT_TOKEN + '/getUpdates?timeout=25&offset=' + pollingOffset + '&allowed_updates=%5B%22message%22%5D', { signal: AbortSignal.timeout(35000) });
          const data: any = await response.json();
          if (data.ok && Array.isArray(data.result)) {
            for (const update of data.result) {
              pollingOffset = Math.max(pollingOffset, Number(update.update_id || 0) + 1);
              if (update.message) {
                try { await handleOwnerCommand(options.rootDir, update.message, options); }
                catch (error: any) { console.error('[Owner monitoring] Command failed:', error.message); }
              }
            }
          } else await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (error: any) {
          if (polling) { console.error('[Owner monitoring] Telegram polling error:', error.message); await new Promise(resolve => setTimeout(resolve, 5000)); }
        }
      }
    })();
  } else {
    console.warn('[Owner monitoring] Telegram commands disabled until LOG bot token and OWNER_TELEGRAM_USER_ID are configured.');
  }
}
export function touchWorkspace(root: string, workspaceId: string) {
  const file = metaFile(root, workspaceId);
  const current = safeJson(file, {});
  const now = Date.now();
  atomicJson(file, { ...current, browser_id: browserLabel(workspaceId), created_at: current.created_at || now, last_seen_at: now });
}
export async function ensureWorkspaceTelegramInvite(root: string, workspaceId: string) {
  const file = metaFile(root, workspaceId);
  const metadata = safeJson(file, {});
  const settings = safeJson(path.join(workspaceRoot(root, workspaceId), 'settings.json'), {});
  const customToken = String(settings.telegram_bot_token || '').trim();
  const customChannel = String(settings.telegram_chat_id || '').trim();
  const token = customToken && customChannel ? customToken : LOG_BOT_TOKEN;
  const channel = customChannel || LOG_CHAT_ID;
  if (!token || !channel) return { status: 'incomplete', reason: 'No complete custom pair or deployment default bot/channel is configured.' };
  try {
    const meResponse = await fetch('https://api.telegram.org/bot' + token + '/getMe', { signal: AbortSignal.timeout(10000) });
    const me: any = await meResponse.json();
    if (!me.ok) throw new Error(me.description || 'Bot token rejected');
    const inviteResponse = await fetch('https://api.telegram.org/bot' + token + '/createChatInviteLink', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: channel, name: 'Vortex ' + browserLabel(workspaceId), creates_join_request: false }),
      signal: AbortSignal.timeout(10000),
    });
    const invite: any = await inviteResponse.json();
    if (!invite.ok) throw new Error(invite.description || 'Bot cannot create channel invite link; grant invite-user permission.');
    const next = { ...metadata, telegram_bot_username: me.result?.username || null, telegram_invite_link: invite.result?.invite_link || null, telegram_invite_link_status: 'created', telegram_invite_channel_id: channel, telegram_bot_source: customToken && customChannel ? 'custom' : 'deployment_default' };
    atomicJson(file, next);
    await recordOperationalEvent(root, { category: 'telegram-setup', summary: 'Resolved bot/channel verified and invite link created', workspaceId, details: { bot_username: next.telegram_bot_username, channel_id: channel, bot_source: next.telegram_bot_source, invite_link: next.telegram_invite_link } });
    return { status: 'created', bot_username: next.telegram_bot_username, invite_link: next.telegram_invite_link };
  } catch (error: any) {
    atomicJson(file, { ...metadata, telegram_invite_link_status: 'failed', telegram_setup_error: String(error.message).slice(0, 300) });
    await recordOperationalEvent(root, { category: 'telegram-setup', summary: 'Could not create custom bot/channel invite link', workspaceId, details: { channel_id: channel, error: error.message } });
    return { status: 'failed', error: error.message };
  }
}
