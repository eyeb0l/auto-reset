import React, { useEffect, useState } from 'react';
import { dateLabel, duration } from './api.js';

export function RefreshIcon({ className = '' }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.5 9A8.5 8.5 0 0 0 5 5L2 8m0-5v5h5M3.5 15A8.5 8.5 0 0 0 19 19l3-3m0 5v-5h-5" /></svg>;
}

export function Header({ connected, loading }) {
  return <header className="header"><a className="brand" href="/" aria-label="Auto Reset home"><RefreshIcon />Auto Reset</a>
    <span className={`connection ${connected ? 'online' : ''}`}><span className="dot" />{connected ? 'Codex connected' : loading ? 'Connecting to Codex…' : 'Codex unavailable'}</span></header>;
}

export function UsagePanel({ snapshot, now }) {
  return <section className="panel usage" aria-labelledby="usage-title"><h2 id="usage-title">Current usage</h2>
    {snapshot?.windows?.length ? <div className="usage-windows">{snapshot.windows.map((window) => <div className="usage-window" key={window.key}>
      <div className="usage-label"><span>{window.label}</span><span>{Math.round(window.remainingPercent)}% remaining</span></div>
      <div className="progress-track" role="progressbar" aria-label={`${window.label} remaining`} aria-valuenow={Math.round(window.remainingPercent)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`progress-fill ${window.remainingPercent <= 10 ? 'low' : ''}`} style={{ width: `${window.remainingPercent}%` }} />
      </div><p className="caption">{window.resetsAt ? `Resets ${duration(window.resetsAt, now)}` : 'Next reset time not reported'}</p>
    </div>)}</div> : <p className="empty-text">{snapshot ? 'Codex did not report a usage window for this account.' : 'Waiting for your Codex usage…'}</p>}
  </section>;
}

export function BankedPanel({ snapshot, now }) {
  const next = snapshot?.credits.find((credit) => credit.status === 'available' && credit.expiresAt > now);
  return <section className="panel banked" aria-labelledby="banked-title"><h2 id="banked-title">Banked resets</h2>
    <div className="banked-number">{snapshot?.availableCount ?? '—'}</div><div className="banked-label">{snapshot?.availableCount == null ? 'not reported' : 'available'}</div>
    <div className="expiry-summary"><span className="muted">Next expiry</span><span>{next ? dateLabel(next.expiresAt) : snapshot?.availableCount === 0 ? 'No resets waiting' : snapshot?.detailsAvailable ? 'No expiring resets' : 'Waiting for expiry details'}</span></div>
  </section>;
}

export function AutomationSettings({ settings, onSave, busy }) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => { setDraft(settings); }, [settings.enabled, settings.leadMinutes, settings.pollSeconds]);
  const changed = JSON.stringify(settings) !== JSON.stringify(draft);
  const leadOptions = [...new Set([5, 15, 30, 60, 360, 1440, draft.leadMinutes])].sort((a, b) => a - b);
  const intervalOptions = [...new Set([15, 30, 60, 120, 300, draft.pollSeconds])].sort((a, b) => a - b);
  return <form className="panel automation" onSubmit={(event) => { event.preventDefault(); onSave(draft); }}>
    <div className="section-heading"><h2>Automatic resets</h2><label className="toggle-label"><span>{draft.enabled ? 'Enabled' : 'Paused'}</span><input type="checkbox" role="switch" aria-label="Automatic resets" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} disabled={busy} /><span className="toggle" /></label></div>
    <p className="muted automation-description">Apply the oldest reset before it expires.</p>
    <div className="settings-fields"><label>Apply before expiry<select value={draft.leadMinutes} onChange={(event) => setDraft({ ...draft, leadMinutes: Number(event.target.value) })} disabled={busy}>{leadOptions.map((value) => <option value={value} key={value}>{value < 60 ? `${value} minutes` : `${value / 60} hour${value === 60 ? '' : 's'}`}</option>)}</select></label>
      <label>Check interval<select value={draft.pollSeconds} onChange={(event) => setDraft({ ...draft, pollSeconds: Number(event.target.value) })} disabled={busy}>{intervalOptions.map((value) => <option value={value} key={value}>{value} seconds</option>)}</select></label>
      <button type="submit" className="button primary" disabled={!changed || busy}>{busy ? 'Saving…' : 'Save settings'}</button>
    </div>
  </form>;
}

function creditState(credit, settings, now, attempt) {
  if (attempt?.pending) return { label: 'Retry pending', tone: 'warn' };
  if (attempt?.outcome === 'reset' || attempt?.outcome === 'alreadyRedeemed' || credit.status === 'redeemed') return { label: 'Applied', tone: 'green' };
  if (credit.status === 'redeeming') return { label: 'Applying', tone: 'warn' };
  if (credit.expiresAt && credit.expiresAt <= now) return { label: 'Expired', tone: 'gray' };
  if (attempt?.outcome === 'noCredit') return { label: 'Unavailable', tone: 'gray' };
  if (credit.status !== 'available' || credit.resetType !== 'codexRateLimits') return { label: 'Unsupported', tone: 'gray' };
  if (!credit.expiresAt) return { label: 'No expiry', tone: 'gray' };
  if (!settings.enabled) return { label: 'Paused', tone: 'gray' };
  if (attempt?.outcome === 'nothingToReset') return { label: 'Waiting for usage', tone: 'warn' };
  return { label: credit.expiresAt - now <= settings.leadMinutes * 60_000 ? 'Due soon' : 'Scheduled', tone: 'green' };
}

export function CreditTable({ snapshot, settings, attempts, connected, now, applying, onApply }) {
  const credits = snapshot?.credits || [];
  const latest = (id) => attempts.findLast((attempt) => attempt.creditId === id);
  const pending = attempts.find((attempt) => attempt.pending);
  const missingPending = pending && !credits.some((credit) => credit.id === pending.creditId);
  return <section className="panel resets" aria-labelledby="resets-title"><h2 id="resets-title">Available resets</h2>
    {snapshot && !snapshot.detailsAvailable && <p className="detail-note">Codex returned {snapshot.availableCount ?? 'an unknown number of'} resets without expiry details. Automatic application waits for those details.</p>}
    {snapshot?.detailsAvailable && snapshot.availableCount > credits.length && <p className="detail-note">Showing {credits.length} of {snapshot.availableCount} available resets. Codex may limit the detail list.</p>}
    {missingPending && <div className="pending-note"><span>A reset has an uncertain result. Retry the saved attempt to resolve it safely.</span><button className="button small" disabled={!connected || Boolean(applying)} onClick={() => onApply(pending.creditId)}>Retry pending reset</button></div>}
    <div className="table-scroll"><table className="credit-table"><thead><tr><th>Reset</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead><tbody>
      {credits.map((credit, index) => {
        const state = creditState(credit, settings, now, latest(credit.id));
        const canApply = latest(credit.id)?.pending || (credit.status === 'available' && credit.resetType === 'codexRateLimits'
          && (!credit.expiresAt || credit.expiresAt > now) && !['reset', 'alreadyRedeemed', 'noCredit'].includes(latest(credit.id)?.outcome));
        return <tr key={credit.id}><td><span title={credit.description || undefined}>{credit.title}</span></td><td>{credit.expiresAt ? dateLabel(credit.expiresAt) : 'No expiry'}{credit.expiresAt && <span className="caption table-caption">{credit.expiresAt <= now ? 'Expired' : duration(credit.expiresAt, now)}</span>}</td><td><span className={`reset-status ${state.tone}`}><span className="dot" />{state.label}</span></td><td><button className={`button small ${index === 0 ? 'primary' : 'outline-green'}`} onClick={() => onApply(credit.id)} disabled={!connected || Boolean(applying) || !canApply || (pending && pending.creditId !== credit.id)} aria-label={`${latest(credit.id)?.pending ? 'Retry' : 'Apply'} ${credit.title}, ${credit.expiresAt ? dateLabel(credit.expiresAt) : 'no expiry'}`}>{applying === credit.id ? 'Applying…' : latest(credit.id)?.pending ? 'Retry' : 'Apply now'}</button></td></tr>;
      })}
      {!credits.length && <tr><td colSpan="4" className="table-empty">{!snapshot ? 'Waiting for available resets…' : snapshot.availableCount === 0 ? 'All caught up. No banked resets are available right now.' : snapshot.detailsAvailable ? 'No reset details were returned. The monitor will keep checking.' : 'Reset details are not available yet.'}</td></tr>}
    </tbody></table></div>
  </section>;
}

const ACTIVITY_PAGE_SIZE = 12;

export function Activity({ entries, checkedAt, nextCheckAt, busy, now, retention }) {
  const [visibleCount, setVisibleCount] = useState(ACTIVITY_PAGE_SIZE);
  const shown = Math.min(visibleCount, entries.length);
  return <section className="panel activity" aria-labelledby="activity-title"><h2 id="activity-title">Activity</h2>
    <div className="check-status"><span>Last successful check: {checkedAt ? <time dateTime={new Date(checkedAt).toISOString()} title={new Date(checkedAt).toLocaleString()}>{dateLabel(checkedAt)}</time> : 'Waiting for first check'}</span><span>{busy ? 'Checking now…' : nextCheckAt ? `Next check: ${duration(nextCheckAt, now)}` : 'Next check: Waiting for schedule'}</span></div>
    <div className="activity-head"><span>Time</span><span>Action</span></div>
    {entries.length ? <ol className="activity-list" id="activity-entries">{entries.slice(0, shown).map((entry) => <li key={entry.id}><time dateTime={new Date(entry.at).toISOString()}>{dateLabel(entry.at)}</time><span className={entry.level === 'error' ? 'error-text' : entry.level === 'success' ? 'success-text' : ''}>{entry.message}</span></li>)}</ol> : <p className="empty-text">No activity yet. Settings changes, reset actions, and errors will appear here.</p>}
    <div className="activity-footer"><div className="activity-summary"><span>Showing {shown} of {entries.length} entries</span>{retention && <span>History keeps up to {retention.maxEntries.toLocaleString()} entries for {retention.maxAgeDays} days.</span>}</div>
      {entries.length > ACTIVITY_PAGE_SIZE && <div className="activity-actions">{shown > ACTIVITY_PAGE_SIZE && <button className="button small" onClick={() => setVisibleCount(ACTIVITY_PAGE_SIZE)} aria-controls="activity-entries">Show less</button>}{shown < entries.length && <button className="button small" onClick={() => setVisibleCount((count) => Math.min(count + ACTIVITY_PAGE_SIZE, entries.length))} aria-controls="activity-entries">Show more</button>}</div>}
    </div>
  </section>;
}
