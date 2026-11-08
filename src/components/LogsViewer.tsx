import React, { useState } from 'react';
import { Terminal, Copy, Check, Trash2, RefreshCw } from 'lucide-react';
import { EngineLog } from '../types';

interface LogsViewerProps {
  logs: EngineLog[];
  onRefresh: () => void;
}

export const LogsViewer: React.FC<LogsViewerProps> = ({ logs, onRefresh }) => {
  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [copied, setCopied] = useState(false);

  const filteredLogs = logs.filter((log) => {
    if (filter === 'all') return true;
    return log.level === filter;
  });

  const handleCopyLogs = () => {
    const text = logs
      .map((l) => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`)
      .join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-slate-800">
        <div>
          <h2 className="text-base font-semibold text-white">Engine Output & Diagnostics</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Real-time stdout/stderr stream from Scrapling, yt-dlp, and FFmpeg remux processes.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Segmented control filter (interactive button group) */}
          <div className="flex items-center gap-1 p-0.5 bg-slate-900 border border-slate-800 rounded-lg">
            {(['all', 'info', 'warn', 'error'] as const).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setFilter(lvl)}
                className={`px-2.5 py-1 text-xs font-medium rounded capitalize transition-colors ${
                  filter === lvl
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          <button
            onClick={handleCopyLogs}
            className="p-1.5 rounded-lg border border-slate-800 text-slate-300 hover:bg-slate-800 text-xs inline-flex items-center gap-1 transition-colors"
            title="Copy logs"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={onRefresh}
            className="p-1.5 rounded-lg border border-slate-800 text-slate-300 hover:bg-slate-800 text-xs inline-flex items-center gap-1 transition-colors"
            title="Refresh logs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal View */}
      <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800/80 bg-slate-900/60 text-xs text-slate-400 font-mono">
          <div className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5 text-cyan-400" />
            <span>engine-runner.log</span>
          </div>
          <span className="tabular-nums">{filteredLogs.length} events logged</span>
        </div>

        <div className="p-4 font-mono text-xs max-h-[500px] overflow-y-auto space-y-1.5 bg-slate-950">
          {filteredLogs.length === 0 ? (
            <p className="text-slate-600 italic">No events recorded matching criteria.</p>
          ) : (
            filteredLogs.map((log, index) => {
              const time = new Date(log.timestamp).toLocaleTimeString();
              const levelColor =
                log.level === 'error'
                  ? 'text-rose-400'
                  : log.level === 'warn'
                  ? 'text-amber-400'
                  : 'text-slate-400';

              return (
                <div key={index} className="flex items-start gap-2 text-slate-300 leading-relaxed break-all">
                  <span className="text-slate-600 select-none tabular-nums shrink-0">[{time}]</span>
                  <span className={`uppercase font-semibold text-[10px] select-none shrink-0 ${levelColor}`}>
                    [{log.level}]
                  </span>
                  <span className="flex-1">{log.message}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
