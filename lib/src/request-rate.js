// Shared start-time limiter: concurrency must not multiply the outbound rate.
const queues = new Map();
export function reserveRequestStart(key, intervalMs, signal) {
  const interval = Math.max(0, Number(intervalMs) || 0);
  let queue = queues.get(key);
  if (!queue) queues.set(key, queue = { tail: Promise.resolve(), lastStart: 0, pending: 0, nextAllowed: 0 });
  queue.pending++;
  let granted = false;
  const next = queue.tail.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    // Timers may fire before their nominal deadline. Recheck before granting a slot.
    while (Date.now() < Math.max(queue.nextAllowed,queue.lastStart + interval)) {
      const delay = Math.max(queue.nextAllowed,queue.lastStart + interval) - Date.now();
      await new Promise((resolve, reject) => {
      const abort = () => { clearSignal(); reject(signal.reason); };
      const timer = setTimeout(() => { clearSignal(); resolve(); }, delay);
      const clearSignal = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      });
    }
    signal?.throwIfAborted();
    queue.lastStart = Date.now();
    queue.nextAllowed = queue.lastStart + interval;
    granted = true;
  });
  const settled = next.finally(() => {
    // Queue successors behind the promise exposed to callers, not the inner
    // gate promise. Otherwise they can advance while its finally chain is
    // still delaying delivery of the previous slot under scheduler pressure.
    if (granted) {
      queue.lastStart = Date.now();
      queue.nextAllowed = queue.lastStart + interval;
    }
    queue.pending--;
    // Retain the most recent start until its interval has elapsed.
    const timer = setTimeout(() => {
      if (queue.pending === 0 && queues.get(key) === queue && Date.now() >= queue.nextAllowed) queues.delete(key);
    }, interval + 1);
    timer.unref?.();
  });
  queue.tail = settled;
  return settled;
}
