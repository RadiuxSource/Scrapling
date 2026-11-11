import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = process.cwd();
const DOWNLOADS_DIR = path.join(ROOT_DIR, 'downloads');
const REPORTS_DIR = path.join(ROOT_DIR, 'reports');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');

// Ensure directories exist
[DOWNLOADS_DIR, REPORTS_DIR, LOGS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

app.use(express.json({ limit: '10mb' }));

let isShuttingDown = false;
let httpServer: ReturnType<typeof app.listen> | null = null;
const SHUTDOWN_GRACE_MS = 24_000;

app.use((req, res, next) => {
  if (isShuttingDown) {
    return res.status(503).json({ success: false, error: 'Server is restarting; please retry shortly.' });
  }
  next();
});

// In-memory active download jobs tracker
interface JobStatus {
  job_id: string;
  title: string;
  media_url: string;
  format_id?: string;
  status: 'queued' | 'starting' | 'downloading' | 'processing_ffmpeg' | 'uploading_telegram' | 'completed' | 'failed';
  progress_percent: number;
  speed_mbps: number;
  eta_seconds: number;
  total_bytes: number;
  output_filename?: string;
  output_path?: string;
  error?: string;
  started_at: number;
  finished_at?: number;
}

const workspaceJobs = new Map<string, Map<string, JobStatus>>();
function getWorkspaceId(): string {
  return workspaceContext.getStore() || 'system';
}
function workspaceStoragePaths(workspaceId = getWorkspaceId()) {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new Error('Invalid browser workspace identifier');
  const root = path.join(ROOT_DIR, 'data', 'workspaces', workspaceId);
  const paths = { root, downloads: path.join(root, 'downloads'), reports: path.join(root, 'reports'), logs: path.join(root, 'logs') };
  [paths.downloads, paths.reports, paths.logs, path.join(paths.logs, 'jobs')].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  return paths;
}
function workspaceSettingsFile(workspaceId = getWorkspaceId()) {
  return path.join(workspaceStoragePaths(workspaceId).root, 'settings.json');
}
function getWorkspaceJobs(): Map<string, JobStatus> {
  const workspaceId = getWorkspaceId();
  let jobs = workspaceJobs.get(workspaceId);
  if (!jobs) { jobs = new Map<string, JobStatus>(); workspaceJobs.set(workspaceId, jobs); }
  return jobs;
}

// Logs are partitioned by a signed, anonymous browser workspace cookie.
// AsyncLocalStorage carries the requesting workspace into background promises
// and Python-runner callbacks without changing the extraction/queue code.
type EngineLog = { timestamp: string; level: 'info' | 'warn' | 'error'; message: string };
const workspaceLogs = new Map<string, EngineLog[]>();
const workspaceContext = new AsyncLocalStorage<string>();
const WORKSPACE_COOKIE_NAME = 'vortex_workspace';
const WORKSPACE_SECRET = process.env.WORKSPACE_SECRET || randomBytes(32).toString('hex');
if (!process.env.WORKSPACE_SECRET) {
  console.warn('[Workspace] WORKSPACE_SECRET is not configured; browser workspace cookies will not survive a server restart. Set a stable random secret in the deployment environment.');
}

function signWorkspaceId(workspaceId: string): string {
  return createHmac('sha256', WORKSPACE_SECRET).update(workspaceId).digest('hex');
}

function isValidWorkspaceCookie(value: string): string | null {
  const separator = value.lastIndexOf('.');
  if (separator < 0) return null;
  const workspaceId = value.slice(0, separator);
  const suppliedSignature = value.slice(separator + 1);
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId) || !/^[0-9a-f]{64}$/i.test(suppliedSignature)) return null;
  const expected = Buffer.from(signWorkspaceId(workspaceId), 'hex');
  const supplied = Buffer.from(suppliedSignature, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied) ? workspaceId : null;
}

app.use((req, res, next) => {
  const cookieHeader = req.headers.cookie || '';
  const cookieValue = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${WORKSPACE_COOKIE_NAME}=`))
    ?.slice(WORKSPACE_COOKIE_NAME.length + 1);
  let workspaceId: string | null = null;
  if (cookieValue) {
    try {
      workspaceId = isValidWorkspaceCookie(decodeURIComponent(cookieValue));
    } catch {
      workspaceId = null;
    }
  }

  if (!workspaceId) {
    workspaceId = randomUUID();
    const signature = signWorkspaceId(workspaceId);
    const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0].trim();
    const secure = req.secure || forwardedProto === 'https' ? '; Secure' : '';
    res.append('Set-Cookie', `${WORKSPACE_COOKIE_NAME}=${workspaceId}.${signature}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
  }

  (req as any).workspaceId = workspaceId;
  workspaceContext.run(workspaceId, next);
});

// Workspace API responses contain private user data. Prevent browsers and
// shared reverse-proxy caches from reusing one workspace's response for another.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.vary('Cookie');
  next();
});

interface CrawlTask {
  task_id: string;
  status: 'running' | 'completed' | 'failed';
  started_at: number;
  finished_at?: number;
  result?: any;
  error?: string;
}
const workspaceCrawlTasks = new Map<string, Map<string, CrawlTask>>();
const activeCrawlTaskIds = new Map<string, string>();
function crawlTasksFile(workspaceId: string) {
  return path.join(workspaceStoragePaths(workspaceId).logs, 'crawl-tasks.json');
}
function persistWorkspaceCrawlTasks(workspaceId: string) {
  const tasks = workspaceCrawlTasks.get(workspaceId);
  if (!tasks) return;
  const target = crawlTasksFile(workspaceId);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Array.from(tasks.values()), null, 2));
  fs.renameSync(temporary, target);
}
function getWorkspaceCrawlTasks(workspaceId = getWorkspaceId()): Map<string, CrawlTask> {
  let tasks = workspaceCrawlTasks.get(workspaceId);
  if (!tasks) {
    tasks = new Map<string, CrawlTask>();
    const file = crawlTasksFile(workspaceId);
    if (fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (Array.isArray(saved)) {
          for (const item of saved) {
            if (!item || typeof item.task_id !== 'string' || !item.task_id.startsWith('crawl_')) continue;
            const task: CrawlTask = item;
            if (task.status === 'running') {
              task.status = 'failed';
              task.error = 'The server restarted while this crawl was running. Start the crawl again; completed download queues remain independently recoverable.';
              task.finished_at = Date.now();
            }
            if (task.status === 'completed' || task.status === 'failed') tasks.set(task.task_id, task);
          }
        }
      } catch (error: any) {
        console.warn(`[Workspace] Could not restore crawl task history for ${workspaceId}: ${error.message}`);
      }
    }
    workspaceCrawlTasks.set(workspaceId, tasks);
    persistWorkspaceCrawlTasks(workspaceId);
  }
  return tasks;
}


function addLog(level: 'info' | 'warn' | 'error', message: string) {
  const entry: EngineLog = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  const workspaceId = workspaceContext.getStore() || 'system';
  const logs = workspaceLogs.get(workspaceId) || [];
  logs.push(entry);
  if (logs.length > 300) logs.shift();
  workspaceLogs.set(workspaceId, logs);
}

// Parsed link sessions are private to each anonymous browser workspace.
interface ParsedLinkSession {
  url: string; domain: string; parsedAt: number;
  outputFiles: Set<string>; reportFiles: Set<string>; jobIds: Set<string>;
}
const workspaceParsedLinkSessions = new Map<string, ParsedLinkSession[]>();
function getParsedLinkSessions(workspaceId = getWorkspaceId()): ParsedLinkSession[] {
  let sessions = workspaceParsedLinkSessions.get(workspaceId);
  if (!sessions) { sessions = []; workspaceParsedLinkSessions.set(workspaceId, sessions); }
  return sessions;
}
function registerParsedLink(rawUrl: string): ParsedLinkSession | undefined {
  const cleanUrl = (rawUrl || '').trim();
  if (!cleanUrl) return;
  const workspaceId = getWorkspaceId(), sessions = getParsedLinkSessions(workspaceId);
  let domain = cleanUrl;
  try { domain = new URL(cleanUrl).hostname; } catch {}
  const last = sessions[sessions.length - 1];
  if (last && (last.url === cleanUrl || last.domain === domain)) { last.parsedAt = Date.now(); return last; }
  const session: ParsedLinkSession = { url: cleanUrl, domain, parsedAt: Date.now(), outputFiles: new Set<string>(), reportFiles: new Set<string>(), jobIds: new Set<string>() };
  sessions.push(session);
  addLog('info', `[Storage Manager] Registered parsed website (#${sessions.length}): ${cleanUrl}`);
  if (sessions.length > 2) purgeOlderSessionsData(workspaceId);
  return session;
}
function purgeOlderSessionsData(workspaceId = getWorkspaceId()) {
  const sessions = getParsedLinkSessions(workspaceId);
  if (sessions.length <= 2) return;
  const storage = workspaceStoragePaths(workspaceId);
  const oldSessions = sessions.slice(0, -2), keptSessions = sessions.slice(-2);
  const keptUrls = new Set(keptSessions.map(x => x.url)), keptDomains = new Set(keptSessions.map(x => x.domain));
  let purgedFiles = 0, purgedReports = 0, purgedJobs = 0;
  for (const session of oldSessions) {
    for (const name of session.outputFiles) {
      const target = path.join(storage.downloads, path.basename(name));
      if (fs.existsSync(target)) { try { fs.unlinkSync(target); purgedFiles++; } catch {} }
    }
    for (const name of session.reportFiles) {
      const target = path.join(storage.reports, path.basename(name));
      if (fs.existsSync(target)) { try { fs.unlinkSync(target); purgedReports++; } catch {} }
    }
    for (const id of session.jobIds) {
      getWorkspaceJobs().delete(id); purgedJobs++;
      const target = path.join(storage.logs, 'jobs', `${id}.json`);
      if (fs.existsSync(target)) { try { fs.unlinkSync(target); } catch {} }
    }
  }
  try {
    for (const name of fs.readdirSync(storage.reports).filter(x => x.endsWith('.json'))) {
      const target = path.join(storage.reports, name);
      try {
        const report = JSON.parse(fs.readFileSync(target, 'utf-8'));
        const source = report.site_url || report.page_url || report.source_url || '';
        let keep = Array.from(keptUrls).some(url => source && (source.includes(url) || url.includes(source)));
        if (!keep && source) { try { keep = keptDomains.has(new URL(source).hostname); } catch {} }
        if (!keep && source) {
          if (report.output_filename) {
            const video = path.join(storage.downloads, path.basename(report.output_filename));
            if (fs.existsSync(video)) { try { fs.unlinkSync(video); purgedFiles++; } catch {} }
          }
          const output = typeof report.output_file === 'string' ? path.resolve(report.output_file) : '';
          if (output.startsWith(storage.downloads + path.sep) && fs.existsSync(output)) { try { fs.unlinkSync(output); purgedFiles++; } catch {} }
          fs.unlinkSync(target); purgedReports++;
        }
      } catch {}
    }
  } catch {}
  try {
    const retained = new Set<string>();
    for (const session of keptSessions) for (const name of session.outputFiles) retained.add(path.basename(name));
    for (const name of fs.readdirSync(storage.reports).filter(x => x.endsWith('.json'))) {
      try { const report = JSON.parse(fs.readFileSync(path.join(storage.reports, name), 'utf-8')); if (report.output_filename) retained.add(path.basename(report.output_filename)); } catch {}
    }
    for (const name of fs.readdirSync(storage.downloads)) {
      if (!name.startsWith('.') && !retained.has(name)) { try { fs.unlinkSync(path.join(storage.downloads, name)); purgedFiles++; } catch {} }
    }
  } catch {}
  sessions.splice(0, sessions.length - 2);
  addLog('info', `[Storage Optimization Complete] Purged ${purgedFiles} video files, ${purgedReports} reports, and ${purgedJobs} job logs from this workspace. Only its last 2 parsed links are retained.`);
}

// Active child processes registry for instant termination
interface ActiveProcessEntry {
  id: string;
  proc: any;
  action: string;
  jobId?: string;
  workspaceId: string;
}
const activeProcesses = new Map<string, ActiveProcessEntry>();

// Helper to kill a process tree
function terminateProcessEntry(entry: ActiveProcessEntry) {
  try {
    if (entry.proc && entry.proc.pid) {
      try {
        process.kill(entry.proc.pid, 'SIGKILL');
      } catch {
        // ignore if already exited
      }
      try {
        entry.proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

// Helper to execute Python runner
function runPythonRunner(action: string, payload: any, timeoutMs = 0): Promise<any> {
  return new Promise((resolve, reject) => {
    if (isShuttingDown) {
      return reject(new Error('Server is shutting down; no new engine jobs will be started.'));
    }
    addLog('info', `Executing runner [${action}]`);
    const storage = workspaceStoragePaths(getWorkspaceId());
    const proc = spawn('python3', ['-m', 'engine.runner', action], {
      cwd: ROOT_DIR, stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SCRAPLING_DOWNLOADS_DIR: storage.downloads,
        SCRAPLING_REPORTS_DIR: storage.reports,
        SCRAPLING_LOGS_DIR: storage.logs,
        SCRAPLING_SETTINGS_FILE: workspaceSettingsFile(getWorkspaceId()),
        TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', TELEGRAM_API_ID: '',
        TELEGRAM_API_HASH: '', TELEGRAM_THREAD_ID: '', AUTO_UPLOAD_TELEGRAM: 'false',
      },
    });

    const runId = `${action}_${Date.now()}_${Math.random()}`;
    const entry: ActiveProcessEntry = {
      id: runId,
      proc,
      action,
      jobId: payload?.job_id,
      workspaceId: getWorkspaceId(),
    };
    activeProcesses.set(runId, entry);

    let stdoutData = '';
    let stderrData = '';
    let isTerminated = false;
    let timedOut = false;
    const timeoutHandle = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          addLog('error', 'Runner [' + action + '] exceeded its ' + Math.round(timeoutMs / 1000) + ' second time limit; stopping it.');
          try { proc.kill('SIGKILL'); } catch { /* already exited */ }
        }, timeoutMs)
      : undefined;

    proc.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrData += text;
      text.split('\n').forEach((line: string) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('Deprecated Feature')) {
          addLog('info', `[PyEngine] ${trimmed}`);
        }
      });
    });

    proc.on('close', (code, signal) => {
      activeProcesses.delete(runId);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (timedOut) {
        return reject(new Error('Test operation timed out after ' + Math.round(timeoutMs / 1000) + ' seconds. Check the engine logs and try again.'));
      }

      if (signal === 'SIGKILL' || signal === 'SIGTERM' || isTerminated) {
        addLog('warn', `Runner [${action}] terminated by user request`);
        return reject(new Error('Process terminated by user request'));
      }

      if (code !== 0 && !stdoutData.trim()) {
        addLog('error', `Runner [${action}] failed with code ${code}: ${stderrData}`);
        return reject(new Error(stderrData || `Runner exited with code ${code}`));
      }

      // Find JSON line from stdout
      try {
        const lines = stdoutData.trim().split('\n');
        let parsed: any = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i].trim();
          if (l.startsWith('{') && l.endsWith('}')) {
            try {
              parsed = JSON.parse(l);
              break;
            } catch {
              // continue
            }
          }
        }

        if (parsed !== null) {
          resolve(parsed);
        } else {
          resolve(JSON.parse(stdoutData.trim()));
        }
      } catch (err: any) {
        addLog('error', `Failed to parse Python JSON output: ${err.message}. Raw: ${stdoutData}`);
        reject(new Error(`Failed to parse engine output: ${stdoutData.slice(0, 200)}`));
      }
    });

    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

// Nonstop Auto-pilot Download Queue — isolated per anonymous browser workspace.
interface QueueItem {
  media_url: string;
  title: string;
  format_id?: string;
}

interface NonstopQueueState {
  is_running: boolean;
  total_items: number;
  current_index: number;
  current_title: string;
  completed_count: number;
  failed_count: number;
  pending_items: QueueItem[];
}

type QueueRestoreStatus = 'idle' | 'restoring' | 'success' | 'cancelled' | 'error';
interface QueueRuntime {
  state: NonstopQueueState;
  currentItem: QueueItem | null;
  saveChain: Promise<void>;
  restoreStatus: QueueRestoreStatus;
  restoreMessage: string;
  restoreController: AbortController | null;
  restoreNoticeUntil: number;
  restoreCompleted: boolean;
  workerActive: boolean;
  restorePromise: Promise<void> | null;
}
const queueRuntimes = new Map<string, QueueRuntime>();
let queueStorageWarningShown = false;

function createQueueRuntime(): QueueRuntime {
  return {
    state: { is_running: false, total_items: 0, current_index: 0, current_title: '', completed_count: 0, failed_count: 0, pending_items: [] },
    currentItem: null,
    saveChain: Promise.resolve(),
    restoreStatus: 'idle',
    restoreMessage: '',
    restoreController: null,
    restoreNoticeUntil: 0,
    restoreCompleted: false,
    workerActive: false,
    restorePromise: null,
  };
}
function getQueueRuntime(workspaceId = getWorkspaceId()): QueueRuntime {
  let runtime = queueRuntimes.get(workspaceId);
  if (!runtime) {
    runtime = createQueueRuntime();
    queueRuntimes.set(workspaceId, runtime);
  }
  return runtime;
}
function queueWorkspaceRowId(workspaceId: string): string {
  return `ws_${workspaceId}`;
}
function queueCheckpointPath(workspaceId: string): string {
  return path.join(LOGS_DIR, `nonstop-queue-${workspaceId}.json`);
}

function getSupabaseQueueConfig() {
  const rawValue = (process.env.SUPABASE_URL || '').trim();
  const rawUrl = rawValue.replace(/^["']|["']$/g, '').trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!rawUrl || !key) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') throw new Error('SUPABASE_URL must use https://.');
    const dashboardProject = parsed.pathname.match(/^\/dashboard\/project\/([a-z0-9]+)(?:\/|$)/i);
    if ((parsed.hostname === 'supabase.com' || parsed.hostname === 'www.supabase.com') && dashboardProject) {
      parsed.hostname = `${dashboardProject[1]}.supabase.co`;
      parsed.pathname = '';
    } else {
      const isProjectHost = /^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname);
      const normalizedPath = parsed.pathname.replace(/\/+$/, '').replace(/(?:\/rest\/v1)+$/i, '');
      if (!isProjectHost || normalizedPath) {
        throw new Error('Use the Supabase Project URL, e.g. https://<project-ref>.supabase.co. A trailing slash or /rest/v1 is also accepted.');
      }
      parsed.pathname = '';
    }
    parsed.search = '';
    parsed.hash = '';
    return { url: parsed.origin, key };
  } catch (err: any) {
    if (!queueStorageWarningShown) { queueStorageWarningShown = true; addLog('error', `Invalid Supabase URL: ${err.message}`); }
    return null;
  }
}

function persistNonstopQueueState(workspaceId = getWorkspaceId(), forceResume = false): Promise<void> {
  const runtime = getQueueRuntime(workspaceId);
  const queue = runtime.state;
  const state = {
    is_running: forceResume ? (queue.pending_items.length > 0 || Boolean(runtime.currentItem)) : queue.is_running,
    total_items: queue.total_items,
    current_index: queue.current_index,
    completed_count: queue.completed_count,
    failed_count: queue.failed_count,
    pending_items: [...queue.pending_items],
    current_item: runtime.currentItem,
    saved_at: Date.now(),
  };
  runtime.saveChain = runtime.saveChain.then(async () => {
    const checkpoint = queueCheckpointPath(workspaceId);
    const tempFile = `${checkpoint}.tmp`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify(state), 'utf-8');
      fs.renameSync(tempFile, checkpoint);
    } catch (err: any) {
      addLog('error', `Could not persist local nonstop queue checkpoint: ${err.message}`);
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
    }

    const config = getSupabaseQueueConfig();
    if (!config) {
      if (!queueStorageWarningShown) {
        queueStorageWarningShown = true;
        addLog('warn', 'Supabase queue backup is not configured. Workspace queues are only saved on the instance filesystem and may be lost when Koyeb replaces the instance.');
      }
      return;
    }
    try {
      const rowId = queueWorkspaceRowId(workspaceId);
      const response = await fetch(`${config.url}/rest/v1/vortex_queue_state?id=eq.${encodeURIComponent(rowId)}`, {
        method: 'POST',
        headers: {
          apikey: config.key,
          Authorization: `Bearer ${config.key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ id: rowId, state, updated_at: new Date().toISOString() }),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Supabase returned HTTP ${response.status}: ${detail.slice(0, 300)}`);
      }
    } catch (err: any) {
      addLog('error', `Supabase queue backup failed; local workspace checkpoint was retained: ${err.message}`);
    }
  });
  return runtime.saveChain;
}

async function restoreNonstopQueueState(workspaceId: string): Promise<void> {
  const runtime = getQueueRuntime(workspaceId);
  if (runtime.restoreStatus === 'success' || runtime.restoreStatus === 'error' || runtime.restoreStatus === 'cancelled') return;
  if (runtime.restorePromise) return runtime.restorePromise;
  let restoreTimeout: ReturnType<typeof setTimeout> | undefined;
  runtime.restorePromise = (async () => {
    let saved: any = null;
    const config = getSupabaseQueueConfig();
    runtime.restoreController = new AbortController();
    runtime.restoreStatus = 'restoring';
    runtime.restoreMessage = 'Restoring your private queue from the database, please wait…';
    restoreTimeout = setTimeout(() => {
      if (runtime.restoreStatus === 'restoring') runtime.restoreController?.abort();
    }, 12_000);

    if (config) {
      try {
        const rowId = queueWorkspaceRowId(workspaceId);
        const response = await fetch(`${config.url}/rest/v1/vortex_queue_state?id=eq.${encodeURIComponent(rowId)}&select=state`, {
          headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
          signal: runtime.restoreController.signal,
        });
        if (!response.ok) throw new Error(`Supabase returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
        const rows = await response.json() as Array<{ state?: any }>;
        if (Array.isArray(rows) && rows[0]?.state) {
          saved = rows[0].state;
          addLog('info', 'Loaded this browser workspace queue checkpoint from Supabase.');
        }
      } catch (err: any) {
        if (runtime.restoreStatus === 'cancelled') return;
        runtime.restoreStatus = 'error';
        runtime.restoreMessage = err?.name === 'AbortError'
          ? 'Could not restore your queue: database request timed out after 12 seconds.'
          : `Could not restore your queue from database: ${err.message}`;
        addLog('error', runtime.restoreMessage);
      }
    } else {
      runtime.restoreStatus = 'error';
      runtime.restoreMessage = 'Supabase is not configured. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.';
    }
    clearTimeout(restoreTimeout);

    if (!saved && runtime.restoreStatus !== 'cancelled') {
      try {
        const checkpoint = queueCheckpointPath(workspaceId);
        if (fs.existsSync(checkpoint)) {
          saved = JSON.parse(fs.readFileSync(checkpoint, 'utf-8'));
          addLog('warn', 'Restored this browser workspace queue from its local checkpoint; this fallback does not survive instance replacement.');
        }
      } catch (err: any) {
        addLog('error', `Could not restore local workspace queue checkpoint: ${err.message}`);
      }
    }
    if (runtime.restoreStatus === 'cancelled') return;
    if (saved) {
      const pending = Array.isArray(saved.pending_items) ? saved.pending_items : [];
      const interrupted = saved.current_item && typeof saved.current_item.media_url === 'string' ? [saved.current_item] : [];
      runtime.state.pending_items = [...interrupted, ...pending].filter((item: any) => item && typeof item.media_url === 'string' && item.media_url.trim());
      runtime.state.total_items = Number(saved.total_items) || runtime.state.pending_items.length;
      runtime.state.current_index = Number(saved.current_index) || 0;
      runtime.state.completed_count = Number(saved.completed_count) || 0;
      runtime.state.failed_count = Number(saved.failed_count) || 0;
      runtime.state.current_title = '';
      runtime.currentItem = null;
      runtime.state.is_running = runtime.state.pending_items.length > 0;
      if (runtime.state.pending_items.length) addLog('warn', `Recovered ${runtime.state.pending_items.length} unfinished download(s) for this browser workspace; automatic resume is enabled.`);
      // A local checkpoint is still a valid recovery source when Supabase is
      // temporarily unavailable or not configured.
      runtime.restoreStatus = 'success';
    }
    if (runtime.restoreStatus !== 'error') {
      runtime.restoreStatus = 'success';
      runtime.restoreMessage = saved
        ? `Your queue was restored. ${runtime.state.pending_items.length} unfinished download(s) recovered.`
        : 'Your private queue was checked. No saved downloads were found.';
      runtime.restoreNoticeUntil = Date.now() + 45_000;
    }
    runtime.restoreCompleted = true;
  })().finally(() => {
    if (runtime.restoreStatus === 'cancelled') runtime.restoreCompleted = true;
    if (restoreTimeout) clearTimeout(restoreTimeout);
    runtime.restoreController = null;
    runtime.restorePromise = null;
  });
  return runtime.restorePromise;
}

async function ensureQueueRestored(workspaceId = getWorkspaceId()): Promise<void> {
  const runtime = getQueueRuntime(workspaceId);
  if (!runtime.restoreCompleted) {
    await restoreNonstopQueueState(workspaceId);
  }
  if (runtime.restoreStatus === 'success' && runtime.state.pending_items.length > 0 && !runtime.state.is_running && !isShuttingDown) {
    runtime.state.is_running = true;
    await persistNonstopQueueState(workspaceId);
    void processNextNonstopItem(workspaceId);
  }
}

async function processNextNonstopItem(workspaceId: string): Promise<void> {
  const runtime = getQueueRuntime(workspaceId);
  if (runtime.workerActive) return;
  runtime.workerActive = true;

  return workspaceContext.run(workspaceId, async () => {
    try {
      const queue = runtime.state;
      if (!queue.is_running || queue.pending_items.length === 0) {
        queue.is_running = false;
        queue.current_title = '';
        await persistNonstopQueueState(workspaceId);
        addLog('info', `Nonstop queue finished: ${queue.completed_count} completed, ${queue.failed_count} failed.`);
        return;
      }

      const item = queue.pending_items.shift()!;
      runtime.currentItem = item;
      queue.current_index++;
      queue.current_title = item.title;
      void persistNonstopQueueState(workspaceId);

      const job_id = `dl_${randomUUID()}`;
      const cleanTitle = item.title || 'video';
      const job: JobStatus = {
        job_id, title: cleanTitle, media_url: item.media_url, format_id: item.format_id,
        status: 'queued', progress_percent: 0, speed_mbps: 0, eta_seconds: 0,
        total_bytes: 0, started_at: Date.now(),
      };
      getWorkspaceJobs().set(job_id, job);
      addLog('info', `[Nonstop Queue ${queue.current_index}/${queue.total_items}] Downloading: ${cleanTitle}`);

      try {
        job.status = 'downloading';
        const result = await runPythonRunner('download-job', {
          job_id, media_url: item.media_url, title: cleanTitle, format_id: item.format_id,
        });
        if (!queue.is_running) return;
        if (result.status === 'completed') {
          job.status = 'completed';
          job.progress_percent = 100;
          job.output_filename = result.output_filename;
          job.output_path = result.output_file;
          job.total_bytes = result.file_size_bytes || 0;
          job.finished_at = Date.now();
          queue.completed_count++;
          addLog('info', `[Nonstop Queue] Finished MP4: ${result.output_filename}`);
          const currentSession = getParsedLinkSessions()[getParsedLinkSessions().length - 1];
          if (currentSession && result.output_filename) {
            currentSession.outputFiles.add(result.output_filename);
            currentSession.jobIds.add(job_id);
            currentSession.reportFiles.add(`${job_id}.json`);
          }
          if (result.telegram_uploaded) addLog('info', `[Nonstop Queue] Telegram upload completed for: ${cleanTitle}`);
          else if (result.telegram_result?.error) addLog('warn', `[Nonstop Queue] Telegram upload warning: ${result.telegram_result.error}`);
        } else {
          job.status = 'failed';
          job.error = result.error || 'Download failed in Python engine';
          job.finished_at = Date.now();
          queue.failed_count++;
          addLog('error', `[Nonstop Queue] Item failed: ${job.error}`);
        }
      } catch (err: any) {
        if (!queue.is_running) {
          job.status = 'failed';
          job.error = 'Halted by user';
          job.finished_at = Date.now();
          return;
        }
        job.status = 'failed';
        job.error = err.message;
        job.finished_at = Date.now();
        queue.failed_count++;
        addLog('error', `[Nonstop Queue] Item error: ${err.message}`);
      }

      runtime.currentItem = null;
      await persistNonstopQueueState(workspaceId);
    } finally {
      runtime.workerActive = false;
      if (runtime.state.is_running && runtime.state.pending_items.length > 0 && !isShuttingDown) {
        setTimeout(() => { void processNextNonstopItem(workspaceId); }, 500);
      }
    }
  });
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// 1. Settings
app.get('/api/settings', (req, res) => {
  try {
    let settings = {
      telegram_bot_token: '',
      telegram_chat_id: '',
      telegram_api_id: '',
      telegram_api_hash: '',
      telegram_thread_id: '',
      auto_upload_telegram: false,
      max_concurrent_downloads: 3,
      max_crawl_videos: 40,
      default_resolution: 'best',
    };

    const settingsFile = workspaceSettingsFile();
    if (fs.existsSync(settingsFile)) {
      const fileData = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      settings = { ...settings, ...fileData };
    }
    const safeSettings = {
  ...settings,
  telegram_bot_token: '',
  telegram_api_hash: '',
  telegram_credentials_configured: Boolean(
    settings.telegram_bot_token && settings.telegram_chat_id
  )
};

res.json({ success: true, settings: safeSettings });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const newSettings = { ...(req.body || {}) };

    let current: any = {};
    const settingsFile = workspaceSettingsFile();
    if (fs.existsSync(settingsFile)) {
      current = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    }
    const merged = { ...current, ...newSettings };
    // Secret values are intentionally omitted from GET responses. Preserve the
    // stored credential when the UI submits an unchanged blank secret field.
    for (const secretKey of ['telegram_bot_token', 'telegram_api_hash'] as const) {
      if (typeof newSettings[secretKey] !== 'string' || newSettings[secretKey].length === 0) {
        if (current[secretKey]) merged[secretKey] = current[secretKey];
      }
    }
    fs.writeFileSync(settingsFile, JSON.stringify(merged, null, 2));
    addLog('info', 'Updated configuration settings');
   const safeSettings = {
  ...merged,
  telegram_bot_token: '',
  telegram_api_hash: '',
  telegram_credentials_configured: Boolean(
    merged.telegram_bot_token && merged.telegram_chat_id
  )
};

res.json({ success: true, settings: safeSettings });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Dedicated "Test Website"
app.post('/api/test-website', async (req, res) => {
  const { url, telegram_bot_token, telegram_chat_id, max_subpages, subpage_offset } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'Target URL is required' });
  }

  // Register link session and auto-purge older remaining data if > 2 separate links
  registerParsedLink(url.trim());

  addLog('info', `Testing website deep inspection on: ${url}`);
  try {
    const result = await runPythonRunner('test-website', {
      url: url.trim(),
      telegram_bot_token,
      telegram_chat_id,
      max_subpages: max_subpages !== undefined ? max_subpages : 20,
      subpage_offset: subpage_offset || 0,
    }, 180000);
    res.json(result);
  } catch (err: any) {
    addLog('error', `Test website failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Batch Scrape & Deep Website Crawl
// Background execution prevents Koyeb/reverse-proxy request timeouts on long crawls.
app.post('/api/scrape', (req, res) => {
  const { urls, deep_crawl, max_subpages, subpage_offset } = req.body;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ success: false, error: 'A list of URLs is required' });
  }
  const workspaceId = getWorkspaceId();
  const crawlTasks = getWorkspaceCrawlTasks(workspaceId);
  const activeCrawlTaskId = activeCrawlTaskIds.get(workspaceId);
  if (activeCrawlTaskId) {
    const active = crawlTasks.get(activeCrawlTaskId);
    if (active?.status === 'running') {
      return res.status(409).json({ success: false, error: 'A crawl is already running in this browser workspace. Wait for it to finish before starting another URL.' });
    }
    activeCrawlTaskIds.delete(workspaceId);
  }
  const cleanUrls = urls.filter((u: any) => typeof u === 'string' && u.trim()).map((u: string) => u.trim());
  if (!cleanUrls.length) return res.status(400).json({ success: false, error: 'A valid URL is required' });

  for (const u of cleanUrls) registerParsedLink(u);
  const taskId = `crawl_${randomUUID()}`;
  const task: CrawlTask = { task_id: taskId, status: 'running', started_at: Date.now() };
  crawlTasks.set(taskId, task);
  activeCrawlTaskIds.set(workspaceId, taskId);
  persistWorkspaceCrawlTasks(workspaceId);
  addLog('info', `Queued background crawl [${taskId}] for ${cleanUrls.length} URL(s)`);
  res.status(202).json({ success: true, task_id: taskId, status: 'running' });

  void (async () => {
    try {
      addLog('info', `Starting deep inspection of ${cleanUrls.length} URL(s) (Offset: ${subpage_offset || 0}, Max Subpages: ${max_subpages ?? 100}, Deep Crawl: ${deep_crawl ?? true})`);
      task.result = await runPythonRunner('scrape-batch', {
        urls: cleanUrls,
        deep_crawl: deep_crawl !== false,
        max_subpages: max_subpages !== undefined ? max_subpages : 100,
        subpage_offset: subpage_offset || 0,
      });
      task.status = 'completed';
      task.finished_at = Date.now();
      persistWorkspaceCrawlTasks(workspaceId);
      addLog('info', `Background crawl [${taskId}] completed: ${task.result?.total_videos_detected ?? 0} video(s) detected`);
    } catch (err: any) {
      task.status = 'failed';
      task.error = err?.message || 'Unknown crawler error';
      task.finished_at = Date.now();
      persistWorkspaceCrawlTasks(workspaceId);
      addLog('error', `Background crawl [${taskId}] failed: ${task.error}`);
    } finally {
      if (activeCrawlTaskIds.get(workspaceId) === taskId) activeCrawlTaskIds.delete(workspaceId);
      const expiry = Date.now() - 30 * 60 * 1000;
      for (const [id, oldTask] of crawlTasks.entries()) {
        if (oldTask.finished_at && oldTask.finished_at < expiry) crawlTasks.delete(id);
      }
      persistWorkspaceCrawlTasks(workspaceId);
    }
  })();
});

app.get('/api/scrape/status/:id', (req, res) => {
  const task = getWorkspaceCrawlTasks().get(req.params.id);
  if (!task) return res.status(404).json({ success: false, error: 'Crawl task not found or server restarted.' });
  res.json({ success: true, task_id: task.task_id, status: task.status,
    result: task.status === 'completed' ? task.result : undefined,
    error: task.error, started_at: task.started_at, finished_at: task.finished_at });
});

// 4. Download Single Video
app.post('/api/download', async (req, res) => {
  const { media_url, title, format_id } = req.body;
  if (!media_url) {
    return res.status(400).json({ success: false, error: 'Media URL is required' });
  }

  const job_id = `dl_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const cleanTitle = title || 'video';

  const job: JobStatus = {
    job_id,
    title: cleanTitle,
    media_url,
    format_id,
    status: 'queued',
    progress_percent: 0,
    speed_mbps: 0,
    eta_seconds: 0,
    total_bytes: 0,
    started_at: Date.now(),
  };

  getWorkspaceJobs().set(job_id, job);
  addLog('info', `Enqueued single download [${job_id}] for: ${cleanTitle}`);

  (async () => {
    try {
      job.status = 'downloading';
      const result = await runPythonRunner('download-job', {
        job_id,
        media_url,
        title: cleanTitle,
        format_id,
      });

      if (result.status === 'completed') {
        job.status = 'completed';
        job.progress_percent = 100;
        job.output_filename = result.output_filename;
        job.output_path = result.output_file;
        job.total_bytes = result.file_size_bytes || 0;
        job.finished_at = Date.now();
        addLog('info', `Job [${job_id}] completed: ${result.output_filename}`);

        // Associate with current link session for 2-link storage management
        const currentSession = getParsedLinkSessions()[getParsedLinkSessions().length - 1];
        if (currentSession && result.output_filename) {
          currentSession.outputFiles.add(result.output_filename);
          currentSession.jobIds.add(job_id);
          currentSession.reportFiles.add(`${job_id}.json`);
        }
      } else {
        job.status = 'failed';
        job.error = result.error || 'Download failed in Python engine';
        job.finished_at = Date.now();
        addLog('error', `Job [${job_id}] failed: ${job.error}`);
      }
    } catch (err: any) {
      job.status = 'failed';
      job.error = err.message;
      job.finished_at = Date.now();
      addLog('error', `Job [${job_id}] unexpected error: ${err.message}`);
    }
  })();

  res.json({ success: true, job_id, job });
});

// Queue restore controls are scoped to the signed browser workspace.
app.get('/api/nonstop-queue/restore-status', async (_req, res) => {
  const workspaceId = getWorkspaceId();
  await ensureQueueRestored(workspaceId);
  const runtime = getQueueRuntime(workspaceId);
  if (runtime.restoreNoticeUntil && Date.now() > runtime.restoreNoticeUntil) {
    runtime.restoreStatus = 'idle';
    runtime.restoreMessage = '';
    runtime.restoreNoticeUntil = 0;
  }
  res.json({ success: true, restore: { status: runtime.restoreStatus, message: runtime.restoreMessage } });
});

app.post('/api/nonstop-queue/restore-cancel', (_req, res) => {
  const runtime = getQueueRuntime();
  if (runtime.restoreStatus !== 'restoring') {
    return res.json({ success: false, restore: { status: runtime.restoreStatus, message: runtime.restoreMessage } });
  }
  runtime.restoreStatus = 'cancelled';
  runtime.restoreMessage = 'Queue restoration cancelled.';
  runtime.restoreController?.abort();
  runtime.restoreNoticeUntil = Date.now() + 45_000;
  addLog('warn', runtime.restoreMessage);
  res.json({ success: true, restore: { status: runtime.restoreStatus, message: runtime.restoreMessage } });
});

// 4b. Download All Nonstop Queue
app.post('/api/download-all-nonstop', async (req, res) => {
  const { videos } = req.body;
  if (!Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({ success: false, error: 'Videos array is required' });
  }
  const workspaceId = getWorkspaceId();
  await ensureQueueRestored(workspaceId);
  const runtime = getQueueRuntime(workspaceId);
  const queue = runtime.state;
  const newItems: QueueItem[] = videos.map((v: any) => ({
    media_url: v.media_url,
    title: v.title,
    format_id: v.selected_format_id || v.format_id || 'best',
  })).filter((item: QueueItem) => typeof item.media_url === 'string' && item.media_url.trim());
  if (!newItems.length) return res.status(400).json({ success: false, error: 'No valid video URLs were supplied' });

  queue.pending_items.push(...newItems);
  queue.total_items += newItems.length;
  queue.is_running = true;
  await persistNonstopQueueState(workspaceId);
  addLog('info', `Enqueued ${newItems.length} videos into this browser's private queue (Total items: ${queue.total_items})`);
  if (!runtime.currentItem) void processNextNonstopItem(workspaceId);

  res.json({
    success: true,
    message: `Started downloading ${newItems.length} video(s) in your private queue`,
    queue: { total: queue.total_items, current: queue.current_index, pending: queue.pending_items.length, is_running: queue.is_running },
  });
});

app.get('/api/nonstop-queue/status', async (_req, res) => {
  const workspaceId = getWorkspaceId();
  await ensureQueueRestored(workspaceId);
  const queue = getQueueRuntime(workspaceId).state;
  res.json({
    success: true,
    queue: {
      is_running: queue.is_running,
      total_items: queue.total_items,
      current_index: queue.current_index,
      current_title: queue.current_title,
      completed_count: queue.completed_count,
      failed_count: queue.failed_count,
      pending_count: queue.pending_items.length,
    },
  });
});

app.post('/api/nonstop-queue/stop', async (_req, res) => {
  const workspaceId = getWorkspaceId();
  const runtime = getQueueRuntime(workspaceId);
  const queue = runtime.state;
  queue.is_running = false;
  queue.pending_items = [];
  runtime.currentItem = null;
  queue.current_title = '';
  await persistNonstopQueueState(workspaceId);

  addLog('warn', 'Halt request received for this browser workspace; terminating its active download processes.');
  for (const [runId, entry] of activeProcesses.entries()) {
    if (entry.workspaceId !== workspaceId) continue;
    addLog('warn', `Forcefully killing this workspace's active process [${entry.action}] (PID: ${entry.proc?.pid})`);
    terminateProcessEntry(entry);
    activeProcesses.delete(runId);
  }

  for (const job of getWorkspaceJobs().values()) {
    if (job.status === 'downloading' || job.status === 'processing_ffmpeg' || job.status === 'queued' || job.status === 'starting') {
      job.status = 'failed';
      job.error = 'Operation halted and terminated by user';
      job.finished_at = Date.now();
    }
  }
  res.json({ success: true, message: 'Your private nonstop queue and its tracked processes were stopped.' });
});

// Cancel a specific job
app.post('/api/jobs/cancel/:id', (req, res) => {
  const jobId = req.params.id;
  const job = getWorkspaceJobs().get(jobId);

  for (const [runId, entry] of activeProcesses.entries()) {
    if (entry.jobId === jobId && entry.workspaceId === getWorkspaceId()) {
      terminateProcessEntry(entry);
      activeProcesses.delete(runId);
    }
  }

  if (job) {
    job.status = 'failed';
    job.error = 'Canceled by user';
    job.finished_at = Date.now();
    addLog('warn', `Job [${jobId}] canceled by user`);
    return res.json({ success: true, message: `Job ${jobId} canceled` });
  }

  res.status(404).json({ success: false, error: 'Job not found' });
});

// Delete a single job from the queue tracker
app.delete('/api/jobs/:id', (req, res) => {
  const jobId = req.params.id;
  if (getWorkspaceJobs().has(jobId)) {
    getWorkspaceJobs().delete(jobId);
    // Also remove from disk log if present
    const jobFile = path.join(workspaceStoragePaths().logs, 'jobs', `${jobId}.json`);
    if (fs.existsSync(jobFile)) {
      try {
        fs.unlinkSync(jobFile);
      } catch {}
    }
    return res.json({ success: true, message: `Job ${jobId} deleted from queue` });
  }
  res.status(404).json({ success: false, error: 'Job not found' });
});

// Clear all finished/failed jobs
app.delete('/api/jobs', (req, res) => {
  let cleared = 0;
  for (const [id, job] of getWorkspaceJobs().entries()) {
    if (job.status === 'completed' || job.status === 'failed') {
      getWorkspaceJobs().delete(id);
      cleared++;
      const jobFile = path.join(workspaceStoragePaths().logs, 'jobs', `${id}.json`);
      if (fs.existsSync(jobFile)) {
        try {
          fs.unlinkSync(jobFile);
        } catch {}
      }
    }
  }
  addLog('info', `Cleared ${cleared} finished/failed jobs from queue`);
  res.json({ success: true, cleared });
});

// 5. Jobs Status
app.get('/api/jobs', (req, res) => {
  // Sync state from logs/jobs if available
  const jobsDir = path.join(workspaceStoragePaths().logs, 'jobs');
  if (fs.existsSync(jobsDir)) {
    const files = fs.readdirSync(jobsDir).filter((f) => f.endsWith('.json'));
    files.forEach((f) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(jobsDir, f), 'utf-8'));
        if (data.job_id && getWorkspaceJobs().has(data.job_id)) {
          const current = getWorkspaceJobs().get(data.job_id)!;
          if (current.status !== 'completed' && current.status !== 'failed') {
            Object.assign(current, data);
          }
        }
      } catch {
        // ignore parse errors
      }
    });
  }

  const jobsList = Array.from(getWorkspaceJobs().values()).sort((a, b) => b.started_at - a.started_at);
  res.json({ success: true, jobs: jobsList });
});

// 6. Downloaded Files List & Stream
app.get('/api/downloads', (req, res) => {
  try {
    const files = fs.readdirSync(workspaceStoragePaths().downloads);
    const videoFiles = files
      .filter((f) => f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm'))
      .map((fileName) => {
        const fullPath = path.join(workspaceStoragePaths().downloads, fileName);
        const stats = fs.statSync(fullPath);
        return {
          filename: fileName,
          size_bytes: stats.size,
          size_mb: (stats.size / (1024 * 1024)).toFixed(2),
          created_at: stats.birthtime,
          modified_at: stats.mtime,
        };
      })
      .sort((a, b) => b.modified_at.getTime() - a.modified_at.getTime());

    res.json({ success: true, files: videoFiles });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stream MP4 video with HTTP 206 Partial Content support for in-browser playback
app.get('/api/downloads/stream/:filename', (req, res) => {
  const fileName = path.basename(req.params.filename);
  const filePath = path.join(workspaceStoragePaths().downloads, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\\d*)-(\\d*)$/.exec(range.trim());
    if (!match || (!match[1] && !match[2])) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    let start: number;
    let end: number;
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
        return;
      }
      start = Math.max(0, fileSize - suffixLength);
      end = fileSize - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : fileSize - 1;
    }

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= fileSize || end < start) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }
    end = Math.min(end, fileSize - 1);
    const chunksize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// Direct file download attachment
app.get('/api/downloads/file/:filename', (req, res) => {
  const fileName = path.basename(req.params.filename);
  const filePath = path.join(workspaceStoragePaths().downloads, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath, fileName);
});

// Delete downloaded file and its report
app.delete('/api/downloads/:filename', (req, res) => {
  try {
    const rawParam = req.params.filename;
    const fileName = path.basename(decodeURIComponent(rawParam));
    const filePath = path.join(workspaceStoragePaths().downloads, fileName);

    let deletedFile = false;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      deletedFile = true;
      addLog('info', `Deleted downloaded video file: ${fileName}`);
    }

    // Also remove associated report in reports/
    try {
      const reports = fs.readdirSync(workspaceStoragePaths().reports);
      for (const rep of reports) {
        if (!rep.endsWith('.json')) continue;
        const repPath = path.join(workspaceStoragePaths().reports, rep);
        try {
          const content = JSON.parse(fs.readFileSync(repPath, 'utf-8'));
          if (content.output_filename === fileName || content.output_file?.includes(fileName)) {
            fs.unlinkSync(repPath);
            addLog('info', `Removed matching JSON report: ${rep}`);
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    if (deletedFile) {
      res.json({ success: true, message: `File ${fileName} removed` });
    } else {
      res.status(404).json({ success: false, error: 'File not found on disk' });
    }
  } catch (err: any) {
    addLog('error', `Failed to delete file: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6b. Storage Management & 2-Link Retention Status
app.get('/api/storage/status', (req, res) => {
  try {
    const retainedSessions = getParsedLinkSessions().slice(-2);
    const files = fs.readdirSync(workspaceStoragePaths().downloads).filter((f) => !f.startsWith('.'));
    const reports = fs.readdirSync(workspaceStoragePaths().reports).filter((f) => f.endsWith('.json'));
    
    let totalBytes = 0;
    for (const f of files) {
      try {
        totalBytes += fs.statSync(path.join(workspaceStoragePaths().downloads, f)).size;
      } catch {}
    }

    res.json({
      success: true,
      max_retained_links: 2,
      active_retained_sessions: retainedSessions.map((s) => ({
        url: s.url,
        domain: s.domain,
        parsed_at: s.parsedAt,
        files_count: s.outputFiles.size,
      })),
      total_files: files.length,
      total_reports: reports.length,
      total_size_mb: (totalBytes / (1024 * 1024)).toFixed(1),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/storage/purge', (req, res) => {
  try {
    purgeOlderSessionsData(getWorkspaceId());
    res.json({ success: true, message: 'Purged older remaining data outside the 2 most recent links.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. JSON Reports
app.get('/api/reports', (req, res) => {
  try {
    const files = fs.readdirSync(workspaceStoragePaths().reports).filter((f) => f.endsWith('.json'));
    const reports = files
      .map((f) => {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(workspaceStoragePaths().reports, f), 'utf-8'));
          return {
            report_id: f.replace('.json', ''),
            file_name: f,
            ...content,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a: any, b: any) => (b.start_time || 0) - (a.start_time || 0));

    res.json({ success: true, reports });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Telegram Bot API Integration
app.post('/api/telegram/test', async (req, res) => {
  const { telegram_bot_token, telegram_chat_id, telegram_api_id, telegram_api_hash } = req.body;
  try {
    const result = await runPythonRunner('telegram-test', {
      telegram_bot_token,
      telegram_chat_id,
      telegram_api_id,
      telegram_api_hash,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/telegram/upload', async (req, res) => {
  const { filename, title } = req.body;
  if (!filename) {
    return res.status(400).json({ success: false, error: 'Filename is required' });
  }
  const cleanName = path.basename(decodeURIComponent(filename));
  const filePath = path.join(workspaceStoragePaths().downloads, cleanName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: `File not found: ${cleanName}` });
  }

  const stat = fs.statSync(filePath);
  const sizeMb = (stat.size / 1024 / 1024).toFixed(1);

  // Load configured settings
  let settings: any = {};
  const settingsFile = workspaceSettingsFile();
  if (fs.existsSync(settingsFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    } catch {}
  }

  try {
    addLog('info', `Dispatching high-capacity video upload to Telegram: ${cleanName} (${sizeMb} MB)`);
    const result = await runPythonRunner('telegram-upload', {
      title: title || cleanName,
      file_path: filePath,
      file_size_bytes: stat.size,
      telegram_bot_token: req.body.telegram_bot_token || settings.telegram_bot_token,
      telegram_chat_id: req.body.telegram_chat_id || settings.telegram_chat_id,
      telegram_api_id: req.body.telegram_api_id || settings.telegram_api_id,
      telegram_api_hash: req.body.telegram_api_hash || settings.telegram_api_hash,
    });
    res.json(result);
  } catch (err: any) {
    addLog('error', `Telegram upload failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Logs
app.get('/api/logs', (req, res) => {
  const workspaceId = (req as any).workspaceId as string;
  res.json({ success: true, logs: workspaceLogs.get(workspaceId) || [] });
});

// -------------------------------------------------------------
// Vite Middleware / Static Serving
// -------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(ROOT_DIR, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(ROOT_DIR, 'dist', 'index.html'));
    });
  }

  httpServer = app.listen(PORT, '0.0.0.0', () => {
    addLog('info', `Vortex Video Scraper & Downloader online on http://0.0.0.0:${PORT}`);
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

async function shutdownGracefully(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  addLog('warn', `Received ${signal}; beginning graceful shutdown.`);

  // Stop dispatching new items for every workspace while allowing active runners
  // to drain during the platform's termination grace period.
  for (const runtime of queueRuntimes.values()) runtime.state.is_running = false;
  if (httpServer) {
    httpServer.close();
    try { httpServer.closeIdleConnections?.(); } catch {}
  }

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (activeProcesses.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Requeue every in-flight workspace item and persist each isolated snapshot.
  for (const [workspaceId, runtime] of queueRuntimes.entries()) {
    if (runtime.currentItem) {
      runtime.state.pending_items.unshift(runtime.currentItem);
      runtime.currentItem = null;
    }
    await persistNonstopQueueState(workspaceId, true);
  }

  if (activeProcesses.size > 0) {
    for (const entry of activeProcesses.values()) {
      try { entry.proc?.kill('SIGTERM'); } catch {}
    }
    addLog('warn', `Grace period expired with ${activeProcesses.size} engine process(es) active; saved resumable queue state and sent SIGTERM.`);
  } else {
    addLog('info', 'Active engine processes drained; resumable nonstop queue checkpoint saved.');
  }

  setTimeout(() => process.exit(0), 1_000).unref();
}

process.on('SIGTERM', () => { void shutdownGracefully('SIGTERM'); });
process.on('SIGINT', () => { void shutdownGracefully('SIGINT'); });

async function bootstrapServer() {
  // Queues are restored lazily when their owning browser workspace connects.
  // This avoids loading a legacy/global queue into an arbitrary visitor's session.
  await startServer();
}

bootstrapServer().catch((err) => {
  console.error('Fatal server startup failure:', err);
  process.exit(1);
});
