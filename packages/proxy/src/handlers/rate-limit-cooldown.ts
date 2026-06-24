import {
	computeRateLimitBackoffMs,
	getRateLimitMaxCooldownMs,
	logError,
	RateLimitError,
	resolveCooldownUntil,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account, RateLimitReason } from "@better-ccflare/types";
import type { ProxyContext } from "./proxy-types";

const log = new Logger("RateLimitCooldown");

/**
 * Single entry point for applying a 429-driven cooldown to an account.
 * Computes exponential-backoff cooldown capped by upstream reset (if any), updates
 * in-memory state, and enqueues the DB-side atomic increment.
 *
 * Must be called from every 429 path (response-processor, model_fallback_429,
 * all_models_exhausted_429, mid-stream sniffer) — never reach into rate_limited_until manually.
 *
 * @param account - The account that just received a 429 (mutated in place).
 * @param rateLimitInfo - `resetTime` (if known) is honored as the cooldown target,
 *   bounded below by the exponential backoff and above by the safety ceiling
 *   (CCFLARE_RATE_LIMIT_MAX_COOLDOWN_MS) — see resolveCooldownUntil.
 *   `remaining` is forwarded to the emitted RateLimitError. `reason` overrides the
 *   auto-derived audit reason.
 * @param ctx - The proxy context (provides asyncWriter + dbOps).
 */
export function applyRateLimitCooldown(
	account: Account,
	rateLimitInfo: {
		resetTime?: number;
		remaining?: number;
		reason?: RateLimitReason;
	},
	ctx: ProxyContext,
): void {
	const now = Date.now();
	// Best-effort in-memory computation. The DB write does the authoritative atomic
	// increment; under parallel 429s the second concurrent request may compute one
	// tier short, but the persisted counter still ramps correctly.
	const nextCount = account.consecutive_rate_limits + 1;
	const backoffMs = computeRateLimitBackoffMs(nextCount);
	// When the upstream reset is known, bench until that reset (bounded below by
	// the exponential backoff, above by the safety ceiling) instead of discarding
	// a far-future reset and re-probing every ~5min — see resolveCooldownUntil.
	const cooldownUntil = resolveCooldownUntil({
		now,
		backoffMs,
		maxCooldownMs: getRateLimitMaxCooldownMs(),
		resetTime: rateLimitInfo.resetTime,
	});
	const reason: RateLimitReason =
		rateLimitInfo.reason ??
		(rateLimitInfo.resetTime
			? "upstream_429_with_reset"
			: "upstream_429_no_reset_probe_cooldown");

	// In-memory update so the rest of this request sees consistent state.
	account.rate_limited_until = cooldownUntil;
	account.rate_limited_at = now;
	account.consecutive_rate_limits = nextCount;

	ctx.asyncWriter.enqueue(async () => {
		const persistedCount = await ctx.dbOps.markAccountRateLimited(
			account.id,
			cooldownUntil,
			reason,
		);
		// Reconcile in-memory counter with the authoritative DB value (may differ
		// under concurrent 429s for the same account).
		account.consecutive_rate_limits = persistedCount;
		// Log AFTER the DB write so the reported consecutive= reflects the persisted value.
		log.warn(
			`[ccflare] account=${account.name} cooldown_applied reason=${reason} until=${new Date(cooldownUntil).toISOString()} consecutive=${persistedCount}`,
		);
	});

	const rateLimitError = new RateLimitError(
		account.id,
		cooldownUntil,
		rateLimitInfo.remaining,
	);
	logError(rateLimitError, log);
}
