import React, { useEffect, useState } from 'react';
import { request } from './api.js';
import { Header, RefreshIcon, UsagePanel, BankedPanel, AutomationSettings, CreditTable, Activity } from './components.jsx';

const defaults = { enabled: true, leadMinutes: 30, pollSeconds: 60 };
const outcomes = {
  reset: 'Reset applied. Your usage limits are refreshed.',
  nothingToReset: 'Codex has nothing eligible to reset yet. The monitor will try again before expiry.',
  noCredit: 'Codex reports that this reset is no longer available.',
  alreadyRedeemed: 'This reset has already been applied.',
};

export default function App() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let active = true;
    let timer;
    async function poll() {
      try {
        const data = await request('status');
        if (active) { setStatus(data); setError(''); }
      } catch (failure) { if (active) setError(`Local service unavailable: ${failure.message}`); }
      if (active) timer = setTimeout(poll, 5000);
    }
    void poll();
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => { active = false; clearTimeout(timer); clearInterval(clock); };
  }, []);

  async function act(path, body, onSuccess) {
    setNotice(''); setError('');
    try {
      const result = await request(path, body);
      setStatus(result);
      setNotice(onSuccess(result));
    } catch (failure) { setError(failure.message); }
  }

  async function refresh() {
    setRefreshing(true);
    try { await act('refresh', {}, () => 'Usage and resets refreshed.'); }
    finally { setRefreshing(false); }
  }
  async function save(settings) {
    setSaving(true);
    try { await act('settings', settings, () => 'Settings saved.'); }
    finally { setSaving(false); }
  }
  async function apply(creditId) {
    setApplying(creditId);
    try { await act('apply', { creditId }, (result) => outcomes[result.outcome] || 'Reset checked.'); }
    finally { setApplying(null); }
  }

  const snapshot = status?.snapshot;
  const busy = refreshing || saving || Boolean(applying);
  return <div className="app-shell"><Header connected={status?.connected && !error} loading={!status || (status.busy && !snapshot)} />
    <main><div className="intro"><div><h1>Make every reset count.</h1><p>Your Codex limits, banked resets, and a little peace of mind.</p></div><button className="button refresh-button" onClick={refresh} disabled={busy || status?.busy}><RefreshIcon className={refreshing ? 'spinning' : ''} />{refreshing ? 'Refreshing…' : 'Refresh'}</button></div>
      {(error || status?.error) && <div className="message error-message" role="alert">{error || status.error}{snapshot && <span> Showing the last successful check; applying resets is paused until a fresh check succeeds.</span>}</div>}
      {notice && <div className="message notice-message" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notification">×</button></div>}
      <div className="overview"><UsagePanel snapshot={snapshot} now={now} /><BankedPanel snapshot={snapshot} now={now} /></div>
      <AutomationSettings settings={status?.settings || defaults} onSave={save} busy={saving || !status} />
      <CreditTable snapshot={snapshot} settings={status?.settings || defaults} attempts={status?.attempts || []} connected={status?.connected && !error && !status?.busy} now={now} applying={applying} onApply={apply} />
      <Activity entries={status?.activity || []} />
    </main><footer>Uses your local Codex CLI login.</footer></div>;
}
