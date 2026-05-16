import type { Signal, Arc } from "../types/index.js";
import { durationToSeconds } from "../processor/retention.js";

/**
 * Checks whether a signal is still visible to the user based on its retention duration.
 * A signal is visible if createdAt + retentionDuration is in the future.
 * Signals without retentionDuration are always visible (retention not yet applied).
 * Signals with infinite retention (P100Y, Infinity) are always visible.
 */
export function isSignalVisible(signal: Signal, now: Date = new Date()): boolean {
  if (!signal.retentionDuration) return true;
  const seconds = durationToSeconds(signal.retentionDuration);
  if (seconds == null) return true; // infinite retention
  const createdAtMs = new Date(signal.createdAt).getTime();
  const retentionMs = seconds * 1000;
  return createdAtMs + retentionMs > now.getTime();
}

/**
 * Checks whether an arc is still visible to the user based on its TTL.
 * An arc is visible if its TTL is in the future or absent.
 */
export function isArcVisible(arc: Arc, now: Date = new Date()): boolean {
  if (!arc.ttl) return true;
  return arc.ttl * 1000 > now.getTime();
}

/**
 * Filters a list of signals to only those visible to the user.
 */
export function filterVisibleSignals(signals: Signal[], now: Date = new Date()): Signal[] {
  return signals.filter((s) => isSignalVisible(s, now));
}

/**
 * Filters a list of arcs to only those visible to the user.
 */
export function filterVisibleArcs(arcs: Arc[], now: Date = new Date()): Arc[] {
  return arcs.filter((a) => isArcVisible(a, now));
}
