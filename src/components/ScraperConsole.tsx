import React, { useState } from 'react';
import {
  Search,
  Play,
  Download,
  Copy,
  Check,
  Send,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Sliders,
  Sparkles,
  ChevronDown,
  Globe,
  Radio,
  Square
} from 'lucide-react';
import { ScrapedVideo, InspectionReport, NonstopQueueStatus } from '../types';

interface ScraperConsoleProps {
  urlsInput: string;
  setUrlsInput: (val: string) => void;
  isTesting: boolean;
  isScraping: boolean;
  onTestWebsite: () => void;
  onStartScraping: () => void;
  inspectionReport: InspectionReport | null;
  telegramTestResult: any;
  videos: ScrapedVideo[];
  onDownloadVideo: (video: ScrapedVideo, formatId?: string) => void;
  onBulkDownload: (selectedVideos: ScrapedVideo[]) => void;
  onDownloadAllNonstop: (videos: ScrapedVideo[]) => void;
  onPreviewVideo: (url: string, title: string, isStream?: boolean) => void;
  deepCrawl: boolean;
  setDeepCrawl: (val: boolean) => void;
  maxCrawlVideos: number;
  setMaxCrawlVideos: (val: number) => void;
  nonstopStatus: NonstopQueueStatus | null;
  onStopNonstopQueue: () => void;
  onClearResults?: () => void;
  onLoadNextBatch?: () => void;
  onCrawlAllSubpages?: () => void;
}

const SAMPLE_URLS = [
  {
    name: 'Mux HLS Master (M3U8)',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
  },
  {
    name: 'Wikimedia Video Catalog Page',
    url: 'https://en.wikipedia.org/wiki/Big_Buck_Bunny'
  },
  {
    name: 'HTML5 Video Direct Page',
    url: 'https://en.wikipedia.org/wiki/File:Big_Buck_Bunny_4K.webm'
  }
];

export const ScraperConsole: React.FC<ScraperConsoleProps> = ({
  urlsInput,
  setUrlsInput,
  isTesting,
  isScraping,
  onTestWebsite,
  onStartScraping,
  inspectionReport,
  telegramTestResult,
  videos,
  onDownloadVideo,
  onBulkDownload,
  onDownloadAllNonstop,
  onPreviewVideo,
  deepCrawl,
  setDeepCrawl,
  maxCrawlVideos,
  setMaxCrawlVideos,
  nonstopStatus,
  onStopNonstopQueue,
  onClearResults,
  onLoadNextBatch,
  onCrawlAllSubpages,
}) => {
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [formatSelections, setFormatSelections] = useState<Record<string, string>>({});

  const urlsList = urlsInput
    .split('\n')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedVideoIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedVideoIds(next);
  };

  const toggleSelectAll = () => {
    if (selectedVideoIds.size === filteredVideos.length) {
      setSelectedVideoIds(new Set());
    } else {
      setSelectedVideoIds(new Set(filteredVideos.map((v) => v.id)));
    }
  };

  const handleBulkDownloadClick = () => {
    const toDownload = videos
      .filter((v) => selectedVideoIds.has(v.id))
      .map((v) => ({
        ...v,
        selected_format_id: formatSelections[v.id] || v.formats_available[0]?.format_id || 'best'
      }));
    if (toDownload.length > 0) {
      onBulkDownload(toDownload);
    }
  };

  const handleDownloadAllClick = () => {
    const allWithFormats = videos.map((v) => ({
      ...v,
      selected_format_id: formatSelections[v.id] || v.formats_available[0]?.format_id || 'best'
    }));
    onDownloadAllNonstop(allWithFormats);
  };

  const filteredVideos = videos.filter((v) => {
    if (!searchFilter.trim()) return true;
    const q = searchFilter.toLowerCase();
    return (
      v.title.toLowerCase().includes(q) ||
      v.protocol.toLowerCase().includes(q) ||
      v.resolution.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      {/* Nonstop Queue Live Status Banner */}
      {nonstopStatus && nonstopStatus.is_running && (
        <div className="bg-gradient-to-r from-cyan-950/80 via-slate-900 to-blue-950/80 border border-cyan-500/50 rounded-xl p-4 shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/20 text-cyan-400">
              <Radio className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white">
                  Nonstop Auto-Pilot Active
                </span>
                <span className="font-mono text-xs tabular-nums text-cyan-300">
                  [{nonstopStatus.current_index}/{nonstopStatus.total_items}]
                </span>
              </div>
              <p className="text-xs text-slate-300 truncate max-w-lg mt-0.5">
                Downloading: <span className="font-medium text-white">{nonstopStatus.current_title || 'Preparing next stream...'}</span>
              </p>
              <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono tabular-nums pt-1">
                <span>Completed: {nonstopStatus.completed_count}</span>
                <span aria-hidden="true">·</span>
                <span>Failed: {nonstopStatus.failed_count}</span>
                <span aria-hidden="true">·</span>
                <span>Pending: {nonstopStatus.pending_count}</span>
              </div>
            </div>
          </div>

          <button
            onClick={onStopNonstopQueue}
            className="px-3.5 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 text-rose-300 text-xs font-medium inline-flex items-center gap-1.5 self-start sm:self-center transition-colors"
          >
            <Square className="w-3.5 h-3.5" />
            <span>Stop Nonstop Queue</span>
          </button>
        </div>
      )}

      {/* Target URLs Input Card */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-white">Target Website URL(s)</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Enter any website homepage, video gallery, channel, or direct link. The deep crawler will inspect all subpages.
            </p>
          </div>

          {/* Quick preset samples */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-slate-500">Quick load:</span>
            {SAMPLE_URLS.map((sample, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  const existing = urlsInput.trim();
                  setUrlsInput(existing ? `${existing}\n${sample.url}` : sample.url);
                }}
                className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700/60 transition-colors whitespace-nowrap"
              >
                {sample.name}
              </button>
            ))}
          </div>
        </div>

        {/* Textarea */}
        <div className="mt-4">
          <textarea
            value={urlsInput}
            onChange={(e) => setUrlsInput(e.target.value)}
            rows={4}
            placeholder="https://example.com/ (whole website catalog)\nhttps://video-platform.com/channel/...\nhttps://site.org/category/videos"
            className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500 resize-y"
          />
        </div>

        {/* Deep Crawling Options Strip */}
        <div className="mt-3 py-2 px-3 rounded-lg bg-slate-950/60 border border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={deepCrawl}
                onChange={(e) => setDeepCrawl(e.target.checked)}
                className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-cyan-500"
              />
              <span className="font-medium text-slate-200">
                Deep Crawl Whole Website
              </span>
              <span className="text-[11px] text-slate-500">
                (Scan homepage & follow all video watch links)
              </span>
            </label>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>Subpages per Batch:</span>
            <select
              value={maxCrawlVideos}
              onChange={(e) => setMaxCrawlVideos(Number(e.target.value))}
              className="bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500 font-mono"
            >
              <option value={25}>25 subpages</option>
              <option value={50}>50 subpages</option>
              <option value={100}>100 subpages (Standard Batch)</option>
              <option value={250}>250 subpages (Deep Catalog)</option>
              <option value={500}>500 subpages (Massive Archive)</option>
              <option value={0}>All Subpages (Unlimited Nonstop)</option>
            </select>
          </div>
        </div>

        {/* Action Controls */}
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-slate-800/80">
          <div className="flex items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
            <span>{urlsList.length} URL(s) detected</span>
            {urlsList.length > 0 && (
              <button
                onClick={() => setUrlsInput('')}
                className="text-slate-500 hover:text-rose-400 ml-2 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            {/* Dedicated Test Website Button */}
            <button
              onClick={onTestWebsite}
              disabled={isTesting || urlsList.length === 0}
              className="px-4 py-2 text-xs font-semibold rounded-lg border border-cyan-500/40 bg-cyan-950/30 text-cyan-300 hover:bg-cyan-900/40 hover:border-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2 whitespace-nowrap active:scale-95"
            >
              {isTesting ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                  <span>Inspecting Whole Website...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Test Website</span>
                </>
              )}
            </button>

            {/* Start Scraping Button */}
            <button
              onClick={onStartScraping}
              disabled={isScraping || urlsList.length === 0}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white shadow-md shadow-cyan-950/40 disabled:opacity-40 disabled:cursor-not-allowed transition-all inline-flex items-center gap-2 whitespace-nowrap active:scale-95"
            >
              {isScraping ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Crawling Catalog...</span>
                </>
              ) : (
                <>
                  <Search className="w-3.5 h-3.5" />
                  <span>Crawl Website Videos</span>
                </>
              )}
            </button>

            {/* Download All Nonstop Button */}
            {videos.length > 0 && (
              <button
                onClick={handleDownloadAllClick}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white shadow-md shadow-emerald-950/40 transition-all inline-flex items-center gap-2 whitespace-nowrap active:scale-95 animate-pulse"
                title="Download all discovered videos nonstop one by one and auto-forward to Telegram"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download All Nonstop ({videos.length})</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Inspection Test Report Banner */}
      {inspectionReport && (
        <div
          className={`border rounded-xl p-4.5 transition-all ${
            inspectionReport.success
              ? 'bg-slate-900/90 border-cyan-500/40 shadow-sm'
              : 'bg-slate-900/90 border-rose-500/40'
          }`}
        >
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div
                className={`mt-0.5 p-1.5 rounded-lg ${
                  inspectionReport.success
                    ? 'bg-cyan-500/10 text-cyan-400'
                    : 'bg-rose-500/10 text-rose-400'
                }`}
              >
                {inspectionReport.success ? (
                  <CheckCircle2 className="w-5 h-5" />
                ) : (
                  <AlertCircle className="w-5 h-5" />
                )}
              </div>

              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-white">
                    {inspectionReport.is_catalog_page
                      ? 'Website Video Catalog Inspected Successfully!'
                      : inspectionReport.success
                      ? 'Website Media Inspection Test Succeeded'
                      : 'Inspection Notice'}
                  </h3>
                  {inspectionReport.status_code && (
                    <span className="font-mono text-xs text-slate-400 tabular-nums">
                      HTTP {inspectionReport.status_code}
                    </span>
                  )}
                </div>

                <p className="text-xs text-slate-300 font-medium">
                  {inspectionReport.page_title || inspectionReport.page_url}
                </p>

                {/* Clean unboxed metadata */}
                <div className="flex items-center gap-2 text-xs text-slate-400 pt-1 flex-wrap">
                  {inspectionReport.subpages_discovered && inspectionReport.subpages_discovered > 0 ? (
                    <>
                      <span className="text-cyan-300 font-medium tabular-nums">
                        {inspectionReport.subpages_discovered} video subpages discovered
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">
                        {inspectionReport.subpages_scanned} subpages scanned in parallel
                      </span>
                      <span aria-hidden="true">·</span>
                    </>
                  ) : null}
                  <span className="tabular-nums font-semibold text-emerald-400">
                    {inspectionReport.videos.length} playable stream(s) verified
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Detected:{' '}
                    {inspectionReport.detected_players.length > 0
                      ? inspectionReport.detected_players.join(', ')
                      : 'Direct HTML5'}
                  </span>
                </div>
              </div>
            </div>

            {/* Telegram test status feedback */}
            {telegramTestResult && (
              <div className="shrink-0 text-right sm:max-w-xs">
                {telegramTestResult.skipped ? (
                  <div className="text-xs text-slate-400 bg-slate-950/60 border border-slate-800 rounded px-2.5 py-1 inline-flex items-center gap-1.5">
                    <Send className="w-3 h-3 text-slate-500" />
                    <span>Telegram credentials not configured</span>
                  </div>
                ) : telegramTestResult.success ? (
                  <div className="text-xs text-emerald-400 bg-emerald-950/30 border border-emerald-800/40 rounded px-2.5 py-1 inline-flex items-center gap-1.5">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>Catalog test dispatched to Telegram</span>
                  </div>
                ) : (
                  <div className="text-xs text-amber-400 bg-amber-950/30 border border-amber-800/40 rounded px-2.5 py-1 inline-flex items-center gap-1.5">
                    <AlertCircle className="w-3 h-3" />
                    <span>Telegram alert notice: {telegramTestResult.error || 'Failed'}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Catalog Subpage Pagination Strip */}
      {inspectionReport && (inspectionReport.has_more_subpages || (inspectionReport.total_subpages_discovered || 0) > videos.length) && (
        <div className="bg-slate-900 border border-cyan-500/40 rounded-xl p-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-white">Subpage Catalog Pagination</span>
                <span className="font-mono text-xs tabular-nums text-cyan-300">
                  [{videos.length} videos extracted · {inspectionReport.total_subpages_discovered || inspectionReport.subpages_discovered} total subpages found]
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {inspectionReport.remaining_subpages !== undefined && inspectionReport.remaining_subpages > 0
                  ? `${inspectionReport.remaining_subpages} more subpages ready beyond video #${videos.length}. Click below to parse videos 101, 102 and beyond.`
                  : 'All initial subpages scanned. You can load next batch or run unlimited deep crawl.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {onLoadNextBatch && (
              <button
                onClick={onLoadNextBatch}
                disabled={isScraping}
                className="px-3.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-xs font-semibold shadow-sm transition-all inline-flex items-center gap-1.5 whitespace-nowrap active:scale-95"
                title="Extract next 100 videos from remaining website subpages"
              >
                {isScraping ? (
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
                <span>Load Next 100 Videos</span>
              </button>
            )}

            {onCrawlAllSubpages && (
              <button
                onClick={onCrawlAllSubpages}
                disabled={isScraping}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700 text-xs font-medium transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                title="Crawl all remaining subpages nonstop with zero limits"
              >
                <span>Crawl All Subpages Unlimited</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Detected Video List Section */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        {/* Table/List Toolbar */}
        <div className="p-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-950/40">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-white">Discovered Video Streams</h3>
            <span className="font-mono text-xs tabular-nums text-slate-400">
              ({filteredVideos.length} available)
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Search filter */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Filter videos..."
                className="bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500 w-36 sm:w-44"
              />
            </div>

            {/* Bulk actions */}
            {filteredVideos.length > 0 && (
              <>
                <button
                  onClick={toggleSelectAll}
                  className="px-3 py-1.5 rounded-lg border border-slate-800 text-xs text-slate-300 hover:bg-slate-800 transition-colors whitespace-nowrap"
                >
                  {selectedVideoIds.size === filteredVideos.length
                    ? 'Deselect All'
                    : 'Select All'}
                </button>

                <button
                  onClick={handleBulkDownloadClick}
                  disabled={selectedVideoIds.size === 0}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download Selected ({selectedVideoIds.size})</span>
                </button>

                <button
                  onClick={handleDownloadAllClick}
                  className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download All Nonstop ({filteredVideos.length})</span>
                </button>

                {onClearResults && (
                  <button
                    onClick={onClearResults}
                    className="px-2.5 py-1.5 rounded-lg border border-slate-800 hover:border-rose-900/40 text-xs text-slate-400 hover:text-rose-400 transition-colors whitespace-nowrap"
                    title="Clear previous results from console"
                  >
                    Clear Results
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Video Items */}
        {filteredVideos.length === 0 ? (
          <div className="py-16 px-6 text-center">
            <div className="w-12 h-12 rounded-xl bg-slate-800/80 border border-slate-700/60 flex items-center justify-center mx-auto text-slate-500 mb-3">
              <Globe className="w-6 h-6 text-cyan-400" />
            </div>
            <h4 className="text-sm font-medium text-slate-300">No Discovered Videos Yet</h4>
            <p className="text-xs text-slate-500 max-w-md mx-auto mt-1">
              Enter any website link above and click <strong>Test Website</strong> or{' '}
              <strong>Crawl Website Videos</strong>. The engine will scan the entire website catalog and extract all video streams.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800/60">
            {filteredVideos.map((video) => {
              const isSelected = selectedVideoIds.has(video.id);
              const selectedFormat =
                formatSelections[video.id] ||
                video.formats_available[0]?.format_id ||
                'best';

              const durationFormatted = video.duration
                ? `${Math.floor(video.duration / 60)}:${(video.duration % 60)
                    .toString()
                    .padStart(2, '0')}`
                : 'Stream';

              return (
                <div
                  key={video.id}
                  className={`p-4 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4 ${
                    isSelected ? 'bg-cyan-950/20' : 'hover:bg-slate-800/40'
                  }`}
                >
                  {/* Left: Checkbox + Thumbnail + Meta */}
                  <div className="flex items-start gap-3.5 min-w-0 flex-1">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(video.id)}
                      className="mt-1 w-4 h-4 rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-cyan-500 shrink-0 cursor-pointer"
                    />

                    {/* Thumbnail preview */}
                    <div
                      onClick={() => onPreviewVideo(video.media_url, video.title, true)}
                      className="relative w-28 h-18 rounded-lg bg-slate-950 border border-slate-800 overflow-hidden shrink-0 cursor-pointer group"
                    >
                      {video.thumbnail ? (
                        <img
                          src={video.thumbnail}
                          alt={video.title}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-slate-950 text-slate-600">
                          <Play className="w-5 h-5 group-hover:text-cyan-400 transition-colors" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                        <Play className="w-5 h-5 text-white" />
                      </div>
                      <div className="absolute bottom-1 right-1 px-1 py-0.5 bg-black/80 rounded text-[9px] font-mono text-slate-300 tabular-nums">
                        {durationFormatted}
                      </div>
                    </div>

                    {/* Info */}
                    <div className="min-w-0 space-y-1">
                      <h4
                        className="text-xs sm:text-sm font-semibold text-white truncate max-w-xl cursor-pointer hover:text-cyan-300"
                        onClick={() => onPreviewVideo(video.media_url, video.title, true)}
                        title={video.title}
                      >
                        {video.title}
                      </h4>

                      {/* Clean unboxed metadata with separators */}
                      <div className="flex items-center gap-2 text-xs text-slate-400 flex-wrap">
                        <span className="font-medium text-slate-300">{video.protocol}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">{video.resolution}</span>
                        <span aria-hidden="true">·</span>
                        <span>{video.format}</span>
                        {video.uploader && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-slate-400">{video.uploader}</span>
                          </>
                        )}
                      </div>

                      {/* URL preview */}
                      <p className="text-[11px] font-mono text-slate-500 truncate max-w-lg">
                        {video.media_url}
                      </p>
                    </div>
                  </div>

                  {/* Right: Format selector + Actions */}
                  <div className="flex items-center gap-2 shrink-0 self-end md:self-center flex-wrap">
                    {/* Format Selector Dropdown */}
                    {video.formats_available && video.formats_available.length > 1 && (
                      <div className="relative">
                        <select
                          value={selectedFormat}
                          onChange={(e) =>
                            setFormatSelections({
                              ...formatSelections,
                              [video.id]: e.target.value
                            })
                          }
                          className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:ring-1 focus:ring-cyan-500 appearance-none pr-7 cursor-pointer"
                        >
                          {video.formats_available.map((fmt) => (
                            <option key={fmt.format_id} value={fmt.format_id}>
                              {fmt.resolution} {fmt.filesize_mb ? `(~${fmt.filesize_mb} MB)` : ''}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="w-3 h-3 text-slate-500 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      </div>
                    )}

                    {/* Copy Direct URL */}
                    <button
                      onClick={() => handleCopy(video.id, video.media_url)}
                      title="Copy stream link"
                      className="p-2 rounded-lg border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                    >
                      {copiedId === video.id ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>

                    {/* Preview Stream */}
                    <button
                      onClick={() => onPreviewVideo(video.media_url, video.title, true)}
                      title="Preview stream"
                      className="px-2.5 py-1.5 rounded-lg border border-slate-800 text-xs text-slate-300 hover:bg-slate-800 transition-colors inline-flex items-center gap-1"
                    >
                      <Play className="w-3 h-3 text-cyan-400" />
                      <span>Preview</span>
                    </button>

                    {/* Download MP4 Button */}
                    <button
                      onClick={() => onDownloadVideo(video, selectedFormat)}
                      className="px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white text-xs font-medium shadow-sm transition-all inline-flex items-center gap-1.5 active:scale-95"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download MP4</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Video List Footer Pagination Controls */}
        {videos.length > 0 && inspectionReport && (inspectionReport.has_more_subpages || (inspectionReport.total_subpages_discovered || 0) > videos.length) && (
          <div className="p-4 bg-slate-950/70 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-xs text-slate-400 font-mono tabular-nums">
              Showing 1–{videos.length} of {inspectionReport.total_subpages_discovered || inspectionReport.subpages_discovered} discovered subpages
              {inspectionReport.remaining_subpages !== undefined && inspectionReport.remaining_subpages > 0 && (
                <span className="text-cyan-400 ml-2">({inspectionReport.remaining_subpages} subpages remaining)</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {onLoadNextBatch && (
                <button
                  onClick={onLoadNextBatch}
                  disabled={isScraping}
                  className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-xs font-semibold shadow-md transition-all inline-flex items-center gap-2 active:scale-95"
                >
                  {isScraping ? (
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                  <span>Load Next 100 Videos</span>
                </button>
              )}

              {onCrawlAllSubpages && (
                <button
                  onClick={onCrawlAllSubpages}
                  disabled={isScraping}
                  className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700 text-xs font-medium transition-colors"
                >
                  <span>Crawl All Remaining Unlimited</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
