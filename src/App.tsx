import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { Header } from './components/Header';
import { VideoPlayerModal } from './components/VideoPlayerModal';
const ScraperConsole = lazy(() => import('./components/ScraperConsole').then((m) => ({ default: m.ScraperConsole })));
const QueueManager = lazy(() => import('./components/QueueManager').then((m) => ({ default: m.QueueManager })));
const FileManager = lazy(() => import('./components/FileManager').then((m) => ({ default: m.FileManager })));
const TelegramHub = lazy(() => import('./components/TelegramHub').then((m) => ({ default: m.TelegramHub })));
const LogsViewer = lazy(() => import('./components/LogsViewer').then((m) => ({ default: m.LogsViewer })));
import {
  ScrapedVideo,
  InspectionReport,
  JobStatus,
  NonstopQueueStatus,
  DownloadedFile,
  EngineLog,
  Settings
} from './types';

export default function App() {
  const [activeTab, setActiveTab] = useState<'console' | 'queue' | 'files' | 'telegram' | 'logs'>('console');
  const [urlsInput, setUrlsInput] = useState<string>('https://en.wikipedia.org/wiki/Big_Buck_Bunny');
  const [isTesting, setIsTesting] = useState<boolean>(false);
  const [isScraping, setIsScraping] = useState<boolean>(false);
  const [operationMessage, setOperationMessage] = useState<string>('');
  const [operationError, setOperationError] = useState<string>('');
  const [deepCrawl, setDeepCrawl] = useState<boolean>(true);
  const [maxCrawlVideos, setMaxCrawlVideos] = useState<number>(40);
  const [nonstopStatus, setNonstopStatus] = useState<NonstopQueueStatus | null>(null);

  const [inspectionReport, setInspectionReport] = useState<InspectionReport | null>(null);
  const [telegramTestResult, setTelegramTestResult] = useState<any | null>(null);
  const [videos, setVideos] = useState<ScrapedVideo[]>([]);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [files, setFiles] = useState<DownloadedFile[]>([]);
  const [logs, setLogs] = useState<EngineLog[]>([]);
  const [settings, setSettings] = useState<Settings>({
    telegram_bot_token: '',
    telegram_chat_id: '',
    telegram_api_id: '',
    telegram_api_hash: '',
    telegram_thread_id: '',
    auto_upload_telegram: true,
    max_concurrent_downloads: 3,
    max_crawl_videos: 40,
    default_resolution: 'best'
  });

  // Modal State for Video Player
  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    videoUrl: string;
    title: string;
    isStream: boolean;
  }>({
    isOpen: false,
    videoUrl: '',
    title: '',
    isStream: false
  });

  // Fetch initial data
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (data.success && data.settings) {
        setSettings(data.settings);
        if (data.settings.max_crawl_videos) {
          setMaxCrawlVideos(data.settings.max_crawl_videos);
        }
      }
    } catch (e) {
      console.error('Failed to load settings', e);
    }
  }, []);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs');
      const data = await res.json();
      if (data.success && data.jobs) {
        setJobs(data.jobs);
      }
    } catch (e) {
      console.error('Failed to load jobs', e);
    }
  }, []);

  const fetchNonstopStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/nonstop-queue/status');
      const data = await res.json();
      if (data.success && data.queue) {
        setNonstopStatus(data.queue);
      }
    } catch (e) {
      console.error('Failed to load nonstop status', e);
    }
  }, []);

  const fetchFiles = useCallback(async () => {
    try {
      const res = await fetch('/api/downloads');
      const data = await res.json();
      if (data.success && data.files) {
        setFiles(data.files);
      }
    } catch (e) {
      console.error('Failed to load downloaded files', e);
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/logs');
      const data = await res.json();
      if (data.success && data.logs) {
        setLogs(data.logs);
      }
    } catch (e) {
      console.error('Failed to load logs', e);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchJobs();
    fetchNonstopStatus();
    fetchFiles();
    fetchLogs();
  }, [fetchSettings, fetchJobs, fetchNonstopStatus, fetchFiles, fetchLogs]);

  // Polling for jobs and nonstop queue
  useEffect(() => {
    const hasActiveJobs = jobs.some(
      (j) => j.status !== 'completed' && j.status !== 'failed'
    );
    const isNonstopRunning = nonstopStatus?.is_running;

    const interval = setInterval(() => {
      fetchJobs();
      fetchNonstopStatus();
      if (hasActiveJobs || isNonstopRunning) {
        fetchFiles();
      }
    }, hasActiveJobs || isNonstopRunning ? 1200 : 3500);

    return () => clearInterval(interval);
  }, [jobs, nonstopStatus, fetchJobs, fetchNonstopStatus, fetchFiles]);

  // Dedicated "Test Website" action
  const handleTestWebsite = async () => {
    const urls = urlsInput
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    if (urls.length === 0) return;

    setIsTesting(true);
    setOperationError('');
    setOperationMessage('Website test has started…');
    setInspectionReport(null);
    setTelegramTestResult(null);
    setVideos([]); // Delete previous link's result from scraper console immediately

    try {
      const targetUrl = urls[0];
      setOperationMessage('Website test is in progress…');
      const res = await fetch('/api/test-website', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          telegram_bot_token: settings.telegram_bot_token,
          telegram_chat_id: settings.telegram_chat_id,
          max_subpages: 10
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Test Website request failed (HTTP ' + res.status + ').');
      }
      if (!data.inspection) {
        throw new Error(data.error || 'The test finished without returning an inspection report.');
      }
      const inspection = data.inspection;
      const testVideos = Array.isArray(inspection.videos) ? inspection.videos : [];
      setInspectionReport({ ...inspection, videos: testVideos });
      setTelegramTestResult(data.telegram_notification);
      setVideos(testVideos);
      if (inspection.error || (!inspection.success && testVideos.length === 0)) {
        setOperationMessage('');
        setOperationError(inspection.error || 'Website test could not verify any playable video streams.');
      } else if (testVideos.length > 0) {
        setOperationMessage('Website test completed. Results are ready.');
        setTimeout(() => setOperationMessage(''), 1800);
      } else {
        setOperationMessage('');
      }
    } catch (err: any) {
      const message = err?.message || 'Unknown error';
      console.error('Test website failed', err);
      setOperationMessage('');
      setOperationError(message);
    } finally {
      setIsTesting(false);
      fetchLogs();
      fetchFiles();
      fetchJobs();
    }
  };

  // Start Batch Scraping & Deep Crawl action with pagination support
  const handleStartScraping = async (offset = 0, customMaxSubpages?: number, append = false) => {
    const urls = urlsInput
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    if (urls.length === 0) return;

    setIsScraping(true);
    setOperationError('');
    setOperationMessage('Crawler has started…');
    if (!append) {
      setInspectionReport(null);
      setVideos([]); // Delete previous link's result from scraper console immediately
    }

    try {
      const subpagesLimit = customMaxSubpages !== undefined ? customMaxSubpages : maxCrawlVideos;
      const startRes = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls,
          deep_crawl: deepCrawl,
          max_subpages: subpagesLimit,
          subpage_offset: offset
        })
      });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok) {
        throw new Error(startData.error || 'Crawler request failed (HTTP ' + startRes.status + ').');
      }
      if (!startData.task_id) throw new Error('Crawler did not return a task ID.');

      setOperationMessage('Crawler is in progress…');
      // Poll the background task instead of holding a long HTTP request open.
      let data: any = null;
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const statusRes = await fetch(`/api/scrape/status/${encodeURIComponent(startData.task_id)}`);
        const statusData = await statusRes.json().catch(() => ({}));
        if (!statusRes.ok) {
          throw new Error(statusData.error || 'Could not retrieve crawler status (HTTP ' + statusRes.status + ').');
        }
        // Keep the console activity feed live while the background worker runs.
        await fetchLogs();
        if (statusData.status === 'completed') {
          data = statusData.result;
          break;
        }
        if (statusData.status === 'failed') {
          throw new Error(statusData.error || 'Crawler failed.');
        }
      }
      // Accept both the batch response shape and a single-report response shape.
      // Some deployments may wrap the runner payload one level deeper.
      let payload = data;
      for (let depth = 0; depth < 3; depth++) {
        if (payload?.result && typeof payload.result === 'object') payload = payload.result;
        else if (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) payload = payload.data;
        else break;
      }
      const rawReports = Array.isArray(payload?.results) ? payload.results
        : Array.isArray(payload?.reports) ? payload.reports
        : Array.isArray(payload?.data?.results) ? payload.data.results
        : (Array.isArray(payload?.videos) ? [payload] : []);
      const reports: InspectionReport[] = rawReports;
      const rawVideos: any[] = reports.flatMap((rep: any) => Array.isArray(rep?.videos) ? rep.videos : []);
      const extracted: ScrapedVideo[] = rawVideos.filter((v: any) => v && (v.media_url || v.url)).map((v: any, index: number) => ({
        ...v,
        id: String(v.id || v.media_url || v.url || `crawl-video-${index}`),
        title: String(v.title || v.name || `Video ${index + 1}`),
        media_url: String(v.media_url || v.url),
        page_url: String(v.page_url || v.source_url || ''),
        resolution: String(v.resolution || 'Adaptive'),
        format: String(v.format || 'MP4'),
        protocol: String(v.protocol || 'Stream'),
        formats_available: Array.isArray(v.formats_available) ? v.formats_available : []
      }));

      if (reports.length > 0) {
        const firstReport = reports[0];
        setInspectionReport({ ...firstReport, videos: Array.isArray(firstReport.videos) ? firstReport.videos : [] });
      } else if (payload?.error || payload?.errors?.length) {
        const details = payload.error || payload.errors.map((item: any) => item.error || String(item)).join('; ');
        throw new Error(details);
      }

      if (append) {
        setVideos((prev) => {
          const seen = new Set(prev.map((v) => v.media_url || v.id));
          const newOnes = extracted.filter((v) => !seen.has(v.media_url || v.id));
          return [...prev, ...newOnes];
        });
      } else {
        setVideos(extracted);
      }

      if (extracted.length > 0) {
        setOperationMessage('Crawling completed. Results are ready.');
        setOperationError('');
        setTimeout(() => setOperationMessage(''), 1800);
      } else if (Number(payload?.total_videos_detected || 0) > 0) {
        throw new Error(`Crawler reported ${payload.total_videos_detected} detected videos, but the result payload contained no video records. Please retry once; if repeated, share the task ID and this message.`);
      }

      if (extracted.length === 0) {
        const failed = payload?.errors?.length || reports.some((rep) => rep.error);
        if (failed) {
          const details = (payload.errors || reports.filter((rep) => rep.error).map((rep) => ({ error: rep.error })))
            .map((item: any) => item.error || String(item)).join('; ');
          throw new Error(details || 'Crawl finished, but one or more pages failed.');
        }
      }
    } catch (err: any) {
      const message = err?.message || 'Unknown crawler error';
      console.error('Deep scrape failed', err);
      setOperationMessage('');
      setOperationError(message);
    } finally {
      setIsScraping(false);
      fetchLogs();
      fetchFiles();
      fetchJobs();
    }
  };

  // Dedicated "Load Next 100 Videos" action
  const handleLoadNextBatch = async () => {
    if (!inspectionReport || inspectionReport.next_offset === undefined || inspectionReport.next_offset === null) return;
    const batchSize = maxCrawlVideos > 0 ? maxCrawlVideos : 100;
    await handleStartScraping(inspectionReport.next_offset, batchSize, true);
  };

  // Dedicated "Crawl All Remaining Subpages" action (unlimited)
  const handleCrawlAllSubpages = async () => {
    const startOffset = inspectionReport?.next_offset || 0;
    // max_subpages = 0 indicates no artificial limit, scan all remaining discovered subpages
    await handleStartScraping(startOffset, 0, true);
  };

  // Clear previous link's results manually
  const handleClearResults = () => {
    setVideos([]);
    setInspectionReport(null);
    setTelegramTestResult(null);
  };

  // Enqueue a single video download
  const handleDownloadVideo = async (video: ScrapedVideo, formatId?: string) => {
    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          media_url: video.media_url,
          title: video.title,
          format_id: formatId || video.selected_format_id || 'best'
        })
      });
      const data = await res.json();
      if (data.success) {
        fetchJobs();
        setActiveTab('queue');
      }
    } catch (err) {
      console.error('Failed to trigger download', err);
    }
  };

  // Bulk download
  const handleBulkDownload = async (selectedVideos: ScrapedVideo[]) => {
    await handleDownloadAllNonstop(selectedVideos);
  };

  // Automated Nonstop Download All Queue
  const handleDownloadAllNonstop = async (toDownload: ScrapedVideo[]) => {
    try {
      const res = await fetch('/api/download-all-nonstop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videos: toDownload })
      });
      const data = await res.json();
      if (data.success) {
        fetchJobs();
        fetchNonstopStatus();
        setActiveTab('queue');
      }
    } catch (err) {
      console.error('Failed to start nonstop queue', err);
    }
  };

  const handleStopNonstopQueue = async () => {
    try {
      await fetch('/api/nonstop-queue/stop', { method: 'POST' });
      await Promise.all([
        fetchJobs(),
        fetchNonstopStatus(),
        fetchFiles(),
        fetchLogs()
      ]);
    } catch (err) {
      console.error('Failed to stop nonstop queue', err);
    }
  };

  // Cancel an active job
  const handleCancelJob = async (jobId: string) => {
    try {
      await fetch(`/api/jobs/cancel/${encodeURIComponent(jobId)}`, { method: 'POST' });
      await Promise.all([fetchJobs(), fetchNonstopStatus(), fetchLogs()]);
    } catch (err) {
      console.error('Failed to cancel job', err);
    }
  };

  // Delete a job from the queue
  const handleDeleteJob = async (jobId: string) => {
    try {
      await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
      await fetchJobs();
    } catch (err) {
      console.error('Failed to delete job', err);
    }
  };

  // Clear all finished/failed jobs
  const handleClearFinishedJobs = async () => {
    try {
      await fetch('/api/jobs', { method: 'DELETE' });
      await fetchJobs();
    } catch (err) {
      console.error('Failed to clear finished jobs', err);
    }
  };

  // Save Settings
  const handleSaveSettings = async (newSettings: Partial<Settings>) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      });
      const data = await res.json();
      if (data.success && data.settings) {
        setSettings(data.settings);
      }
    } catch (err) {
      console.error('Failed to save settings', err);
    }
  };

  // Test Telegram connection
  const handleTestTelegram = async (token: string, chatId: string) => {
    const res = await fetch('/api/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegram_bot_token: token,
        telegram_chat_id: chatId,
        telegram_api_id: settings.telegram_api_id,
        telegram_api_hash: settings.telegram_api_hash
      })
    });
    return await res.json();
  };

  // Upload video file to Telegram
  const handleUploadTelegram = async (filename: string) => {
    const res = await fetch('/api/telegram/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename,
        title: filename.replace('.mp4', '').replace(/_/g, ' '),
        telegram_bot_token: settings.telegram_bot_token,
        telegram_chat_id: settings.telegram_chat_id,
        telegram_api_id: settings.telegram_api_id,
        telegram_api_hash: settings.telegram_api_hash
      })
    });
    return await res.json();
  };

  // Delete file (no window.confirm, instant optimistic update)
  const handleDeleteFile = async (filename: string) => {
    // Optimistic removal from UI state
    setFiles((prev) => prev.filter((f) => f.filename !== filename));

    try {
      const res = await fetch(`/api/downloads/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        fetchFiles();
      } else {
        // Re-fetch on error to revert state
        fetchFiles();
      }
    } catch (err) {
      console.error('Failed to delete file', err);
      fetchFiles();
    }
  };

  // Preview local file in modal
  const handlePreviewLocalFile = (filename: string, title: string) => {
    const streamUrl = `/api/downloads/stream/${encodeURIComponent(filename)}`;
    setModalState({
      isOpen: true,
      videoUrl: streamUrl,
      title: title || filename,
      isStream: false
    });
  };

  // Preview direct stream in modal
  const handlePreviewStream = (url: string, title: string, isStream = true) => {
    setModalState({
      isOpen: true,
      videoUrl: url,
      title: title || 'Media Stream Preview',
      isStream
    });
  };

  const activeDownloadsCount = jobs.filter(
    (j) => j.status !== 'completed' && j.status !== 'failed'
  ).length;

  // Header primary action mapping
  let primaryActionLabel = 'Crawl Website';
  let primaryActionFn: () => void | Promise<any> = handleStartScraping;
  if (activeTab === 'queue') {
    primaryActionLabel = 'Inspect More URLs';
    primaryActionFn = () => setActiveTab('console');
  } else if (activeTab === 'files') {
    primaryActionLabel = 'New Scrape Task';
    primaryActionFn = () => setActiveTab('console');
  } else if (activeTab === 'telegram') {
    primaryActionLabel = 'Test Telegram';
    primaryActionFn = () =>
      handleTestTelegram(
        settings.telegram_bot_token,
        settings.telegram_chat_id
      );
  } else if (activeTab === 'logs') {
    primaryActionLabel = 'Refresh Logs';
    primaryActionFn = fetchLogs;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* Top Bar Contract (3 zones) */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        activeDownloadsCount={activeDownloadsCount}
        onPrimaryAction={primaryActionFn}
        primaryActionLabel={primaryActionLabel}
      />

      {/* Main Workspace Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        <Suspense fallback={<div className="min-h-[40vh] flex items-center justify-center text-sm text-slate-400" role="status">Loading workspace…</div>}>
        {activeTab === 'console' && (
          <ScraperConsole
            urlsInput={urlsInput}
            setUrlsInput={setUrlsInput}
            isTesting={isTesting}
            isScraping={isScraping}
            onTestWebsite={handleTestWebsite}
            onStartScraping={() => handleStartScraping(0, maxCrawlVideos, false)}
            onLoadNextBatch={handleLoadNextBatch}
            onCrawlAllSubpages={handleCrawlAllSubpages}
            inspectionReport={inspectionReport}
            telegramTestResult={telegramTestResult}
            videos={videos}
            logs={logs}
            operationMessage={operationMessage}
            operationError={operationError}
            onDownloadVideo={handleDownloadVideo}
            onBulkDownload={handleBulkDownload}
            onDownloadAllNonstop={handleDownloadAllNonstop}
            onPreviewVideo={handlePreviewStream}
            deepCrawl={deepCrawl}
            setDeepCrawl={setDeepCrawl}
            maxCrawlVideos={maxCrawlVideos}
            setMaxCrawlVideos={setMaxCrawlVideos}
            nonstopStatus={nonstopStatus}
            onStopNonstopQueue={handleStopNonstopQueue}
            onClearResults={handleClearResults}
          />
        )}

        {activeTab === 'queue' && (
          <QueueManager
            jobs={jobs}
            nonstopStatus={nonstopStatus}
            onStopNonstopQueue={handleStopNonstopQueue}
            onCancelJob={handleCancelJob}
            onDeleteJob={handleDeleteJob}
            onClearFinishedJobs={handleClearFinishedJobs}
            onRetry={(job) =>
              handleDownloadVideo(
                {
                  id: job.job_id,
                  title: job.title,
                  media_url: job.media_url,
                  page_url: job.media_url,
                  resolution: 'Adaptive',
                  format: 'MP4',
                  protocol: 'Stream',
                  formats_available: []
                },
                job.format_id
              )
            }
            onPreview={handlePreviewLocalFile}
            onNavigateToConsole={() => setActiveTab('console')}
          />
        )}

        {activeTab === 'files' && (
          <FileManager
            files={files}
            onRefresh={fetchFiles}
            onPreview={handlePreviewLocalFile}
            onDelete={handleDeleteFile}
            onUploadTelegram={handleUploadTelegram}
          />
        )}

        {activeTab === 'telegram' && (
          <TelegramHub
            settings={settings}
            onSaveSettings={handleSaveSettings}
            onTestTelegram={handleTestTelegram}
          />
        )}

        {activeTab === 'logs' && (
          <LogsViewer logs={logs} onRefresh={fetchLogs} />
        )}
        </Suspense>
      </main>

      {/* In-Browser HTML5 Video Player Modal */}
      <VideoPlayerModal
        isOpen={modalState.isOpen}
        onClose={() => setModalState({ ...modalState, isOpen: false })}
        videoUrl={modalState.videoUrl}
        title={modalState.title}
        isStream={modalState.isStream}
      />
    </div>
  );
}
