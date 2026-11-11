import React, { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw, ShieldCheck, SquareArrowOutUpRight, StopCircle, LogOut, Search } from 'lucide-react';

type Summary = { server: any; workspaces: any[] };
export const OwnerDashboard: React.FC = () => {
  const [secret, setSecret] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [selected, setSelected] = useState<any>(null);
  const [query, setQuery] = useState('');

  const refresh = useCallback(async () => {
    const response = await fetch('/api/owner/summary');
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Could not load owner dashboard.');
    setSummary({ server: data.server, workspaces: data.workspaces || [] });
    if (selected?.browser_id) {
      const detailResponse = await fetch('/api/owner/workspaces/' + encodeURIComponent(selected.browser_id));
      const detail = await detailResponse.json();
      if (detail.success) setSelected(detail.workspace);
    }
  }, [selected?.browser_id]);

  useEffect(() => {
    if (!authenticated) return;
    void refresh().catch((e) => setError(e.message));
    const timer = window.setInterval(() => { void refresh().catch((e) => setError(e.message)); }, 30000);
    return () => window.clearInterval(timer);
  }, [authenticated, refresh]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/owner/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Owner login failed.');
      setSecret(''); setAuthenticated(true);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const openWorkspace = async (id: string) => {
    const response = await fetch('/api/owner/workspaces/' + encodeURIComponent(id));
    const data = await response.json();
    if (!response.ok || !data.success) { setError(data.error || 'Workspace not found.'); return; }
    setSelected(data.workspace);
  };
  const resumeCrawl = async (browserId: string, taskId: string) => {
    const response = await fetch('/api/owner/workspaces/' + encodeURIComponent(browserId) + '/crawls/' + encodeURIComponent(taskId) + '/resume', { method: 'POST' });
    const data = await response.json();
    if (!response.ok || !data.success) { setError(data.error || 'Could not resume crawl.'); return; }
    setError('Crawl request replay started as ' + data.task_id);
    await refresh(); await openWorkspace(browserId);
  };
  const stopWorkspace = async (id: string) => {
    if (!window.confirm('Stop active engine processes and pause this browser workspace queue?')) return;
    const response = await fetch('/api/owner/workspaces/' + encodeURIComponent(id) + '/stop', { method: 'POST' });
    const data = await response.json();
    if (!response.ok || !data.success) { setError(data.error || 'Could not stop workspace.'); return; }
    setError('Stop signal sent. Active processes stopped: ' + data.stopped);
    await refresh();
    await openWorkspace(id);
  };
  const logout = async () => {
    await fetch('/api/owner/logout', { method: 'POST' });
    setAuthenticated(false); setSummary(null); setSelected(null);
  };
  const workspaces = (summary?.workspaces || []).filter((x) => (x.browser_id + ' ' + (x.name || '')).toLowerCase().includes(query.toLowerCase()));

  if (!authenticated) return (
    <main className="owner-shell">
      <section className="owner-login">
        <div className="owner-mark"><ShieldCheck size={22} /></div>
        <p className="owner-eyebrow">VORTEX / PRIVATE OPERATIONS</p>
        <h1>Owner Control Center</h1>
        <p className="owner-muted">Authenticate with the server-side OWNER_ACCESS_SECRET. This is separate from every browser workspace.</p>
        <form onSubmit={login}>
          <label htmlFor="owner-secret">Owner access secret</label>
          <input id="owner-secret" type="password" autoComplete="current-password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Enter OWNER_ACCESS_SECRET" required />
          <button disabled={busy}>{busy ? 'Authenticating…' : 'Unlock Control Center'}</button>
        </form>
        {error && <p className="owner-error">{error}</p>}
        <a className="owner-back" href="/">← Back to scraper</a>
      </section>
    </main>
  );

  return (
    <main className="owner-shell">
      <header className="owner-top">
        <div><p className="owner-eyebrow">VORTEX / PRIVATE OPERATIONS</p><h1>Owner Control Center</h1><p className="owner-muted">Cross-workspace health, queues, crawls, downloads and Telegram configuration.</p></div>
        <div className="owner-actions"><button onClick={() => void refresh()}><RefreshCw size={15}/> Refresh</button><button onClick={() => void logout()}><LogOut size={15}/> Sign out</button><a href="/">Scraper <SquareArrowOutUpRight size={13}/></a></div>
      </header>
      {error && <p className="owner-notice">{error}</p>}
      <section className="owner-stats">
        <article><span>Browser workspaces</span><strong>{summary?.workspaces.length ?? '—'}</strong></article>
        <article><span>Recently active</span><strong>{summary?.workspaces.filter((x) => x.status === 'recently_active').length ?? '—'}</strong></article>
        <article><span>Running crawls</span><strong>{summary?.workspaces.reduce((n, x) => n + (x.activity.active_crawls?.length || 0), 0) ?? '—'}</strong></article>
        <article><span>Server uptime</span><strong>{summary?.server ? Math.floor(summary.server.uptime_seconds / 3600) + 'h ' + Math.floor(summary.server.uptime_seconds % 3600 / 60) + 'm' : '—'}</strong></article>
      </section>
      <section className="owner-grid">
        <div className="owner-panel">
          <div className="owner-panel-head"><div><h2>Browser workspaces</h2><p className="owner-muted">Stable IDs persist across page reloads and server restarts.</p></div><span>{workspaces.length} total</span></div>
          <label className="owner-search"><Search size={15}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find Browser ID or name"/></label>
          <div className="owner-list">
            {workspaces.map((item) => <button className={'owner-workspace ' + (selected?.browser_id === item.browser_id ? 'selected' : '')} key={item.browser_id} onClick={() => void openWorkspace(item.browser_id)}>
              <div><strong>{item.browser_id}</strong><span>{item.name || 'Unnamed browser'} · {item.status}</span></div>
              <div className="owner-workspace-counts"><span>{item.activity.crawl_count} crawls</span><span>{item.activity.download_jobs} jobs</span></div>
            </button>)}
            {!workspaces.length && <p className="owner-empty">No browser workspaces recorded yet.</p>}
          </div>
        </div>
        <div className="owner-panel">
          {!selected ? <div className="owner-empty owner-detail-empty"><Activity size={25}/><h2>Select a browser</h2><p>Inspect its task history, queue checkpoint, recent errors, storage counts and sanitized Telegram setup.</p></div> : <>
            <div className="owner-panel-head"><div><h2>{selected.browser_id}</h2><p className="owner-muted">{selected.name || 'Unnamed browser'} · {selected.status}</p></div><button className="owner-stop" onClick={() => void stopWorkspace(selected.browser_id)}><StopCircle size={14}/> Stop tasks</button></div>
            <div className="owner-detail">
              <h3>Workspace</h3><dl><dt>Created</dt><dd>{selected.created_at ? new Date(selected.created_at).toLocaleString() : 'Unknown'}</dd><dt>Last seen</dt><dd>{selected.last_seen_at ? new Date(selected.last_seen_at).toLocaleString() : 'Unknown'}</dd><dt>Workspace key</dt><dd>{selected.workspace_id}</dd></dl>
              <h3>Queue checkpoint</h3><pre>{JSON.stringify(selected.activity.queue || { status: 'No checkpoint found' }, null, 2)}</pre>
              <h3>Telegram configuration (secrets masked)</h3><pre>{JSON.stringify(selected.settings, null, 2)}</pre>
              <h3>Recent crawls</h3>
              <div className="owner-crawl-list">{(selected.activity.recent_crawls || []).map((crawl: any) => <div className="owner-crawl-row" key={crawl.task_id}><div><strong>{crawl.task_id}</strong><span>{crawl.status} · {crawl.request?.urls?.join(', ') || 'No saved request'}</span></div>{crawl.status !== 'running' && crawl.request?.urls?.length > 0 && <button onClick={() => void resumeCrawl(selected.browser_id, crawl.task_id)}>Replay request</button>}</div>)}</div>
              <h3>Recent downloads</h3><pre>{JSON.stringify(selected.activity.recent_jobs, null, 2)}</pre>
              <h3>Recent errors</h3><pre>{JSON.stringify(selected.activity.errors, null, 2)}</pre>
              <h3>Recent engine logs</h3><pre>{(selected.activity.recent_logs || []).map((line: any) => '[' + line.timestamp + '] ' + line.level.toUpperCase() + ' ' + line.message).join('\n') || 'No persisted engine logs yet.'}</pre>
              <p className="owner-muted">Files: {selected.activity.downloads} downloads · {selected.activity.reports} reports</p>
            </div>
          </>}
        </div>
      </section>
      <footer className="owner-footer">Owner API status: {summary?.server?.log_bot_configured ? 'log bot configured' : 'log bot missing'} · {summary?.server?.log_chat_configured ? 'log group configured' : 'log group missing'} · {summary?.server?.owner_telegram_configured ? 'owner Telegram ID configured' : 'owner Telegram ID missing'}</footer>
    </main>
  );
};
