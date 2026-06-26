import type { Account } from "./account";

export enum StrategyName {
	Session = "session",
	LeastUsed = "least-used",
	SessionAffinity = "session-affinity",
}

/**
 * One usage window for an account, normalized away from any provider-specific
 * shape so the load balancer can reason about burn-rate without depending on
 * the providers package. `window` is the upstream window key (e.g. "five_hour",
 * "seven_day", "seven_day_opus"); `utilization` is 0–100; `resetAtMs` is the
 * epoch-ms instant the window rolls over.
 */
export interface UsageWindowSnapshot {
	window: string;
	utilization: number;
	resetAtMs: number;
}

/**
 * Interface for strategy-specific database operations
 * Allows strategies to interact with the database without direct SQL access
 */
export interface StrategyStore {
	/**
	 * Reset session for an account
	 * Updates session_start and session_request_count
	 */
	resetAccountSession(accountId: string, timestamp: number): void;

	/**
	 * Get all accounts (optional method for strategies that need full account list)
	 */
	getAllAccounts?(): Account[] | Promise<Account[]>;

	/**
	 * Update account request count
	 */
	updateAccountRequestCount?(accountId: string, count: number): void;

	/**
	 * Get account by ID
	 */
	getAccount?(accountId: string): Account | null | Promise<Account | null>;

	/**
	 * Pause an account
	 */
	pauseAccount?(accountId: string): void;

	/**
	 * Resume a paused account
	 */
	resumeAccount?(accountId: string): void;

	/**
	 * Get the representative utilization (0–100) for an account based on its
	 * most-constrained usage window. Returns null when no usage data is available.
	 */
	getAccountUtilization?(accountId: string, provider: string): number | null;

	/**
	 * Get the per-window usage snapshots for an account (5h / 7d / opus etc.),
	 * sourced from the provider usage poll. Returns an empty array when no usage
	 * data is available. Used by pace-aware ranking to compute burn-rate.
	 */
	getAccountUsageWindows?(accountId: string): UsageWindowSnapshot[];
}
