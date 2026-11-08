import React from 'react';
import { Layers } from 'lucide-react';

interface HeaderProps {
  activeTab: 'console' | 'queue' | 'files' | 'telegram' | 'logs';
  setActiveTab: (tab: 'console' | 'queue' | 'files' | 'telegram' | 'logs') => void;
  activeDownloadsCount: number;
  onPrimaryAction: () => void | Promise<any>;
  primaryActionLabel: string;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  activeDownloadsCount,
  onPrimaryAction,
  primaryActionLabel,
}) => {
  return (
    <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 px-6 py-3.5">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-8">
        {/* Zone 1: Brand wordmark (single text element) */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-cyan-600 to-blue-500 flex items-center justify-center text-white shadow-md shadow-cyan-950/50">
            <Layers className="w-4 h-4" />
          </div>
          <span className="text-base font-semibold tracking-tight text-white whitespace-nowrap">
            Vortex Media Scraper
          </span>
        </div>

        {/* Zone 2: 4-5 single-line clean navigation links */}
        <nav className="hidden md:flex items-center gap-1.5 text-sm font-medium text-slate-400">
          <button
            onClick={() => setActiveTab('console')}
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'console'
                ? 'text-white bg-slate-800/90 shadow-sm'
                : 'hover:text-slate-200 hover:bg-slate-900/50'
            }`}
          >
            Scraper Console
          </button>

          <button
            onClick={() => setActiveTab('queue')}
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
              activeTab === 'queue'
                ? 'text-white bg-slate-800/90 shadow-sm'
                : 'hover:text-slate-200 hover:bg-slate-900/50'
            }`}
          >
            <span>Media Queue</span>
            {activeDownloadsCount > 0 && (
              <span className="font-mono text-xs tabular-nums px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300">
                {activeDownloadsCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('files')}
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'files'
                ? 'text-white bg-slate-800/90 shadow-sm'
                : 'hover:text-slate-200 hover:bg-slate-900/50'
            }`}
          >
            Downloads & Files
          </button>

          <button
            onClick={() => setActiveTab('telegram')}
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'telegram'
                ? 'text-white bg-slate-800/90 shadow-sm'
                : 'hover:text-slate-200 hover:bg-slate-900/50'
            }`}
          >
            Telegram Hub
          </button>

          <button
            onClick={() => setActiveTab('logs')}
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'logs'
                ? 'text-white bg-slate-800/90 shadow-sm'
                : 'hover:text-slate-200 hover:bg-slate-900/50'
            }`}
          >
            Engine Logs
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={onPrimaryAction}
            className="px-4 py-2 text-xs font-semibold text-white bg-gradient-to-r from-cyan-500 to-blue-600 rounded-lg hover:from-cyan-400 hover:to-blue-500 shadow-md shadow-cyan-950/40 transition-all whitespace-nowrap shrink-0 active:scale-95"
          >
            {primaryActionLabel}
          </button>
        </div>
      </div>
    </header>
  );
};
