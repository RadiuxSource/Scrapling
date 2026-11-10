import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = process.cwd();
const DOWNLOADS_DIR = path.join(ROOT_DIR, 'downloads');
const REPORTS_DIR = path.join(ROOT_DIR, 'reports');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const SETTINGS_FILE = path.join(ROOT_DIR, 'settings.json');

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

const activeJobs = new Map<string, JobStatus>();
const engineLogs: Array<{ timestamp: string; level: 'info' | 'warn' | 'error'; message: string }> = [];

interface CrawlTask {
  task_id: string;
  status: 'running' | 'completed' | 'failed';
  started_at: number;
  finished_at?: number;
  result?: any;
  error?: string;
}
const crawlTasks = new Map<string, CrawlTask>();
let activeCrawlTaskId: string | null = null;


function addLog(level: 'info' | 'warn' | 'error', message: string) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  engineLogs.push(entry);
  if (engineLogs.length > 300) {
    engineLogs.shift();
  }
}

// Parsed Link Session & Storage Retention Manager (Keeps at most 2 separate links' data)
interface ParsedLinkSession {
  url: string;
  domain: string;
  parsedAt: number;
  outputFiles: Set<string>;
  reportFiles: Set<string>;
  jobIds: Set<string>;
}

const parsedLinkSessions: ParsedLinkSession[] = [];

function registerParsedLink(rawUrl: string): ParsedLinkSession | undefined {
  const cleanUrl = (rawUrl || '').trim();
  if (!cleanUrl) return;

  let domain = cleanUrl;
  try {
    domain = new URL(cleanUrl).hostname;
  } catch {}

  // Check if identical to the current active session
  const lastSession = parsedLinkSessions[parsedLinkSessions.length - 1];
  if (lastSession && (lastSession.url === cleanUrl || lastSession.domain === domain)) {
    lastSession.parsedAt = Date.now();
    return lastSession;
  }

  // New separate link parsed
  const session: ParsedLinkSession = {
    url: cleanUrl,
    domain,
    parsedAt: Date.now(),
    outputFiles: new Set<string>(),
    reportFiles: new Set<string>(),
    jobIds: new Set<string>(),
  };

  parsedLinkSessions.push(session);
  addLog('info', `[Storage Manager] Registered parsed website (#${parsedLinkSessions.length}): ${cleanUrl}`);

  // Enforce retention policy: Keep data for at most the 2 most recent separate links!
  // After parsing 2 separate links, remove the older remaining data and downloaded videos completely!
  if (parsedLinkSessions.length > 2) {
    purgeOlderSessionsData();
  }

  return session;
}

function purgeOlderSessionsData() {
  if (parsedLinkSessions.length <= 2) return;

  const sessionsToPurge = parsedLinkSessions.slice(0, parsedLinkSessions.length - 2);
  const retainedSessions = parsedLinkSessions.slice(-2);
  const retainedUrls = new Set(retainedSessions.map((s) => s.url));
  const retainedDomains = new Set(retainedSessions.map((s) => s.domain));

  addLog('warn', `[Storage Manager] Enforcing 2-link retention. Purging older remaining data and downloaded videos outside the 2 recent links: ${Array.from(retainedUrls).join(', ')}`);

  let purgedFiles = 0;
  let purgedReports = 0;
  let purgedJobs = 0;

  // 1. Purge recorded output files and reports from older sessions
  for (const session of sessionsToPurge) {
    for (const filename of session.outputFiles) {
      const filePath = path.join(DOWNLOADS_DIR, filename);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          purgedFiles++;
        } catch {}
      }
    }

    for (const repFile of session.reportFiles) {
      const repPath = path.join(REPORTS_DIR, repFile);
      if (fs.existsSync(repPath)) {
        try {
          fs.unlinkSync(repPath);
        } catch {}
      }
    }

    for (const jid of session.jobIds) {
      activeJobs.delete(jid);
      purgedJobs++;
      const jobFile = path.join(LOGS_DIR, 'jobs', `${jid}.json`);
      if (fs.existsSync(jobFile)) {
        try {
          fs.unlinkSync(jobFile);
        } catch {}
      }
    }
  }

  // 2. Scan REPORTS_DIR to find reports and associated videos not belonging to the 2 retained links
  try {
    const reportFiles = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json'));
    for (const rf of reportFiles) {
      const rPath = path.join(REPORTS_DIR, rf);
      try {
        const content = JSON.parse(fs.readFileSync(rPath, 'utf-8'));
        const siteUrl = content.site_url || content.page_url || '';
        let isRetained = false;
        for (const rUrl of retainedUrls) {
          if (siteUrl.includes(rUrl) || rUrl.includes(siteUrl)) {
            isRetained = true;
            break;
          }
        }
        if (!isRetained && siteUrl) {
          try {
            const parsedHost = new URL(siteUrl).hostname;
            if (retainedDomains.has(parsedHost)) {
              isRetained = true;
            }
          } catch {}
        }

        // If not from one of the 2 retained links, delete the report and video file
        if (!isRetained) {
          if (content.output_filename) {
            const vPath = path.join(DOWNLOADS_DIR, content.output_filename);
            if (fs.existsSync(vPath)) {
              try {
                fs.unlinkSync(vPath);
                purgedFiles++;
              } catch {}
            }
          }
          if (content.output_file && fs.existsSync(content.output_file)) {
            try {
              fs.unlinkSync(content.output_file);
              purgedFiles++;
            } catch {}
          }
          fs.unlinkSync(rPath);
          purgedReports++;
        }
      } catch {}
    }
  } catch {}

  // 3. Scan DOWNLOADS_DIR directly to clean any orphan videos or buffers not in the 2 retained links
  try {
    const allDownloads = fs.readdirSync(DOWNLOADS_DIR);
    const retainedFileNames = new Set<string>();
    for (const s of retainedSessions) {
      for (const f of s.outputFiles) {
        retainedFileNames.add(f);
      }
    }
    const currentReports = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json'));
    for (const rf of currentReports) {
      try {
        const rep = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, rf), 'utf-8'));
        if (rep.output_filename) retainedFileNames.add(rep.output_filename);
      } catch {}
    }

    for (const df of allDownloads) {
      if (df.startsWith('.')) continue;
      if (!retainedFileNames.has(df)) {
        try {
          fs.unlinkSync(path.join(DOWNLOADS_DIR, df));
          purgedFiles++;
        } catch {}
      }
    }
  } catch {}

  // 4. Keep strictly the last 2 sessions in memory
  parsedLinkSessions.splice(0, parsedLinkSessions.length - 2);

  addLog('info', `[Storage Optimization Complete] Purged ${purgedFiles} video files, ${purgedReports} reports, and ${purgedJobs} job logs. Only last 2 parsed links retained.`);
}

// Active child processes registry for instant termination
interface ActiveProcessEntry {
  id: string;
  proc: any;
  action: string;
  jobId?: string;
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
    const proc = spawn('python3', ['-m', 'engine.runner', action], {
      cwd: ROOT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const runId = `${action}_${Date.now()}_${Math.random()}`;
    const entry: ActiveProcessEntry = {
      id: runId,
      proc,
      action,
      jobId: payload?.job_id,
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

// Nonstop Auto-pilot Download Queue
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

let nonstopQueue: NonstopQueueState = {
  is_running: false,
  total_items: 0,
  current_index: 0,
  current_title: '',
  completed_count: 0,
  failed_count: 0,
  pending_items: [],
};

const NONSTOP_QUEUE_FILE = path.join(LOGS_DIR, 'nonstop-queue.json');
let currentNonstopItem: QueueItem | null = null;

function persistNonstopQueueState() {
  const state = {
    total_items: nonstopQueue.total_items,
    current_index: nonstopQueue.current_index,
    completed_count: nonstopQueue.completed_count,
    failed_count: nonstopQueue.failed_count,
    pending_items: nonstopQueue.pending_items,
    current_item: currentNonstopItem,
    saved_at: Date.now(),
  };
  const tempFile = `${NONSTOP_QUEUE_FILE}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(state), 'utf-8');
    fs.renameSync(tempFile, NONSTOP_QUEUE_FILE);
  } catch (err: any) {
    addLog('error', `Could not persist nonstop queue state: ${err.message}`);
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
  }
}

function restoreNonstopQueueState() {
  try {
    if (!fs.existsSync(NONSTOP_QUEUE_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(NONSTOP_QUEUE_FILE, 'utf-8'));
    const pending = Array.isArray(saved.pending_items) ? saved.pending_items : [];
    const interrupted = saved.current_item && typeof saved.current_item.media_url === 'string'
      ? [saved.current_item]
      : [];
    nonstopQueue.pending_items = [...interrupted, ...pending].filter(
      (item: any) => item && typeof item.media_url === 'string' && item.media_url.trim()
    );
    nonstopQueue.total_items = Number(saved.total_items) || nonstopQueue.pending_items.length;
    nonstopQueue.current_index = Number(saved.current_index) || 0;
    nonstopQueue.completed_count = Number(saved.completed_count) || 0;
    nonstopQueue.failed_count = Number(saved.failed_count) || 0;
    currentNonstopItem = null;
    if (nonstopQueue.pending_items.length > 0) {
      addLog('warn', `Recovered ${nonstopQueue.pending_items.length} unfinished nonstop download(s) from the local queue checkpoint.`);
    }
  } catch (err: any) {
    addLog('error', `Could not restore nonstop queue checkpoint: ${err.message}`);
  }
}

async function processNextNonstopItem() {
  if (!nonstopQueue.is_running || nonstopQueue.pending_items.length === 0) {
    nonstopQueue.is_running = false;
    nonstopQueue.current_title = '';
    addLog('info', `Nonstop queue finished: ${nonstopQueue.completed_count} completed, ${nonstopQueue.failed_count} failed.`);
    return;
  }

  const item = nonstopQueue.pending_items.shift()!;
  currentNonstopItem = item;
  nonstopQueue.current_index++;
  persistNonstopQueueState();
  nonstopQueue.current_title = item.title;

  const job_id = `dl_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const cleanTitle = item.title || 'video';

  const job: JobStatus = {
    job_id,
    title: cleanTitle,
    media_url: item.media_url,
    format_id: item.format_id,
    status: 'queued',
    progress_percent: 0,
    speed_mbps: 0,
    eta_seconds: 0,
    total_bytes: 0,
    started_at: Date.now(),
  };

  activeJobs.set(job_id, job);
  addLog('info', `[Nonstop Queue ${nonstopQueue.current_index}/${nonstopQueue.total_items}] Downloading: ${cleanTitle}`);

  try {
    job.status = 'downloading';
    const result = await runPythonRunner('download-job', {
      job_id,
      media_url: item.media_url,
      title: cleanTitle,
      format_id: item.format_id,
    });

    if (!nonstopQueue.is_running) {
      // Stopped while this job was finishing
      return;
    }

    if (result.status === 'completed') {
      job.status = 'completed';
      job.progress_percent = 100;
      job.output_filename = result.output_filename;
      job.output_path = result.output_file;
      job.total_bytes = result.file_size_bytes || 0;
      job.finished_at = Date.now();
      nonstopQueue.completed_count++;
      addLog('info', `[Nonstop Queue] Finished MP4: ${result.output_filename}`);

      // Associate with current link session for 2-link storage management
      const currentSession = parsedLinkSessions[parsedLinkSessions.length - 1];
      if (currentSession && result.output_filename) {
        currentSession.outputFiles.add(result.output_filename);
        currentSession.jobIds.add(job_id);
        currentSession.reportFiles.add(`${job_id}.json`);
      }

      // VideoDownloader already performs the configured Telegram upload
      // before its Python runner returns. Do not dispatch a second upload here.
      if (result.telegram_uploaded) {
        addLog('info', `[Nonstop Queue] Telegram upload completed for: ${cleanTitle}`);
      } else if (result.telegram_result?.error) {
        addLog('warn', `[Nonstop Queue] Telegram upload warning: ${result.telegram_result.error}`);
      }
    } else {
      job.status = 'failed';
      job.error = result.error || 'Download failed in Python engine';
      job.finished_at = Date.now();
      nonstopQueue.failed_count++;
      addLog('error', `[Nonstop Queue] Item failed: ${job.error}`);
    }
  } catch (err: any) {
    if (!nonstopQueue.is_running) {
      job.status = 'failed';
      job.error = 'Halted by user';
      job.finished_at = Date.now();
      return;
    }
    job.status = 'failed';
    job.error = err.message;
    job.finished_at = Date.now();
    nonstopQueue.failed_count++;
    addLog('error', `[Nonstop Queue] Item error: ${err.message}`);
  }

  currentNonstopItem = null;
  persistNonstopQueueState();

  // If stopped, do not trigger next
  if (!nonstopQueue.is_running || isShuttingDown) {
    return;
  }

  // Nonstop: automatically process next item immediately
  setTimeout(processNextNonstopItem, 500);
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// 1. Settings
app.get('/api/settings', (req, res) => {
  try {
    let settings = {
      telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || '',
      telegram_chat_id: process.env.TELEGRAM_CHAT_ID || '',
      telegram_api_id: process.env.TELEGRAM_API_ID || '',
      telegram_api_hash: process.env.TELEGRAM_API_HASH || '',
      telegram_thread_id: process.env.TELEGRAM_THREAD_ID || '',
      auto_upload_telegram: process.env.AUTO_UPLOAD_TELEGRAM === 'true',
      max_concurrent_downloads: 3,
      max_crawl_videos: 40,
      default_resolution: 'best',
    };

    if (fs.existsSync(SETTINGS_FILE)) {
      const fileData = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
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

delete newSettings.telegram_bot_token;
delete newSettings.telegram_api_hash;
    let current = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      current = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
    const merged = { ...current, ...newSettings };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
    addLog('info', 'Updated configuration settings');
   const safeSettings = {
  ...merged,
  telegram_bot_token: '',
  telegram_api_hash: '',
  telegram_credentials_configured: Boolean(
    process.env.TELEGRAM_BOT_TOKEN || merged.telegram_bot_token
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
  if (activeCrawlTaskId) {
    const active = crawlTasks.get(activeCrawlTaskId);
    if (active?.status === 'running') {
      return res.status(409).json({ success: false, error: 'A crawl is already running. Wait for it to finish before starting another URL.' });
    }
    activeCrawlTaskId = null;
  }
  const cleanUrls = urls.filter((u: any) => typeof u === 'string' && u.trim()).map((u: string) => u.trim());
  if (!cleanUrls.length) return res.status(400).json({ success: false, error: 'A valid URL is required' });

  for (const u of cleanUrls) registerParsedLink(u);
  const taskId = `crawl_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const task: CrawlTask = { task_id: taskId, status: 'running', started_at: Date.now() };
  crawlTasks.set(taskId, task);
  activeCrawlTaskId = taskId;
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
      addLog('info', `Background crawl [${taskId}] completed: ${task.result?.total_videos_detected ?? 0} video(s) detected`);
    } catch (err: any) {
      task.status = 'failed';
      task.error = err?.message || 'Unknown crawler error';
      task.finished_at = Date.now();
      addLog('error', `Background crawl [${taskId}] failed: ${task.error}`);
    } finally {
      if (activeCrawlTaskId === taskId) activeCrawlTaskId = null;
      const expiry = Date.now() - 30 * 60 * 1000;
      for (const [id, oldTask] of crawlTasks.entries()) {
        if (oldTask.finished_at && oldTask.finished_at < expiry) crawlTasks.delete(id);
      }
    }
  })();
});

app.get('/api/scrape/status/:id', (req, res) => {
  const task = crawlTasks.get(req.params.id);
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

  activeJobs.set(job_id, job);
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
        const currentSession = parsedLinkSessions[parsedLinkSessions.length - 1];
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

// 4b. Download All Nonstop Queue
app.post('/api/download-all-nonstop', (req, res) => {
  const { videos } = req.body;
  if (!Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({ success: false, error: 'Videos array is required' });
  }

  const newItems: QueueItem[] = videos.map((v: any) => ({
    media_url: v.media_url,
    title: v.title,
    format_id: v.selected_format_id || v.format_id || 'best',
  }));

  nonstopQueue.pending_items.push(...newItems);
  nonstopQueue.total_items += newItems.length;
  persistNonstopQueueState();

  addLog('info', `Enqueued ${newItems.length} videos into Nonstop Download Queue (Total items: ${nonstopQueue.total_items})`);

  if (!nonstopQueue.is_running) {
    nonstopQueue.is_running = true;
    processNextNonstopItem();
  }

  res.json({
    success: true,
    message: `Started nonstop downloading of ${newItems.length} video(s)`,
    queue: {
      total: nonstopQueue.total_items,
      current: nonstopQueue.current_index,
      pending: nonstopQueue.pending_items.length,
      is_running: nonstopQueue.is_running,
    },
  });
});

app.get('/api/nonstop-queue/status', (req, res) => {
  res.json({
    success: true,
    queue: {
      is_running: nonstopQueue.is_running,
      total_items: nonstopQueue.total_items,
      current_index: nonstopQueue.current_index,
      current_title: nonstopQueue.current_title,
      completed_count: nonstopQueue.completed_count,
      failed_count: nonstopQueue.failed_count,
      pending_count: nonstopQueue.pending_items.length,
    },
  });
});

app.post('/api/nonstop-queue/stop', (req, res) => {
  nonstopQueue.is_running = false;
  nonstopQueue.pending_items = [];
  currentNonstopItem = null;
  nonstopQueue.current_title = '';
  persistNonstopQueueState();

  addLog('warn', 'Halt request received: Terminating all active processes immediately...');

  // 1. Terminate all tracked active runner processes
  for (const [runId, entry] of activeProcesses.entries()) {
    addLog('warn', `Forcefully killing active process [${entry.action}] (PID: ${entry.proc?.pid})`);
    terminateProcessEntry(entry);
    activeProcesses.delete(runId);
  }

  // 2. Kill any spawned child processes (FFmpeg, yt-dlp, python engine)
  try {
    const killer = spawn('pkill', ['-9', '-f', 'engine.runner|ffmpeg|yt-dlp']);

killer.on('close', () => {
  addLog('info', 'Subprocess tree termination complete');
});

killer.on('error', (err) => {
  addLog('warn', `Could not run pkill: ${err.message}`);
});
  } catch (err) {
    // ignore
  }

  // 3. Mark all ongoing jobs as canceled
  for (const [_, job] of activeJobs.entries()) {
    if (job.status === 'downloading' || job.status === 'processing_ffmpeg' || job.status === 'queued' || job.status === 'starting') {
      job.status = 'failed';
      job.error = 'Operation halted and terminated by user';
      job.finished_at = Date.now();
    }
  }

  // 4. Clean up lingering .part, .tmp, and .ytdl files
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR);
    for (const f of files) {
      if (f.endsWith('.part') || f.endsWith('.ytdl') || f.includes('.tmp.')) {
        try {
          fs.unlinkSync(path.join(DOWNLOADS_DIR, f));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  res.json({
    success: true,
    message: 'Nonstop queue and all active download/conversion processes terminated immediately.'
  });
});

// Cancel a specific job
app.post('/api/jobs/cancel/:id', (req, res) => {
  const jobId = req.params.id;
  const job = activeJobs.get(jobId);

  for (const [runId, entry] of activeProcesses.entries()) {
    if (entry.jobId === jobId) {
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
  if (activeJobs.has(jobId)) {
    activeJobs.delete(jobId);
    // Also remove from disk log if present
    const jobFile = path.join(LOGS_DIR, 'jobs', `${jobId}.json`);
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
  for (const [id, job] of activeJobs.entries()) {
    if (job.status === 'completed' || job.status === 'failed') {
      activeJobs.delete(id);
      cleared++;
      const jobFile = path.join(LOGS_DIR, 'jobs', `${id}.json`);
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
  const jobsDir = path.join(LOGS_DIR, 'jobs');
  if (fs.existsSync(jobsDir)) {
    const files = fs.readdirSync(jobsDir).filter((f) => f.endsWith('.json'));
    files.forEach((f) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(jobsDir, f), 'utf-8'));
        if (data.job_id && activeJobs.has(data.job_id)) {
          const current = activeJobs.get(data.job_id)!;
          if (current.status !== 'completed' && current.status !== 'failed') {
            Object.assign(current, data);
          }
        }
      } catch {
        // ignore parse errors
      }
    });
  }

  const jobsList = Array.from(activeJobs.values()).sort((a, b) => b.started_at - a.started_at);
  res.json({ success: true, jobs: jobsList });
});

// 6. Downloaded Files List & Stream
app.get('/api/downloads', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR);
    const videoFiles = files
      .filter((f) => f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm'))
      .map((fileName) => {
        const fullPath = path.join(DOWNLOADS_DIR, fileName);
        const stats = fs.statSync(fullPath);
        return {
          filename: fileName,
          file_path: fullPath,
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
  const filePath = path.join(DOWNLOADS_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize) {
      res.status(416).send('Requested range not satisfiable\n' + start + ' >= ' + fileSize);
      return;
    }

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
  const filePath = path.join(DOWNLOADS_DIR, fileName);

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
    const filePath = path.join(DOWNLOADS_DIR, fileName);

    let deletedFile = false;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      deletedFile = true;
      addLog('info', `Deleted downloaded video file: ${fileName}`);
    }

    // Also remove associated report in reports/
    try {
      const reports = fs.readdirSync(REPORTS_DIR);
      for (const rep of reports) {
        if (!rep.endsWith('.json')) continue;
        const repPath = path.join(REPORTS_DIR, rep);
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
    const retainedSessions = parsedLinkSessions.slice(-2);
    const files = fs.readdirSync(DOWNLOADS_DIR).filter((f) => !f.startsWith('.'));
    const reports = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json'));
    
    let totalBytes = 0;
    for (const f of files) {
      try {
        totalBytes += fs.statSync(path.join(DOWNLOADS_DIR, f)).size;
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
    purgeOlderSessionsData();
    res.json({ success: true, message: 'Purged older remaining data outside the 2 most recent links.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. JSON Reports
app.get('/api/reports', (req, res) => {
  try {
    const files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json'));
    const reports = files
      .map((f) => {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf-8'));
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
  const filePath = path.join(DOWNLOADS_DIR, cleanName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: `File not found: ${cleanName}` });
  }

  const stat = fs.statSync(filePath);
  const sizeMb = (stat.size / 1024 / 1024).toFixed(1);

  // Load configured settings
  let settings: any = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
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
  res.json({ success: true, logs: engineLogs });
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

  // Stop dispatching the next queue item, but let the active runner finish
  // while Koyeb's termination grace period is still available.
  nonstopQueue.is_running = false;
  if (httpServer) {
    httpServer.close();
    try { httpServer.closeIdleConnections?.(); } catch {}
  }

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (activeProcesses.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // If the platform's grace window is nearly over, checkpoint the in-flight
  // item so a subsequent process can retry it, then stop remaining children.
  if (activeProcesses.size > 0) {
    if (currentNonstopItem) {
      nonstopQueue.pending_items.unshift(currentNonstopItem);
      currentNonstopItem = null;
    }
    persistNonstopQueueState();
    for (const entry of activeProcesses.values()) {
      try { entry.proc?.kill('SIGTERM'); } catch {}
    }
    addLog('warn', `Grace period expired with ${activeProcesses.size} engine process(es) active; saved queue state and sent SIGTERM.`);
  } else {
    currentNonstopItem = null;
    persistNonstopQueueState();
    addLog('info', 'Active engine processes drained; nonstop queue checkpoint saved.');
  }

  setTimeout(() => process.exit(0), 1_000).unref();
}

process.on('SIGTERM', () => { void shutdownGracefully('SIGTERM'); });
process.on('SIGINT', () => { void shutdownGracefully('SIGINT'); });

restoreNonstopQueueState();

startServer().then(() => {
  if (nonstopQueue.pending_items.length > 0 && !isShuttingDown) {
    nonstopQueue.is_running = true;
    persistNonstopQueueState();
    processNextNonstopItem();
  }
}).catch((err) => {
  console.error('Fatal server startup failure:', err);
  process.exit(1);
});
