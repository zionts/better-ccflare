import type { UsageWindowSnapshot } from "@better-ccflare/types";

/**
 * Pace-aware ranking — our own burn-rate model, deliberately NOT built on the
 * `usage-throttling.ts` hard-filter (which removes accounts from the pool and
 * returns 529 when it empties the pool — the "lag out" failure mode). Here pace
 * is expressed purely as a *ranking penalty*: it only ever reorders accounts,
 * never removes them, so the pool can never be starved by pace logic. The
 * caller (SessionAffinityStrategy) always returns the full ranked list and the
 * proxy serves the first available account, so the last usable account is
 * always served.
 *
 * The idea: an account should be spread evenly across its usage window. If it
 * is burning *faster* than linear pace, deprioritize it (let fresher accounts
 * take new sessions) — but only once it is above a floor, and only as a soft
 * nudge until it reaches a hard ceiling, at which point it becomes last-resort.
 */

/**
 * Fixed durations for the usage windows we model. Anthropic Max windows are
 * fixed-length, so window start = resetAtMs − duration. Windows not listed here
 * (e.g. provider-specific monthly windows with variable length) are ignored by
 * pace ranking — they contribute no penalty rather than a wrong one.
 */
const WINDOW_DURATION_MS: Readonly<Record<string, number>> = {
	five_hour: 5 * 60 * 60 * 1000,
	seven_day: 7 * 24 * 60 * 60 * 1000,
	seven_day_opus: 7 * 24 * 60 * 60 * 1000,
	seven_day_sonnet: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Penalty floor applied to an account at/above the hard ceiling. Base ranking
 * scores are utilization (0–100) plus a recency penalty (≤100), so a ceilinged
 * account scoring ≥ this value always sorts AFTER every non-ceilinged account —
 * making it last-resort — while still remaining in the ranked list (never
 * removed). The window's own utilization is added on top so two ceilinged
 * accounts still order by how full they are.
 */
export const CEILING_PENALTY = 1000;

export interface PaceOptions {
	/** When false, pacePenalty is always 0 and isAtCeiling always false. */
	enabled: boolean;
	/** Below this utilization (0–100) an account is never pace-penalized. */
	floorPct: number;
	/** At/above this utilization (0–100) an account becomes last-resort. */
	ceilingPct: number;
}

/**
 * Compute the pace penalty (≥ 0) to add to an account's least-used score.
 *
 *   - 0 when disabled, when no usage data, when every window is at/under its
 *     linear pace, or when utilization is below the floor.
 *   - A soft penalty equal to (utilization − expectedPace) for windows that are
 *     above the floor and ahead of pace — proportional to how far ahead.
 *   - ≥ CEILING_PENALTY for any window at/above the ceiling (last-resort).
 *
 * The most-constrained window dominates (we take the max penalty across
 * windows), mirroring how getAccountUtilization reports the tightest window.
 */
export function pacePenalty(
	windows: readonly UsageWindowSnapshot[],
	now: number,
	opts: PaceOptions,
): number {
	if (!opts.enabled) return 0;

	let penalty = 0;
	for (const w of windows) {
		const duration = WINDOW_DURATION_MS[w.window];
		if (duration === undefined) continue;
		if (!Number.isFinite(w.utilization) || !Number.isFinite(w.resetAtMs)) {
			continue;
		}

		// Hard ceiling: at/above the ceiling, an account is last-resort
		// regardless of pace. Add utilization so fuller accounts sort later.
		if (w.utilization >= opts.ceilingPct) {
			penalty = Math.max(penalty, CEILING_PENALTY + w.utilization);
			continue;
		}

		// Floor: below the floor we never apply pace pressure. This is what
		// prevents the early-window over-throttle that the old hard-filter hit —
		// just after a window resets, expectedPace ≈ 0, so without a floor any
		// accumulated usage would look "ahead of pace".
		if (w.utilization <= opts.floorPct) continue;

		const startMs = w.resetAtMs - duration;
		const elapsed = now - startMs;
		// Outside the window (clock skew, stale reset) → no usable pace signal.
		if (elapsed <= 0 || elapsed >= duration) continue;

		const expectedPct = (elapsed / duration) * 100;
		if (w.utilization <= expectedPct) continue; // on or under pace

		penalty = Math.max(penalty, w.utilization - expectedPct);
	}

	return penalty;
}

/**
 * Whether any modeled window is at/above the hard ceiling. Used to decide
 * sticky eviction: a sticky client stays on its account through soft pace
 * pressure (preserving prompt-cache locality) and is only failed over when its
 * account crosses the ceiling.
 */
export function isAtCeiling(
	windows: readonly UsageWindowSnapshot[],
	opts: PaceOptions,
): boolean {
	if (!opts.enabled) return false;
	for (const w of windows) {
		if (WINDOW_DURATION_MS[w.window] === undefined) continue;
		if (Number.isFinite(w.utilization) && w.utilization >= opts.ceilingPct) {
			return true;
		}
	}
	return false;
}
