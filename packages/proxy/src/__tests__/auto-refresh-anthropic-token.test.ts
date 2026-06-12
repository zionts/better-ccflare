/**
 * Tests for proactive Anthropic OAuth access-token refresh in AutoRefreshScheduler.
 *
 * The scheduler already proactively refreshes qwen and codex OAuth tokens
 * (checkAndRefreshQwenTokens / checkAndRefreshCodexTokens). Anthropic accounts,
 * by contrast, only had their access token refreshed on-demand when traffic
 * arrived — so an account idle longer than the ~8h access-token lifetime would
 * expire and force a manual re-auth. checkAndRefreshAnthropicTokens() closes
 * that gap by refreshing idle Anthropic OAuth tokens nearing expiry.
 *
 * Strategy mirrors auto-refresh-cooldown-guard.test.ts: capture the SQL passed
 * to db.query()/db.run() and stub the provider's refreshToken — no real DB and
 * NO real network/Anthropic calls. getProvider is mocked via mock.module so the
 * stubbed provider is returned for 'anthropic'.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { TOKEN_SAFETY_WINDOW_MS } from "../constants";

// ---------------------------------------------------------------------------
// Module mock — declared before importing the scheduler so bun resolves the
// mocked getProvider when the scheduler module loads.
// ---------------------------------------------------------------------------
type RefreshFn = (
	account: unknown,
	clientId: string,
) => Promise<{
	accessToken: string;
	expiresAt: number;
	refreshToken: string;
}>;

let stubRefreshToken: RefreshFn = async () => ({
	accessToken: "at-new",
	expiresAt: Date.now() + 8 * 60 * 60 * 1000,
	refreshToken: "rt-rotated",
});
const refreshSpy = mock((account: unknown, clientId: string) =>
	stubRefreshToken(account, clientId),
);

// Preserve every real export and only override getProvider so the rest of the
// proxy module tree (which imports usageCache, fetchUsageData, etc. from this
// package) continues to resolve.
const realProviders = await import("@better-ccflare/providers");
mock.module("@better-ccflare/providers", () => ({
	...realProviders,
	getProvider: (name: string) =>
		name === "anthropic"
			? { refreshToken: refreshSpy }
			: realProviders.getProvider(name),
}));

// Import AFTER mock.module so the scheduler picks up the mocked getProvider.
const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type QueryCall = { sql: string; params: unknown[] };
type RunCall = { sql: string; params: unknown[] };

function makeDb(anthropicRows: unknown[] = []) {
	const queryCalls: QueryCall[] = [];
	const runCalls: RunCall[] = [];
	return {
		query: mock(async (sql: string, params: unknown[]) => {
			queryCalls.push({ sql, params });
			if (
				sql.includes("provider = 'anthropic'") &&
				sql.includes("expires_at")
			) {
				return anthropicRows;
			}
			return [];
		}),
		run: mock(async (sql: string, params: unknown[]) => {
			runCalls.push({ sql, params });
		}),
		queryCalls,
		runCalls,
	};
}

function makeProxyContext() {
	return {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map<string, Promise<unknown>>(),
	};
}

function makeScheduler(
	db: ReturnType<typeof makeDb>,
	ctx: ReturnType<typeof makeProxyContext>,
) {
	return new AutoRefreshScheduler(db as never, ctx as never) as InstanceType<
		typeof AutoRefreshScheduler
	> & {
		checkAndRefreshAnthropicTokens(): Promise<void>;
	};
}

function anthropicRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "acct-1",
		name: "max-1",
		provider: "anthropic",
		refresh_token: "rt-original",
		access_token: "at-old",
		expires_at: Date.now() + 5 * 60 * 1000, // expiring within the safety window
		custom_endpoint: null,
		...overrides,
	};
}

beforeEach(() => {
	refreshSpy.mockClear();
	stubRefreshToken = async () => ({
		accessToken: "at-new",
		expiresAt: Date.now() + 8 * 60 * 60 * 1000,
		refreshToken: "rt-rotated",
	});
});

describe("AutoRefreshScheduler — proactive Anthropic token refresh", () => {
	it("selection query filters on provider, refresh_token, auto_refresh_enabled and staleness window", async () => {
		const db = makeDb([]);
		const scheduler = makeScheduler(db, makeProxyContext());

		await scheduler.checkAndRefreshAnthropicTokens();

		const q = db.queryCalls.find(
			(c) =>
				c.sql.includes("provider = 'anthropic'") &&
				c.sql.includes("expires_at"),
		);
		expect(q).toBeDefined();
		expect(q?.sql).toContain("provider = 'anthropic'");
		expect(q?.sql).toContain("refresh_token IS NOT NULL");
		expect(q?.sql).toContain("auto_refresh_enabled = 1");
		// staleness OR: missing token / missing expiry / at-or-near expiry
		expect(q?.sql).toContain("access_token IS NULL");
		expect(q?.sql).toContain("expires_at IS NULL");
		expect(q?.sql).toContain("expires_at <=");
	});

	it("uses the same TOKEN_SAFETY_WINDOW_MS as the on-demand path for the expiry threshold", async () => {
		const db = makeDb([]);
		const scheduler = makeScheduler(db, makeProxyContext());

		const before = Date.now();
		await scheduler.checkAndRefreshAnthropicTokens();
		const after = Date.now();

		const q = db.queryCalls.find(
			(c) =>
				c.sql.includes("provider = 'anthropic'") &&
				c.sql.includes("expires_at"),
		);
		expect(q).toBeDefined();
		// First bind param is the expiry threshold = now + TOKEN_SAFETY_WINDOW_MS
		const threshold = q?.params?.[0] as number;
		expect(threshold).toBeGreaterThanOrEqual(before + TOKEN_SAFETY_WINDOW_MS);
		expect(threshold).toBeLessThanOrEqual(after + TOKEN_SAFETY_WINDOW_MS);
	});

	it("selection query skips paused / rate-limited / cooled accounts like qwen/codex guards", async () => {
		const db = makeDb([]);
		const scheduler = makeScheduler(db, makeProxyContext());

		await scheduler.checkAndRefreshAnthropicTokens();

		const q = db.queryCalls.find(
			(c) =>
				c.sql.includes("provider = 'anthropic'") &&
				c.sql.includes("expires_at"),
		);
		expect(q).toBeDefined();
		// Skip locally-cooled accounts (rate_limited_until guard from PR #200)
		expect(q?.sql).toMatch(
			/rate_limited_until IS NULL OR rate_limited_until <= \?/,
		);
		// Skip paused accounts
		expect(q?.sql).toContain("COALESCE(paused, 0) = 0");
	});

	it("refreshes a stale account and persists tokens + refresh_token_issued_at", async () => {
		const row = anthropicRow();
		const db = makeDb([row]);
		const ctx = makeProxyContext();
		const scheduler = makeScheduler(db, ctx);

		await scheduler.checkAndRefreshAnthropicTokens();

		expect(refreshSpy).toHaveBeenCalledTimes(1);
		const callArgs = refreshSpy.mock.calls[0];
		expect((callArgs[0] as { id: string }).id).toBe("acct-1");
		expect(callArgs[1]).toBe("test-client");

		// Persistence: UPDATE includes access_token, expires_at, refresh_token and
		// refresh_token_issued_at — matching token-manager's updateAccountTokens path.
		const upd = db.runCalls.find((c) =>
			c.sql.includes("refresh_token_issued_at"),
		);
		expect(upd).toBeDefined();
		expect(upd?.sql).toContain("access_token = ?");
		expect(upd?.sql).toContain("expires_at = ?");
		expect(upd?.sql).toContain("refresh_token = ?");
		expect(upd?.params).toContain("at-new");
		expect(upd?.params).toContain("rt-rotated");

		// refreshInFlight is cleaned up after the refresh
		expect(ctx.refreshInFlight.has("acct-1")).toBe(false);
	});

	it("persists the previous refresh token when the endpoint returns none", async () => {
		const row = anthropicRow();
		const db = makeDb([row]);
		const ctx = makeProxyContext();
		const scheduler = makeScheduler(db, ctx);

		// Provider returns an empty refresh token (e.g. no rotation this cycle)
		stubRefreshToken = async () => ({
			accessToken: "at-new",
			expiresAt: Date.now() + 8 * 60 * 60 * 1000,
			refreshToken: "",
		});

		await scheduler.checkAndRefreshAnthropicTokens();

		const upd = db.runCalls.find((c) =>
			c.sql.includes("refresh_token_issued_at"),
		);
		expect(upd).toBeDefined();
		// Falls back to the existing refresh token rather than blanking it
		expect(upd?.params).toContain("rt-original");
	});

	it("skips an account that already has an in-flight refresh (no double-refresh with on-demand path)", async () => {
		const row = anthropicRow();
		const db = makeDb([row]);
		const ctx = makeProxyContext();
		// Pretend the on-demand path already started a refresh for this account
		ctx.refreshInFlight.set("acct-1", Promise.resolve("at-inflight"));
		const scheduler = makeScheduler(db, ctx);

		await scheduler.checkAndRefreshAnthropicTokens();

		// Must NOT call provider.refreshToken — the on-demand refresh owns it
		expect(refreshSpy).toHaveBeenCalledTimes(0);
		// Must NOT persist
		const upd = db.runCalls.find((c) =>
			c.sql.includes("refresh_token_issued_at"),
		);
		expect(upd).toBeUndefined();
	});

	it("a refresh failure is logged but does not throw (tick stays alive)", async () => {
		const row = anthropicRow();
		const db = makeDb([row]);
		const ctx = makeProxyContext();
		const scheduler = makeScheduler(db, ctx);

		stubRefreshToken = async () => {
			throw new Error("boom: refresh endpoint 401");
		};

		await expect(
			scheduler.checkAndRefreshAnthropicTokens(),
		).resolves.toBeUndefined();

		expect(refreshSpy).toHaveBeenCalledTimes(1);
		// No persistence on failure
		const upd = db.runCalls.find((c) =>
			c.sql.includes("refresh_token_issued_at"),
		);
		expect(upd).toBeUndefined();
		// in-flight cleaned up even after failure
		expect(ctx.refreshInFlight.has("acct-1")).toBe(false);
	});

	it("does nothing when no anthropic accounts need refresh", async () => {
		const db = makeDb([]);
		const scheduler = makeScheduler(db, makeProxyContext());

		await scheduler.checkAndRefreshAnthropicTokens();

		expect(refreshSpy).toHaveBeenCalledTimes(0);
		const upd = db.runCalls.find((c) =>
			c.sql.includes("refresh_token_issued_at"),
		);
		expect(upd).toBeUndefined();
	});
});
