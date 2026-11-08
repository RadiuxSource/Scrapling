import React from 'react';
import {
  Download,
  CheckCircle2,
  AlertCircle,
  Play,
  RotateCcw,
  StopCircle,
  Trash2,
  X
} from 'lucide-react';
import { JobStatus, NonstopQueueStatus } from '../types';

interface QueueManagerProps {
  jobs: JobStatus[];
  onRetry: (job: JobStatus) => void;
  onPreview: (filename: string, title: string) => void;
  onNavigateToConsole: () => void;
  nonstopStatus?: NonstopQueueStatus | null;
  onStopNonstopQueue?: () => void;
  onCancelJob?: (jobId: string) => void;
  onDeleteJob?: (jobId: string) => void;
  onClearFinishedJobs?: () => void;
}

export const QueueManager: React.FC<QueueManagerProps> = ({
  jobs,
  onRetry,
  onPreview,
  onNavigateToConsole,
  nonstopStatus,
  onStopNonstopQueue,
  onCancelJob,
  onDeleteJob,
  onClearFinishedJobs,
}) => {
  const activeJobsCount = jobs.filter(
    (j) => j.status !== 'completed' && j.status !== 'failed'
  ).length;

  const finishedJobsCount = jobs.filter(
    (j) => j.status === 'completed' || j.status === 'failed'
  ).length;

  return (
    <div className="space-y-6">
      {/* Nonstop Auto-pilot Live Banner */}
      {nonstopStatus && nonstopStatus.is_running && (
        <div className="bg-gradient-to-r from-emerald-950/80 via-slate-900 to-teal-950/80 border border-emerald-500/50 rounded-xl p-4 shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-in fade-in">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
              <h3 className="text-sm font-semibold text-white">
                Nonstop Batch Downloader Active
              </h3>
              <span className="font-mono text-xs tabular-nums text-emerald-300">
                [{nonstopStatus.current_index}/{nonstopStatus.total_items}]
              </span>
            </div>
            <p className="text-xs text-slate-300 truncate max-w-lg mt-0.5">
              Current video: <span className="font-medium text-white">{nonstopStatus.current_title || 'Downloading...'}</span>
            </p>
            <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono tabular-nums pt-1">
              <span>Completed: {nonstopStatus.completed_count}</span>
              <span aria-hidden="true">·</span>
              <span>Pending: {nonstopStatus.pending_count}</span>
              <span aria-hidden="true">·</span>
              <span>Failed: {nonstopStatus.failed_count}</span>
            </div>
          </div>

          {onStopNonstopQueue && (
            <button
              onClick={onStopNonstopQueue}
              className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold self-start sm:self-center transition-colors inline-flex items-center gap-1.5 shadow-md shadow-rose-950/50"
            >
              <StopCircle className="w-4 h-4" />
              <span>Halt & Terminate All</span>
            </button>
          )}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-slate-800">
        <div>
          <h2 className="text-base font-semibold text-white">Media Download Queue</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Real-time download progress, stream merging, and FFmpeg MP4 remuxing status.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs font-mono tabular-nums text-slate-400">
            {activeJobsCount} active / {jobs.length} total
          </span>

          {activeJobsCount > 0 && onStopNonstopQueue && (
            <button
              onClick={onStopNonstopQueue}
              className="px-3 py-1 rounded-lg bg-rose-950/60 hover:bg-rose-900/80 border border-rose-700/50 text-rose-300 text-xs font-medium inline-flex items-center gap-1.5 transition-colors"
              title="Terminate all active downloads and processes"
            >
              <StopCircle className="w-3.5 h-3.5" />
              <span>Halt All Operations</span>
            </button>
          )}

          {finishedJobsCount > 0 && onClearFinishedJobs && (
            <button
              onClick={onClearFinishedJobs}
              className="px-3 py-1 rounded-lg border border-slate-800 hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-xs transition-colors"
              title="Clear completed and failed jobs from queue"
            >
              Clear Finished
            </button>
          )}
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl py-16 px-6 text-center shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-slate-800/80 border border-slate-700/60 flex items-center justify-center mx-auto text-slate-500 mb-3">
            <Download className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-medium text-slate-300">No Active or Recent Downloads</h4>
          <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1">
            Pick detected videos from the Scraper Console and click Download MP4 to enqueue them.
          </p>
          <button
            onClick={onNavigateToConsole}
            className="mt-4 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg transition-colors"
          >
            Go to Scraper Console
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const isCompleted = job.status === 'completed';
            const isFailed = job.status === 'failed';
            const isFFmpeg = job.status === 'processing_ffmpeg';
            const isUploadingTelegram = job.status === 'uploading_telegram';
            const isActive = !isCompleted && !isFailed;

            const sizeMb = job.total_bytes
              ? (job.total_bytes / (1024 * 1024)).toFixed(1)
              : null;

            return (
              <div
                key={job.job_id}
                className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm space-y-3"
              >
                {/* Title & Status */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-semibold text-white truncate max-w-xl">
                      {job.title}
                    </h4>
                    {/* Clean unboxed metadata */}
                    <div className="flex items-center gap-2 text-xs text-slate-400 pt-0.5">
                      <span className="font-mono text-[11px] text-slate-500 truncate max-w-xs">
                        {job.media_url}
                      </span>
                      {sizeMb && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">{sizeMb} MB</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Status Indicator & Cancel / Delete Button */}
                  <div className="flex items-center gap-2 shrink-0">
                    {isCompleted ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Ready (MP4)</span>
                      </span>
                    ) : isFailed ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-rose-400 font-medium">
                        <AlertCircle className="w-4 h-4" />
                        <span>{job.error === 'Operation halted and terminated by user' ? 'Halted' : 'Failed'}</span>
                      </span>
                    ) : isFFmpeg ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-amber-400 font-medium">
                        <div className="w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                        <span>FFmpeg Remuxing...</span>
                      </span>
                    ) : isUploadingTelegram ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-cyan-400 font-medium">
                        <div className="w-3.5 h-3.5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                        <span>Uploading to Telegram...</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs text-cyan-400 font-medium">
                        <div className="w-3.5 h-3.5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                        <span className="font-mono tabular-nums">
                          {job.progress_percent.toFixed(0)}%
                        </span>
                      </span>
                    )}

                    {/* Instant Cancel button for active jobs */}
                    {isActive && onCancelJob && (
                      <button
                        onClick={() => onCancelJob(job.job_id)}
                        className="p-1 text-slate-400 hover:text-rose-400 hover:bg-rose-950/40 rounded transition-colors"
                        title="Cancel this download immediately"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}

                    {/* Remove from queue for finished jobs */}
                    {!isActive && onDeleteJob && (
                      <button
                        onClick={() => onDeleteJob(job.job_id)}
                        className="p-1 text-slate-500 hover:text-rose-400 hover:bg-rose-950/30 rounded transition-colors"
                        title="Dismiss job from queue"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800/80">
                  <div
                    className={`h-full transition-all duration-300 ${
                      isCompleted
                        ? 'bg-emerald-500'
                        : isFailed
                        ? 'bg-rose-500'
                        : isFFmpeg
                        ? 'bg-amber-500 animate-pulse'
                        : 'bg-gradient-to-r from-cyan-500 to-blue-500'
                    }`}
                    style={{
                      width: `${Math.max(4, Math.min(100, job.progress_percent))}%`
                    }}
                  />
                </div>

                {/* Stats / Actions Row */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 text-xs text-slate-400">
                  <div className="flex items-center gap-3 font-mono tabular-nums">
                    {job.speed_mbps > 0 && !isCompleted && !isFailed && (
                      <span>{job.speed_mbps.toFixed(1)} MB/s</span>
                    )}
                    {job.eta_seconds > 0 && !isCompleted && !isFailed && (
                      <span>ETA: {job.eta_seconds}s</span>
                    )}
                    {job.output_filename && (
                      <span className="truncate max-w-sm text-slate-300">
                        {job.output_filename}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {isFailed && (
                      <button
                        onClick={() => onRetry(job)}
                        className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs inline-flex items-center gap-1 transition-colors"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>Retry</span>
                      </button>
                    )}

                    {isCompleted && job.output_filename && (
                      <>
                        <button
                          onClick={() =>
                            onPreview(job.output_filename!, job.title)
                          }
                          className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs font-medium inline-flex items-center gap-1 transition-colors"
                        >
                          <Play className="w-3 h-3" />
                          <span>Play MP4</span>
                        </button>

                        <a
                          href={`/api/downloads/file/${encodeURIComponent(
                            job.output_filename
                          )}`}
                          download
                          className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs inline-flex items-center gap-1 transition-colors"
                        >
                          <Download className="w-3 h-3" />
                          <span>Save</span>
                        </a>
                      </>
                    )}
                  </div>
                </div>

                {/* Failure Error Message */}
                {isFailed && job.error && (
                  <div className="text-xs text-rose-300 bg-rose-950/20 border border-rose-900/30 rounded p-2 font-mono">
                    {job.error}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
