import type { Express, Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

type OwnerOptions = {
  rootDir: string;
  getWorkspaceIds: () => string[];
  stopWorkspace: (workspaceId: string) => { stopped: number; details: string[] };
  resumeCrawl: (workspaceId: string, taskId: string) => { task_id: string; resumed_from: string; status: string };
};

const COOKIE = 'vortex_owner';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const OWNER_SECRET = (process.env.OWNER_ACCESS_SECRET || '').trim();
const OWNER_TELEGRAM_ID = (process.env.OWNER_TELEGRAM_USER_ID || '').trim();
const LOG_CHAT_ID = (process.env.LOG_TELEGRAM_CHAT_ID || '').trim();
const CONFIGURED_LOG_THREAD_ID = Number(process.env.LOG_TELEGRAM_THREAD_ID || 0) || null;
let logThreadId: number | null = CONFIGURED_LOG_THREAD_ID;
const LOG_BOT_TOKEN = (process.env.LOG_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const messageIndexFile = (root: string) => path.join(root, 'data', 'owner-monitoring', 'telegram-message-index.json');
let polling = false;
let pollingOffset = 0;
const commandMenu = [
  { command: 'start', description: 'Show Vortex status, uptime and command menu' },
  { command: 'help', description: 'Explain all owner commands' },
  { command: 'workspaces', description: 'List known browser workspaces' },
  { command: 'userinfo', description: 'Get details for a Browser ID' },
  { command: 'botinfos', description: 'Export Telegram bot/channel configuration' },
  { command: 'logs', description: 'Reply to an action message to download its log' },
];

function safeJson(file: string, fallback: any = null): any {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}
function atomicJson(file: string, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomBytes(5).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
export function browserIdForWorkspace(workspaceId: string) { return 'BRW-' + workspaceId.replace(/-/g, '').slice(0, 10).toUpperCase(); }
function browserLabel(workspaceId: string) { return browserIdForWorkspace(workspaceId); }
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
export function appendOperationalDetail(root: string, actionId: string, line: string) {
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
    let result: any;
    try {
      result = await telegram('sendMessage', {
        chat_id: LOG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true,
        ...(logThreadId ? { message_thread_id: logThreadId } : {}),
      });
    } catch (threadError: any) {
      if (!logThreadId) throw threadError;
      logThreadId = null;
      if (actionId) appendOperationalDetail(root, actionId, 'Forum topic delivery failed; retrying in the main log group: ' + threadError.message);
      result = await telegram('sendMessage', { chat_id: LOG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true });
    }
    if (actionId && phase && result?.message_id) rememberMessage(root, result.message_id, actionId, phase);
    return result?.message_id ?? null;
  } catch (error: any) {
    console.error('[Owner monitoring] Telegram delivery failed:', error.message);
    if (actionId) appendOperationalDetail(root, actionId, 'Telegram delivery failed for ' + (phase || 'event') + ': ' + error.message);
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
    (detailLines.length ? '\n' + detailLines.map(x => html(x.slice(0, 350))).join('\n') : '');
  appendOperationalDetail(root, actionId, event.category + ' | ' + event.summary + ' | browser=' + browser + ' | ' + detailLines.join(' | '));
  const phase = event.phase || 'end';
  const withHelp = text + (event.workspaceId ? '\n\n<b>More info:</b> /userinfo ' + html(browser) + ' · reply with /logs for this action' : '');
  const messageText = withHelp.length > 3800 ? withHelp.slice(0, 3700) + '\n<i>Message shortened; reply with /logs for the complete action record.</i>' : withHelp;
  const messageId = await sendActionMessage(root, messageText, actionId, phase);
  if (messageId) appendOperationalDetail(root, actionId, 'Telegram ' + phase + '_message_id=' + messageId);
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
      effective_bot_source: settings.telegram_bot_token && settings.telegram_chat_id ? 'custom' : 'deployment_default',
      effective_channel_id: settings.telegram_chat_id || LOG_CHAT_ID || null,
      telegram_channel_title: metadata.telegram_channel_title || null,
      telegram_channel_username: metadata.telegram_channel_username || null,
      telegram_channel_type: metadata.telegram_channel_type || null,
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
      recent_logs: (() => { const file = path.join(base, 'logs', 'engine.jsonl'); if (!fs.existsSync(file)) return []; try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-200).map((line: string) => JSON.parse(line)).reverse(); } catch { return []; } })(),
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
async function sendDocument(chatId: string | number, file: string, caption: string, threadId?: number) {
  if (!LOG_BOT_TOKEN || !fs.existsSync(file)) return;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption.slice(0, 900));
  if (threadId || logThreadId) form.append('message_thread_id', String(threadId || logThreadId));
  const bytes = fs.readFileSync(file);
  form.append('document', new Blob([bytes]), path.basename(file));
  const send = async () => {
    const response = await fetch('https://api.telegram.org/bot' + LOG_BOT_TOKEN + '/sendDocument', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    return await response.json().catch(() => ({})) as any;
  };
  let data = await send();
  if (!data.ok && form.has('message_thread_id')) { form.delete('message_thread_id'); data = await send(); }
  if (!data.ok) throw new Error(data.description || 'sendDocument failed');
}
async function handleOwnerCommand(root: string, message: any, options: OwnerOptions) {
  if (!isOwnerTelegram(message?.from?.id)) return;
  const rawText = String(message.text || '').trim();
  const command = (rawText.split(/\s+/, 1)[0] || '').split('@')[0].toLowerCase();
  const args = rawText.split(/\s+/).slice(1);
  const chatId = message.chat?.id;
  const isLogGroup = Boolean(LOG_CHAT_ID && String(chatId) === LOG_CHAT_ID);
  const threadId = Number(message.message_thread_id || (isLogGroup ? logThreadId : 0) || 0) || undefined;
  if (!chatId) return;
  const uptimeSeconds = Math.floor(process.uptime());
  const uptime = [Math.floor(uptimeSeconds / 86400) + 'd', Math.floor((uptimeSeconds % 86400) / 3600) + 'h', Math.floor((uptimeSeconds % 3600) / 60) + 'm', (uptimeSeconds % 60) + 's'].join(' ');
  const sendReply = (reply: string) => telegram('sendMessage', { chat_id: chatId, text: reply, ...(threadId ? { message_thread_id: threadId } : {}) });
  if (command === '/start') {
    await sendReply('VORTEX OWNER MONITORING\n\nStatus: Online\nUptime: ' + uptime + '\nNode: ' + process.version + '\nStarted: ' + new Date(Date.now() - process.uptime() * 1000).toISOString() + '\nKnown browsers: ' + options.getWorkspaceIds().length + '\nLog destination: connected\n\nUse /help to see every command. Owner-only access is enabled.');
    return;
  }
  if (command === '/help') {
    await sendReply('VORTEX OWNER COMMANDS\n\n/start — Show online status, server uptime, start time, Node version and known browser count.\n/help — Show this command guide.\n/workspaces — List known Browser IDs, activity status, crawls and download-job counts.\n/userinfo BRW-XXXXXXXXXX — Receive a detailed workspace report; secrets are masked.\n/botinfos — Receive the Telegram bot/channel configuration inventory; tokens and API hashes are masked.\n/logs — Reply directly to a queue/crawl/download action message with /logs to receive its full .txt action log.\n\nCommands work only in the configured private log group and only for OWNER_TELEGRAM_USER_ID.');
    return;
  }
  if (command === '/logs') {
    if (!isLogGroup) { await sendReply('For /logs, reply to an action message in the configured operational log group.'); return; }
    const replyId = message.reply_to_message?.message_id;
    if (!replyId) { await telegram('sendMessage', { chat_id: chatId, text: 'Reply to an action start/end message with /logs to receive its .txt log.', ...(threadId ? { message_thread_id: threadId } : {}) }); return; }
    const item = safeJson(messageIndexFile(root), {})[String(replyId)];
    if (!item?.action_id) { await telegram('sendMessage', { chat_id: chatId, text: 'No action log is indexed for that message. Only monitoring action messages are supported.', ...(threadId ? { message_thread_id: threadId } : {}) }); return; }
    const file = path.join(root, 'data', 'owner-monitoring', 'actions', path.basename(item.action_id) + '.txt');
    await sendDocument(chatId, file, 'Action log: ' + item.action_id + ' (' + item.phase + ' message)', threadId);
    return;
  }
  if (command === '/userinfo') {
    const requested = args[0] || '';
    const id = options.getWorkspaceIds().find(x => browserLabel(x).toLowerCase() === requested.toLowerCase() || x.toLowerCase() === requested.toLowerCase());
    if (!id) { await telegram('sendMessage', { chat_id: chatId, text: 'Browser ID not found. Use /workspaces to list known browsers.', ...(threadId ? { message_thread_id: threadId } : {}) }); return; }
    const data = loadWorkspaceSummary(root, id);
    const report = JSON.stringify(data, null, 2);
    const file = path.join(root, 'data', 'owner-monitoring', 'exports', data.browser_id + '-userinfo.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, report);
    await sendDocument(chatId, file, 'Workspace details for ' + data.browser_id + '. Secrets are masked.', threadId);
    return;
  }
  if (command === '/botinfos') {
    const ids = options.getWorkspaceIds();
    const defaultBot: any = LOG_BOT_TOKEN ? await telegram('getMe', {}).catch(() => null) : null;
    const rows = ids.map(id => loadWorkspaceSummary(root, id)).map(x =>
      x.browser_id + ' | name=' + (x.name || 'null') + ' | bot=' + (x.settings.bot_username || (x.settings.effective_bot_source === 'deployment_default' ? defaultBot?.username : null) || 'null') +
      ' | bot_source=' + x.settings.effective_bot_source + ' | channel_name=' + (x.settings.telegram_channel_title || 'null') + ' | channel_type=' + (x.settings.telegram_channel_type || 'null') +
      ' | bot_token=' + (x.settings.telegram_bot_token_masked || 'null') + ' | user_channel=' + (x.settings.telegram_chat_id || 'null') + ' | effective_channel=' + (x.settings.effective_channel_id || 'null') +
      ' | api_id_configured=' + x.settings.telegram_api_id_configured + ' | api_hash_configured=' + x.settings.telegram_api_hash_configured +
      ' | thread_id=' + (x.settings.telegram_thread_id || 'null') + ' | auto_upload=' + x.settings.auto_upload_telegram +
      ' | invite=' + (x.settings.invite_link || 'null') + ' | invite_status=' + x.settings.invite_link_status
    );
    const file = path.join(root, 'data', 'owner-monitoring', 'exports', 'botinfos.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ['BROWSER TELEGRAM CONFIGURATIONS', 'Generated: ' + new Date().toISOString(), '', ...(rows.length ? rows : ['No browser workspaces found.']), '', 'Raw bot tokens and API hashes are never exported.'].join('\n'));
    await sendDocument(chatId, file, 'Telegram configuration inventory. Credentials are masked.', threadId);
    return;
  }
  if (command === '/workspaces') {
    const rows = options.getWorkspaceIds().map(id => loadWorkspaceSummary(root, id));
    const summary = rows.map(x => x.browser_id + ' — ' + x.status + ' — crawls ' + x.activity.crawl_count + ' — jobs ' + x.activity.download_jobs).join('\n') || 'No browser workspaces yet.';
    await telegram('sendMessage', { chat_id: chatId, text: summary.slice(0, 3900), ...(threadId ? { message_thread_id: threadId } : {}) });
    return;
  }
}
async function ensureLogForumTopic(root: string) {
  if (logThreadId || !LOG_BOT_TOKEN || !LOG_CHAT_ID) return;
  const stored = safeJson(path.join(root, 'data', 'owner-monitoring', 'log-topic.json'), {});
  if (String(stored.chat_id || '') === LOG_CHAT_ID && Number(stored.message_thread_id) > 0) { logThreadId = Number(stored.message_thread_id); return; }
  try {
    const topic: any = await telegram('createForumTopic', { chat_id: LOG_CHAT_ID, name: 'Vortex Operational Logs', icon_color: 7322096 });
    if (topic?.message_thread_id) {
      logThreadId = Number(topic.message_thread_id);
      atomicJson(path.join(root, 'data', 'owner-monitoring', 'log-topic.json'), { chat_id: LOG_CHAT_ID, message_thread_id: logThreadId, created_at: Date.now(), name: 'Vortex Operational Logs' });
      await telegram('sendMessage', { chat_id: LOG_CHAT_ID, message_thread_id: logThreadId, text: 'Vortex operational monitoring is connected. Server, browser, queue, crawl, download and Telegram events will appear in this topic.' });
    }
  } catch (error: any) {
    console.warn('[Owner monitoring] Could not create a forum topic; posting to the main log group instead:', error.message);
  }
}
export function initializeOwnerMonitoring(app: Express, options: OwnerOptions) {
  void ensureLogForumTopic(options.rootDir);
  app.post('/api/workspace/name', (req: Request, res: Response) => {
    const id = String((req as any).workspaceId || '');
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 50) : '';
    if (!id || !name) return res.status(400).json({ success: false, error: 'A non-empty browser name (max 50 characters) is required.' });
    const file = metaFile(options.rootDir, id); const metadata = safeJson(file, {});
    atomicJson(file, { ...metadata, name, name_updated_at: Date.now() });
    void recordOperationalEvent(options.rootDir, { category: 'workspace', summary: 'Browser workspace name updated', workspaceId: id, details: { name } });
    res.json({ success: true, browser_id: browserLabel(id), name });
  });
  app.get('/api/workspace/info', (req: Request, res: Response) => {
    const id = String((req as any).workspaceId || '');
    const metadata = id ? safeJson(metaFile(options.rootDir, id), {}) : {};
    res.json({ success: true, browser_id: id ? browserLabel(id) : null, name: metadata.name || null });
  });
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
    const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0].trim();
    const secure = req.secure || forwardedProto === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', COOKIE + '=' + encodeURIComponent(session) + '; Path=/api/owner; HttpOnly; SameSite=Strict' + secure + '; Max-Age=' + Math.floor(SESSION_TTL / 1000));
    res.json({ success: true, expires_at: Date.now() + SESSION_TTL });
  });
  app.post('/api/owner/logout', ownerMiddleware, (req: Request, res: Response) => {
    const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0].trim();
    const secure = req.secure || forwardedProto === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', COOKIE + '=; Path=/api/owner; HttpOnly; SameSite=Strict' + secure + '; Max-Age=0');
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
  app.post('/api/owner/workspaces/:browserId/name', ownerMiddleware, (req: Request, res: Response) => {
    const id = options.getWorkspaceIds().find(x => browserLabel(x).toLowerCase() === String(req.params.browserId).toLowerCase() || x === req.params.browserId);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 50) : '';
    if (!id) return res.status(404).json({ success: false, error: 'Browser workspace not found.' });
    if (!name) return res.status(400).json({ success: false, error: 'A non-empty name (max 50 characters) is required.' });
    const file = metaFile(options.rootDir, id); const metadata = safeJson(file, {});
    atomicJson(file, { ...metadata, name, name_updated_at: Date.now() });
    void recordOperationalEvent(options.rootDir, { category: 'workspace', summary: 'Owner assigned a browser workspace name', workspaceId: id, details: { name } });
    res.json({ success: true, name, browser_id: browserLabel(id) });
  });
  app.post('/api/owner/workspaces/:browserId/crawls/:taskId/resume', ownerMiddleware, (req: Request, res: Response) => {
    const id = options.getWorkspaceIds().find(x => browserLabel(x).toLowerCase() === String(req.params.browserId).toLowerCase() || x === req.params.browserId);
    if (!id) return res.status(404).json({ success: false, error: 'Browser workspace not found.' });
    try { res.status(202).json({ success: true, ...options.resumeCrawl(id, req.params.taskId) }); }
    catch (error: any) { res.status(/not found/i.test(error.message) ? 404 : 409).json({ success: false, error: error.message }); }
  });
  app.post('/api/owner/workspaces/:browserId/stop', ownerMiddleware, (req: Request, res: Response) => {
    const id = options.getWorkspaceIds().find(x => browserLabel(x).toLowerCase() === String(req.params.browserId).toLowerCase() || x === req.params.browserId);
    if (!id) return res.status(404).json({ success: false, error: 'Browser workspace not found.' });
    res.json({ success: true, ...options.stopWorkspace(id) });
  });

  if (LOG_BOT_TOKEN && OWNER_TELEGRAM_ID && LOG_CHAT_ID && !polling) {
    polling = true;
    void telegram('setMyCommands', { commands: commandMenu }).catch((error: any) => console.warn('[Owner monitoring] Could not publish Telegram command menu:', error.message));
    void (async () => {
      try {
        const webhook: any = await telegram('getWebhookInfo', {});
        if (webhook?.url) {
          const warning = 'Owner commands are not polling because this bot currently has a webhook configured. Use a dedicated LOG_TELEGRAM_BOT_TOKEN with no webhook, or remove the webhook for this bot before using /logs, /userinfo and /botinfos.';
          console.warn('[Owner monitoring] ' + warning);
          if (LOG_CHAT_ID) await telegram('sendMessage', { chat_id: LOG_CHAT_ID, text: warning });
          return;
        }
      } catch (error: any) {
        console.warn('[Owner monitoring] Could not inspect Telegram webhook state:', error.message);
      }
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
    const missing = [!LOG_BOT_TOKEN && 'LOG_TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN)', !OWNER_TELEGRAM_ID && 'OWNER_TELEGRAM_USER_ID', !LOG_CHAT_ID && 'LOG_TELEGRAM_CHAT_ID'].filter(Boolean);
    console.warn('[Owner monitoring] Telegram commands disabled; missing: ' + (missing.join(', ') || 'polling already started'));
  }
}
export function touchWorkspace(root: string, workspaceId: string) {
  const file = metaFile(root, workspaceId);
  const current = safeJson(file, {});
  const now = Date.now();
  atomicJson(file, { ...current, browser_id: browserLabel(workspaceId), created_at: current.created_at || now, last_seen_at: now });
}
export async function ensureWorkspaceTelegramInvite(root: string, workspaceId: string) {
  let discoveredBotUsername: string | null = null;
  let discoveredChannelTitle: string | null = null;
  let discoveredChannelUsername: string | null = null;
  let discoveredChannelType: string | null = null;
  const file = metaFile(root, workspaceId);
  const metadata = safeJson(file, {});
  const settings = safeJson(path.join(workspaceRoot(root, workspaceId), 'settings.json'), {});
  const customToken = String(settings.telegram_bot_token || '').trim();
  const customChannel = String(settings.telegram_chat_id || '').trim();
  const customPair = Boolean(customToken && customChannel);
  const token = customToken && customChannel ? customToken : LOG_BOT_TOKEN;
  const channel = customChannel || LOG_CHAT_ID;
  if (!token || !channel) return { status: 'incomplete', reason: 'No complete custom pair or deployment default bot/channel is configured.' };
  try {
    const meResponse = await fetch('https://api.telegram.org/bot' + token + '/getMe', { signal: AbortSignal.timeout(10000) });
    const me: any = await meResponse.json();
    if (!me.ok) throw new Error(me.description || 'Bot token rejected');
    discoveredBotUsername = me.result?.username || null;
    const chatResponse = await fetch('https://api.telegram.org/bot' + token + '/getChat?chat_id=' + encodeURIComponent(channel), { signal: AbortSignal.timeout(10000) });
    const chatData: any = await chatResponse.json();
    if (!chatData.ok) throw new Error(chatData.description || 'Bot cannot access the configured channel/chat.');
    discoveredChannelTitle = chatData.result?.title || chatData.result?.first_name || null;
    discoveredChannelUsername = chatData.result?.username || null;
    discoveredChannelType = chatData.result?.type || null;
    const inviteResponse = await fetch('https://api.telegram.org/bot' + token + '/createChatInviteLink', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: channel, name: 'Vortex ' + browserLabel(workspaceId), creates_join_request: false }),
      signal: AbortSignal.timeout(10000),
    });
    const invite: any = await inviteResponse.json();
    if (!invite.ok) throw new Error(invite.description || 'Bot cannot create channel invite link; grant invite-user permission.');
    const next = { ...metadata, telegram_bot_username: me.result?.username || null, telegram_channel_title: chatData.result?.title || chatData.result?.first_name || null, telegram_channel_username: chatData.result?.username || null, telegram_channel_type: chatData.result?.type || null, telegram_invite_link: invite.result?.invite_link || null, telegram_invite_link_status: 'created', telegram_invite_channel_id: channel, telegram_bot_source: customToken && customChannel ? 'custom' : 'deployment_default' };
    atomicJson(file, next);
    await recordOperationalEvent(root, { category: 'telegram-setup', summary: 'Resolved bot/channel verified and invite link created', workspaceId, details: { bot_username: next.telegram_bot_username, channel_id: channel, bot_source: next.telegram_bot_source, invite_link: next.telegram_invite_link } });
    return { status: 'created', bot_username: next.telegram_bot_username, invite_link: next.telegram_invite_link };
  } catch (error: any) {
    atomicJson(file, { ...metadata, telegram_bot_username: discoveredBotUsername || metadata.telegram_bot_username || null, telegram_channel_title: discoveredChannelTitle || metadata.telegram_channel_title || null, telegram_channel_username: discoveredChannelUsername || metadata.telegram_channel_username || null, telegram_channel_type: discoveredChannelType || metadata.telegram_channel_type || null, telegram_invite_link_status: 'failed', telegram_setup_error: String(error.message).slice(0, 300) });
    await recordOperationalEvent(root, { category: 'telegram-setup', summary: 'Could not create custom bot/channel invite link', workspaceId, details: { channel_id: channel, error: error.message } });
    return { status: 'failed', error: error.message };
  }
}
