import { useSyncExternalStore } from "react";

/**
 * A single clock shared by every elapsed time in the console.
 *
 * Durations used to move only when a packet arrived, so a five-second refresh
 * made every age jump five seconds at a time. Instead, the clock anchors on the
 * `generatedAt` the orchestrator stamps on each payload and advances on its own
 * once a second, re-anchoring whenever fresher data lands.
 *
 * Anchoring on the server instant also keeps a device with a skewed clock
 * honest: ages are measured against the orchestrator's timeline, never the
 * browser's.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Server instant of the last sync, and the local reading taken at that moment. */
let anchorServerMs = 0;
let anchorLocalMs = 0;
/** Last published value: useSyncExternalStore needs a cached snapshot. */
let publishedMs = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** Monotonic where available, so a system clock change cannot rewind the UI. */
function localNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function projected(): number {
  if (anchorServerMs === 0) return 0;
  return anchorServerMs + (localNow() - anchorLocalMs);
}

function notify(): void {
  for (const listener of listeners) listener();
}

function tick(): void {
  const next = projected();
  // Only whole seconds are ever rendered; skip the rest of the updates.
  if (Math.floor(next / 1_000) === Math.floor(publishedMs / 1_000)) return;
  publishedMs = next;
  notify();
}

/**
 * Re-anchors the clock on a payload's `generatedAt`. Called from the API layer,
 * so the correction is applied before React renders the new data.
 */
export function syncClock(generatedAt: string | null | undefined): void {
  if (!generatedAt) return;
  const serverMs = Date.parse(generatedAt);
  if (Number.isNaN(serverMs)) return;
  // Responses can arrive out of order; never let the clock run backwards.
  if (serverMs < anchorServerMs) return;
  anchorServerMs = serverMs;
  anchorLocalMs = localNow();
  publishedMs = serverMs;
  notify();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (timer === null) timer = setInterval(tick, 1_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getSnapshot = () => publishedMs;
/** Nothing time-based is server-rendered: the data itself is client-fetched. */
const getServerSnapshot = () => 0;

/**
 * Current server instant in milliseconds, advancing once a second.
 * Returns 0 until the first payload has been seen.
 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Test seam: drops the anchor and every subscriber. */
export function resetClock(): void {
  anchorServerMs = 0;
  anchorLocalMs = 0;
  publishedMs = 0;
  listeners.clear();
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test seam: the clock's current reading without subscribing to it. */
export function readClock(): number {
  return publishedMs;
}
