export function watchInterviewPresence(id: string, onDepart: () => void, env = {
  events: window as Pick<Window, 'addEventListener' | 'removeEventListener'>,
  every: (fn: () => void) => window.setInterval(fn, 15000),
  clear: (timer: number) => window.clearInterval(timer),
  beacon: (url: string) => navigator.sendBeacon?.(url) ?? false,
  request: (url: string, options: RequestInit) => fetch(url, options),
}) {
  let departed = false;
  const base = `/api/sessions/${encodeURIComponent(id)}`;
  const depart = () => {
    if (departed) return;
    departed = true;
    onDepart();
    // Browser shutdown delivery is best effort; server heartbeat expiry is the fallback.
    let sent = false;
    try { sent = env.beacon(`${base}/conversation/end`); } catch { /* Fall back to keepalive. */ }
    if (!sent) void env.request(`${base}/conversation/end`, { method: 'POST', keepalive: true }).catch(() => {});
  };
  const heartbeat = () => {
    if (!departed) void env.request(`${base}/heartbeat`, { method: 'POST' }).catch(() => {});
  };
  heartbeat();
  const timer = env.every(heartbeat);
  env.events.addEventListener('pagehide', depart);
  env.events.addEventListener('popstate', depart);
  return { depart, stop: () => {
    env.clear(timer);
    env.events.removeEventListener('pagehide', depart);
    env.events.removeEventListener('popstate', depart);
  } };
}
