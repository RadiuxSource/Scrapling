import React from 'react';
import {
  Activity,
  Download,
  FolderDown,
  Layers,
  ListChecks,
  Radio,
  Send,
  TerminalSquare,
} from 'lucide-react';

type WorkspaceTab = 'console' | 'queue' | 'files' | 'telegram' | 'logs';

interface HeaderProps {
  activeTab: WorkspaceTab;
  setActiveTab: (tab: WorkspaceTab) => void;
  activeDownloadsCount: number;
  onPrimaryAction: () => void | Promise<any>;
  primaryActionLabel: string;
}

const navigation: { id: WorkspaceTab; label: string; icon: React.ElementType }[] = [
  { id: 'console', label: 'Scraper', icon: Activity },
  { id: 'queue', label: 'Queue', icon: ListChecks },
  { id: 'files', label: 'Library', icon: FolderDown },
  { id: 'telegram', label: 'Telegram', icon: Send },
  { id: 'logs', label: 'Engine logs', icon: TerminalSquare },
];

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  activeDownloadsCount,
  onPrimaryAction,
  primaryActionLabel,
}) => (
  <header className="vortex-header">
    <div className="vortex-header-inner">
      <div className="vortex-brand">
        <div className="vortex-brand-mark" aria-hidden="true">
          <Layers size={19} strokeWidth={1.8} />
        </div>
        <div className="vortex-brand-copy">
          <span className="vortex-brand-name">VORTEX</span>
          <span className="vortex-brand-subtitle">MEDIA WORKSPACE</span>
        </div>
      </div>

      <nav className="vortex-nav" aria-label="Workspace sections">
        {navigation.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={`vortex-nav-item ${activeTab === id ? 'is-active' : ''}`}
            aria-current={activeTab === id ? 'page' : undefined}
          >
            <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>{label}</span>
            {id === 'queue' && activeDownloadsCount > 0 && (
              <span className="vortex-nav-count" aria-label={`${activeDownloadsCount} active downloads`}>
                {activeDownloadsCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="vortex-header-actions">
        <div className="vortex-workspace-label">
          <Radio size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>WORKSPACE</span>
        </div>
        <button type="button" onClick={onPrimaryAction} className="vortex-primary-action">
          <Download size={15} strokeWidth={2} aria-hidden="true" />
          <span>{primaryActionLabel}</span>
        </button>
      </div>
    </div>
  </header>
);
