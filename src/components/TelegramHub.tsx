import React, { useState } from 'react';
import {
  Send,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Eye,
  EyeOff,
  Save,
  Check
} from 'lucide-react';
import { Settings } from '../types';

interface TelegramHubProps {
  settings: Settings;
  onSaveSettings: (settings: Partial<Settings>) => Promise<void>;
  onTestTelegram: (token: string, chatId: string) => Promise<any>;
}

export const TelegramHub: React.FC<TelegramHubProps> = ({
  settings,
  onSaveSettings,
  onTestTelegram,
}) => {
  const [token, setToken] = useState(settings.telegram_bot_token || '');
  const [chatId, setChatId] = useState(settings.telegram_chat_id || '');
  const [apiId, setApiId] = useState(settings.telegram_api_id || '');
  const [apiHash, setApiHash] = useState(settings.telegram_api_hash || '');
  const [threadId, setThreadId] = useState(settings.telegram_thread_id || '');
  const [autoUpload, setAutoUpload] = useState(settings.auto_upload_telegram || false);
  const [showToken, setShowToken] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testResult, setTestResult] = useState<any | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveSuccess(false);
    try {
      await onSaveSettings({
        telegram_bot_token: token,
        telegram_chat_id: chatId,
        telegram_api_id: apiId,
        telegram_api_hash: apiHash,
        telegram_thread_id: threadId,
        auto_upload_telegram: autoUpload,
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await onTestTelegram(token, chatId);
      setTestResult(res);
    } catch (err: any) {
      setTestResult({ success: false, error: err.message });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="vortex-view vortex-view-telegram space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-slate-800">
        <div>
          <h1 className="text-base font-semibold text-white">Telegram Bot & Channel Hub</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Configure automated alerts, inspection test reports, and queue-based video uploads.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Configuration Form */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm space-y-5">
          <form onSubmit={handleSave} className="space-y-4">
            {/* Bot Token */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Telegram Bot Token
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500 pr-10"
                />
              </div>
              <p className="text-[11px] text-slate-500 mt-1">
                Obtained from Telegram&apos;s official <code>@BotFather</code>.
              </p>
            </div>

            {/* Chat ID / Channel ID */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Channel ID or Target Chat ID
              </label>
              <input
                type="text"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="@my_channel_username or -100123456789"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                For public channels, enter <code>@channel_username</code>. For private channels, use the numeric ID (e.g. <code>-100...</code>).
              </p>
            </div>

            {/* Optional Telegram Client API Credentials */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Telegram API ID (Optional)
                </label>
                <input
                  type="text"
                  value={apiId}
                  onChange={(e) => setApiId(e.target.value)}
                  placeholder="e.g. 1234567"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Telegram API Hash (Optional)
                </label>
                <input
                  type="password"
                  value={apiHash}
                  onChange={(e) => setApiHash(e.target.value)}
                  placeholder="e.g. 0123456789abcdef..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Topic / Thread ID (Optional)
              </label>
              <input
                type="text"
                value={threadId}
                onChange={(e) => setThreadId(e.target.value)}
                placeholder="Optional topic thread ID for supergroups"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>

            {/* Auto Upload Toggle */}
            <div className="pt-2">
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoUpload}
                  onChange={(e) => setAutoUpload(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-700 bg-slate-950 text-cyan-500 focus:ring-cyan-500"
                />
                <div className="text-xs">
                  <span className="font-semibold text-slate-200 block">
                    Automatically Upload Completed Downloads Nonstop
                  </span>
                  <span className="text-slate-500 text-[11px] block mt-0.5">
                    When enabled, each finished MP4 video will be automatically forwarded to your channel during batch and nonstop downloads.
                  </span>
                </div>
              </label>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-3 pt-3 border-t border-slate-800/80">
              <button
                type="submit"
                disabled={isSaving}
                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold shadow-sm transition-colors inline-flex items-center gap-1.5 active:scale-95 disabled:opacity-50"
              >
                {saveSuccess ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>Saved!</span>
                  </>
                ) : (
                  <>
                    <Save className="w-3.5 h-3.5" />
                    <span>Save Configuration</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleTest}
                disabled={isTesting || !token || !chatId}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700/80 text-slate-200 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isTesting ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-slate-300 border-t-transparent rounded-full animate-spin" />
                    <span>Verifying...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5 text-blue-400" />
                    <span>Verify & Send Test Message</span>
                  </>
                )}
              </button>
            </div>
          </form>

          {/* Test Result Callout */}
          {testResult && (
            <div
              className={`p-4 rounded-xl border text-xs space-y-1.5 ${
                testResult.success
                  ? 'bg-emerald-950/20 border-emerald-800/50 text-emerald-300'
                  : 'bg-rose-950/20 border-rose-800/50 text-rose-300'
              }`}
            >
              <div className="flex items-center gap-2 font-semibold">
                {testResult.success ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0" />
                )}
                <span>
                  {testResult.success ? 'Telegram Verification Successful' : 'Verification Failed'}
                </span>
              </div>
              <p className="text-slate-300 text-xs">
                {testResult.message || testResult.error}
              </p>
              {testResult.bot_name && (
                <div className="text-[11px] text-slate-400 pt-1 font-mono">
                  Bot Name: {testResult.bot_name} (@{testResult.bot_username}) · Target: {testResult.chat_id}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: Setup Guide */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex items-center gap-2 text-white text-sm font-semibold">
            <HelpCircle className="w-4 h-4 text-cyan-400" />
            <span>Setup Instructions</span>
          </div>

          <div className="space-y-3 text-xs text-slate-400">
            <div className="space-y-1">
              <strong className="text-slate-200 block">1. Create Telegram Bot:</strong>
              <p>
                Open Telegram, search for <code>@BotFather</code>, send <code>/newbot</code>, and follow prompts to obtain your Bot API Token.
              </p>
            </div>

            <div className="space-y-1">
              <strong className="text-slate-200 block">2. Add Bot to Channel:</strong>
              <p>
                Add your newly created bot to your Telegram channel as an <strong>Administrator</strong> with permission to <em>Post Messages</em>.
              </p>
            </div>

            <div className="space-y-1">
              <strong className="text-slate-200 block">3. Large File Support (&gt; 50 MB up to 2 GB):</strong>
              <p className="text-slate-400">
                • <strong>MTProto 2GB Upload:</strong> Enter your Telegram API ID & Hash from <code>my.telegram.org</code> to upload files up to <strong>2,000 MB (2 GB)</strong> as single videos.
              </p>
              <p className="text-slate-400 pt-1">
                • <strong>Automated Multi-Part Splitting:</strong> If using Bot Token alone, large videos (e.g. 295 MB) are automatically split into seamless &lt;45MB parts via FFmpeg and sent sequentially to your channel.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
