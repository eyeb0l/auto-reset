export async function request(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(body === undefined ? 10_000 : 100_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The local service could not complete this request.');
  return result;
}

export function dateLabel(timestamp) {
  if (!timestamp) return 'Not reported';
  const date = new Date(timestamp);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const day = date.toDateString() === today.toDateString() ? 'Today' : date.toDateString() === tomorrow.toDateString()
    ? 'Tomorrow' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
  return `${day}, ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

export function duration(timestamp, now) {
  if (!timestamp) return 'Not reported';
  const difference = timestamp - now;
  if (difference <= 0) return 'Due now';
  const minutes = Math.ceil(difference / 60_000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}${minutes % 60 ? `, ${minutes % 60} minutes` : ''}`;
  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}${hours % 24 ? `, ${hours % 24} hours` : ''}`;
}
