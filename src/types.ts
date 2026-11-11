export interface FormatOption {
  format_id: string;
  resolution: string;
  ext: string;
  vcodec?: string;
  acodec?: string;
  filesize_mb?: number | null;
  note?: string;
}

export interface ScrapedVideo {
  id: string;
  title: string;
  media_url: string;
  page_url: string;
  thumbnail?: string | null;
  duration?: number | null;
  resolution: string;
  format: string;
  protocol: string;
  formats_available: FormatOption[];
  uploader?: string | null;
  subtitles?: string[];
  selected_format_id?: string;
}

export interface InspectionReport {
  page_url: string;
  success: boolean;
  status_code: number | null;
  page_title: string;
  is_catalog_page?: boolean;
  subpages_discovered?: number;
  total_subpages_discovered?: number;
  subpage_offset?: number;
  subpages_scanned?: number;
  has_more_subpages?: boolean;
  next_offset?: number | null;
  remaining_subpages?: number;
  detected_players: string[];
  streams_found: Array<{ url: string; type: string; poster?: string | null }>;
  videos: ScrapedVideo[];
  error?: string | null;
}

export interface JobStatus {
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

export interface NonstopQueueStatus {
  is_running: boolean;
  total_items: number;
  current_index: number;
  current_title: string;
  completed_count: number;
  failed_count: number;
  pending_count: number;
}

export interface DownloadedFile {
  filename: string;
  file_path: string;
  size_bytes: number;
  size_mb: string;
  created_at: string;
  modified_at: string;
}

export interface EngineLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface Settings {
  telegram_bot_token: string;
  telegram_chat_id: string;
  telegram_api_id?: string;
  telegram_api_hash?: string;
  telegram_credentials_configured?: boolean;
  telegram_thread_id?: string;
  auto_upload_telegram: boolean;
  max_concurrent_downloads: number;
  max_crawl_videos?: number;
  default_resolution: string;
}
