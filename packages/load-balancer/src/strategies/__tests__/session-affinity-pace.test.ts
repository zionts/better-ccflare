/**
 * Pace-aware augmentation of SessionAffinityStrategy.
 *
 * The headline test is `regression-lag-out`: it reproduces the exact failure
 * that made the old usage-throttling hard-filter unusable — two accounts, a
 * freshly-reset 5h window, low utilization — and asserts that pace ranking
 * never empties the pool (which is what produced the 529/retry "lag out").
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { SessionAffinityStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	StrategyStore,
	UsageWindowSnapshot,
} from "@better-ccflare/types";

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "a",
		name: "a",
		provider: "anthropic",
		api_key: null,
		refresh_token: "r",
		access_token: "t",
		expires_at: Date.now() + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

class MockStore implements StrategyStore {
	private util = new Map<string, number>();
	private windows = new Map<string, UsageWindowSnapshot[]>();

	resetAccountSession(): void {}
	resumeAccount(): void {}

	getAccountUtilization(accountId: string): number | null {
		return this.util.get(accountId) ?? null;
	}
	getAccountUsageWindows(accountId: string): UsageWindowSnapshot[] {
		return this.windows.get(accountId) ?? [];
	}

	/** Set an account's 5h window utilization + how far it is into the window. */
	setFiveHour(
		accountId: string,
		utilization: number,
		elapsedFraction: number,
	): void {
		this.util.set(accountId, utilization);
		this.windows.set(accountId, [
			{
				window: "five_hour",
				utilization,
				resetAtMs: Date.now() + (1 - elapsedFraction) * FIVE_HOUR_MS,
			},
		]);
	}
}

function metaFor(clientSessionId?: string | null): RequestMeta {
	return {
		id: "req",
		headers: new Headers(),
		timestamp: Date.now(),
		clientSessionId: clientSessionId ?? null,
	} as unknown as RequestMeta;
}

const PACE = { enabled: true, floorPct: 55, ceilingPct: 92 };

describe("SessionAffinityStrategy — pace-aware", () => {
	let store: MockStore;
	let strategy: SessionAffinityStrategy;

	beforeEach(() => {
		store = new MockStore();
		strategy = new SessionAffinityStrategy(FIVE_HOUR_MS, PACE);
		strategy.initialize(store);
	});

	it("regression-lag-out: 2 accounts, fresh 5h window, low util → pool never starved", () => {
		// Both accounts barely into a fresh window with low usage. Under the old
		// pace-as-hard-filter this throttled BOTH (expected pace ≈ 0) → 529 → lag.
		const x = makeAccount({ id: "x" });
		const y = makeAccount({ id: "y" });
		store.setFiveHour("x", 8, 0.01);
		store.setFiveHour("y", 8, 0.01);

		const result = strategy.select([x, y], metaFor("client-1"));

		// Never-starve: a non-empty list containing BOTH accounts is returned.
		expect(result.length).toBe(2);
		expect(new Set(result.map((a) => a.id))).toEqual(new Set(["x", "y"]));
	});

	it("never-starve: the only available account is served even at the ceiling", () => {
		const x = makeAccount({ id: "x" });
		store.setFiveHour("x", 99, 0.99); // above the 92 ceiling

		const result = strategy.select([x], metaFor("client-1"));
		expect(result.map((a) => a.id)).toEqual(["x"]);
	});

	it("evicts a sticky client off its account at the ceiling, then snaps back", () => {
		const x = makeAccount({ id: "x" });
		const y = makeAccount({ id: "y" });
		// x lower util so the new client pins to x; both below floor (no penalty).
		store.setFiveHour("x", 10, 0.5);
		store.setFiveHour("y", 50, 0.5);

		const pinned = strategy.select([x, y], metaFor("c1"))[0].id;
		expect(pinned).toBe("x");

		// x crosses the ceiling, y stays healthy → fail the client over to y.
		store.setFiveHour("x", 99, 0.99);
		expect(strategy.select([x, y], metaFor("c1"))[0].id).toBe("y");

		// x recovers below the ceiling → client snaps back to its sticky account.
		store.setFiveHour("x", 10, 0.05);
		expect(strategy.select([x, y], metaFor("c1"))[0].id).toBe("x");
	});

	it("steers a NEW client away from an account that is ahead of pace", () => {
		const x = makeAccount({ id: "x" });
		const y = makeAccount({ id: "y" });
		// Both above the floor; x is ahead of pace, y is on pace.
		store.setFiveHour("x", 75, 0.4); // expected 40 → +35 penalty
		store.setFiveHour("y", 75, 0.8); // expected 80 → under pace → 0 penalty

		expect(strategy.select([x, y], metaFor("fresh"))[0].id).toBe("y");
	});
});
