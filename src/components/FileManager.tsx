import React, { useState } from 'react';
import {
  Film,
  Play,
  Download,
  Send,
  Trash2,
  FileText,
  RefreshCw,
  X,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { DownloadedFile } from '../types';

interface FileManagerProps {
  files: DownloadedFile[];
  onRefresh: () => void;
  onPreview: (filename: string, title: string) => void;
  onDelete: (filename: string) => void;
  onUploadTelegram: (filename: string) => Promise<any>;
}

export const FileManager: React.FC<FileManagerProps> = ({
  files,
  onRefresh,
  onPreview,
  onDelete,
  onUploadTelegram,
}) => {
  const [uploadingFile, setUploadingFile] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<{ filename: string; success: boolean; message: string } | null>(null);
  const [selectedReport, setSelectedReport] = useState<any | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);

  const handleTelegramUploadClick = async (filename: string) => {
    setUploadingFile(filename);
    setUploadResult(null);
    try {
      const res = await onUploadTelegram(filename);
      if (res.success) {
        const detailMsg = res.message || (res.method === 'telethon_mtproto'
          ? 'Large video uploaded via Telegram MTProto (up to 2GB)!'
          : res.method === 'split_multi_part'
          ? `Uploaded in ${res.uploaded_parts || res.total_parts} seamless stream parts!`
          : 'Video uploaded to Telegram successfully!');

        setUploadResult({
          filename,
          success: true,
          message: detailMsg
        });
      } else {
        setUploadResult({
          filename,
          success: false,
          message: res.error || 'Telegram upload failed.'
        });
      }
    } catch (err: any) {
      setUploadResult({
        filename,
        success: false,
        message: err.message
      });
    } finally {
      setUploadingFile(null);
    }
  };

  const handleViewReport = async (filename: string) => {
    setLoadingReport(true);
    try {
      const repRes = await fetch('/api/reports');
      const repData = await repRes.json();
      if (repData.success && repData.reports) {
        const found = repData.reports.find(
          (r: any) =>
            r.output_filename === filename ||
            r.output_file?.includes(filename)
        );
        setSelectedReport(found || { notice: 'Report for this file', output_filename: filename });
      }
    } catch {
      setSelectedReport({ output_filename: filename });
    } finally {
      setLoadingReport(false);
    }
  };

  const executeDelete = (filename: string) => {
    onDelete(filename);
    setConfirmDeleteFile(null);
    setDeleteNotice(`Deleted: ${filename}`);
    setTimeout(() => {
      setDeleteNotice(null);
    }, 4000);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-slate-800">
        <div>
          <h2 className="text-base font-semibold text-white">Downloaded MP4 Files</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Local storage folder. In-browser player, disk downloads, and high-capacity Telegram upload.
          </p>
        </div>

        <button
          onClick={onRefresh}
          className="px-3 py-1.5 rounded-lg border border-slate-800 text-xs text-slate-300 hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 self-start sm:self-center"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh</span>
        </button>
      </div>

      {/* Delete Notice Banner */}
      {deleteNotice && (
        <div className="p-3 rounded-xl bg-slate-900 border border-slate-700/80 text-xs text-slate-300 flex items-center justify-between animate-in fade-in">
          <div className="flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{deleteNotice}</span>
          </div>
          <button
            onClick={() => setDeleteNotice(null)}
            className="p-1 hover:bg-white/10 rounded text-slate-400"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Upload Feedback Banner */}
      {uploadResult && (
        <div
          className={`p-3.5 rounded-xl border flex items-center justify-between text-xs ${
            uploadResult.success
              ? 'bg-emerald-950/20 border-emerald-800/40 text-emerald-300'
              : 'bg-rose-950/20 border-rose-800/40 text-rose-300'
          }`}
        >
          <div className="flex items-center gap-2">
            {uploadResult.success ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
            )}
            <span>
              <strong>{uploadResult.filename}:</strong> {uploadResult.message}
            </span>
          </div>
          <button
            onClick={() => setUploadResult(null)}
            className="p-1 hover:bg-white/10 rounded"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* File List */}
      {files.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl py-16 px-6 text-center shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-slate-800/80 border border-slate-700/60 flex items-center justify-center mx-auto text-slate-500 mb-3">
            <Film className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-medium text-slate-300">No Downloaded Files in Output Folder</h4>
          <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1">
            Downloaded MP4s and generated conversion reports will appear here automatically.
          </p>
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
          <div className="divide-y divide-slate-800/60">
            {files.map((file) => {
              const isUploading = uploadingFile === file.filename;
              const isConfirmingDelete = confirmDeleteFile === file.filename;
              const dateStr = new Date(file.modified_at).toLocaleString();

              return (
                <div
                  key={file.filename}
                  className="p-4 hover:bg-slate-800/30 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <Film className="w-4 h-4 text-cyan-400 shrink-0" />
                      <h4 className="text-xs sm:text-sm font-semibold text-white truncate max-w-xl">
                        {file.filename}
                      </h4>
                    </div>

                    {/* Clean unboxed metadata with separators */}
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <span className="font-mono tabular-nums text-slate-300">
                        {file.size_mb} MB
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>Format: MP4</span>
                      <span aria-hidden="true">·</span>
                      <span className="text-slate-500">{dateStr}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0 self-end md:self-center flex-wrap">
                    {/* In-browser Play */}
                    <button
                      onClick={() => onPreview(file.filename, file.filename)}
                      className="px-2.5 py-1.5 rounded-lg bg-cyan-600/20 text-cyan-300 hover:bg-cyan-600/30 border border-cyan-500/30 text-xs inline-flex items-center gap-1.5 transition-colors"
                      title="Play video in browser"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>Play</span>
                    </button>

                    {/* Direct Save */}
                    <a
                      href={`/api/downloads/file/${encodeURIComponent(file.filename)}`}
                      download
                      className="px-2.5 py-1.5 rounded-lg border border-slate-800 hover:bg-slate-800 text-slate-300 text-xs inline-flex items-center gap-1.5 transition-colors"
                      title="Download to computer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Save</span>
                    </a>

                    {/* View JSON Report */}
                    <button
                      onClick={() => handleViewReport(file.filename)}
                      className="px-2.5 py-1.5 rounded-lg border border-slate-800 hover:bg-slate-800 text-slate-300 text-xs inline-flex items-center gap-1.5 transition-colors"
                      title="View extraction report"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      <span>Report</span>
                    </button>

                    {/* Dispatch to Telegram */}
                    <button
                      onClick={() => handleTelegramUploadClick(file.filename)}
                      disabled={isUploading}
                      className="px-2.5 py-1.5 rounded-lg border border-slate-800 hover:bg-slate-800 text-slate-300 text-xs inline-flex items-center gap-1.5 disabled:opacity-40 transition-colors"
                      title="Upload to Telegram channel (supports > 50MB)"
                    >
                      {isUploading ? (
                        <div className="w-3.5 h-3.5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5 text-blue-400" />
                      )}
                      <span>Telegram</span>
                    </button>

                    {/* Delete with inline 2-step confirmation (no blocked window.confirm) */}
                    {isConfirmingDelete ? (
                      <div className="flex items-center gap-1 bg-rose-950/70 border border-rose-600/60 rounded-lg p-1 animate-in fade-in duration-150">
                        <span className="text-[11px] text-rose-300 font-medium px-1">Delete file?</span>
                        <button
                          onClick={() => executeDelete(file.filename)}
                          className="px-2 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded text-[11px] font-semibold transition-colors"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setConfirmDeleteFile(null)}
                          className="p-1 text-slate-400 hover:text-white rounded"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteFile(file.filename)}
                        className="p-1.5 rounded-lg border border-slate-800 hover:bg-rose-950/40 hover:border-rose-900/50 text-slate-400 hover:text-rose-400 transition-colors"
                        title="Delete video file"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* JSON Report Modal */}
      {selectedReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-950">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-cyan-400" />
                <span className="text-sm font-semibold text-white">Extraction JSON Report</span>
              </div>
              <button
                onClick={() => setSelectedReport(null)}
                className="p-1 text-slate-400 hover:text-white rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 max-h-[70vh] overflow-y-auto">
              <pre className="font-mono text-xs text-slate-300 bg-slate-950 p-4 rounded-lg border border-slate-800 overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(selectedReport, null, 2)}
              </pre>
            </div>

            <div className="px-5 py-3 border-t border-slate-800 bg-slate-950 flex justify-end">
              <button
                onClick={() => setSelectedReport(null)}
                className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded text-xs transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
