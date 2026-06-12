import { describe, expect, it, mock } from "bun:test";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { refreshAccessTokenSafe } from "../handlers/token-manager";

/**
 * Regression tests for durable rotated-refresh-token persistence.
 *
 * When an OAuth access token is refreshed the provider may return a NEW
 * refresh_token (rotation). The old refresh_token is consumed/invalid the
 * moment the rotated one is issued, so if the rotated value is lost the
 * account is stranded and needs manual re-auth.
 *
 * Previously the DB write was enqueued fire-and-forget on the async writer,
 * which (a) can be lost on a crash/restart before it flushes and (b) can be
 * silently dropped when the metadata queue is at capacity. These tests assert
 * the rotated refresh_token is persisted (awaited) BEFORE the refreshed access
 * token is returned for use, and that a DB-write failure fails the refresh
 * instead of handing back a token whose rotation was never saved.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-rotate",
		name: "rotate-account",
		// Unknown provider name => getProvider() returns undefined and the code
		// falls back to ctx.provider, which we control in the mock context.
		provider: "test-rotation-provider",
		api_key: null,
		refresh_token: "old-refresh-token",
		access_token: "old-access-token",
		expires_at: Date.now() - 1000, // already expired -> force refresh
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
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

interface MockContextOptions {
	refreshResult: {
		accessToken: string;
		expiresAt: number;
		refreshToken: string;
	};
	// Hook invoked inside the mocked updateAccountTokens, used to observe
	// ordering / inject failures.
	updateAccountTokens: (
		id: string,
		accessToken: string,
		expiresAt: number,
		refreshToken?: string,
	) => Promise<void>;
}

function makeContext(opts: MockContextOptions): ProxyContext {
	return {
		runtime: { port: 8080, clientId: "test-client" } as never,
		refreshInFlight: new Map(),
		// If the durable write ever regresses to fire-and-forget, this mock
		// will record the call but ordering assertions below will fail.
		asyncWriter: { enqueue: mock(() => {}) } as never,
		dbOps: {
			updateAccountTokens: mock(opts.updateAccountTokens),
		} as never,
		provider: {
			name: "test-rotation-provider",
			refreshToken: mock(async () => opts.refreshResult),
		} as never,
	} as ProxyContext;
}

describe("durable rotated refresh-token persistence", () => {
	it("awaits the DB write of the rotated refresh_token before returning the new access token", async () => {
		const events: string[] = [];
		let dbWriteResolved = false;

		const refreshResult = {
			accessToken: "new-access-token",
			expiresAt: Date.now() + 60 * 60 * 1000,
			refreshToken: "ROTATED-refresh-token",
		};

		let capturedRefreshToken: string | undefined;
		const account = makeAccount();

		const ctx = makeContext({
			refreshResult,
			updateAccountTokens: async (_id, _access, _expires, refreshToken) => {
				capturedRefreshToken = refreshToken;
				events.push("db-write:start");
				// Defer resolution to a later microtask/macrotask so that if the
				// caller failed to await us, it would return before we resolve.
				await new Promise((resolve) => setTimeout(resolve, 5));
				dbWriteResolved = true;
				events.push("db-write:resolved");
			},
		});

		const returned = await refreshAccessTokenSafe(account, ctx);
		events.push("refresh:returned");

		// The rotated refresh_token must have been the one written.
		expect(capturedRefreshToken).toBe("ROTATED-refresh-token");

		// The DB write must have fully resolved before the refresh returned.
		expect(dbWriteResolved).toBe(true);
		expect(events).toEqual([
			"db-write:start",
			"db-write:resolved",
			"refresh:returned",
		]);

		// And the returned access token is the freshly refreshed one.
		expect(returned).toBe("new-access-token");

		// The async (fire-and-forget) writer must NOT have been used for the
		// token rotation write.
		expect(
			(ctx.asyncWriter as unknown as { enqueue: ReturnType<typeof mock> })
				.enqueue,
		).not.toHaveBeenCalled();

		// In-memory account reflects the rotation only after a durable write.
		expect(account.access_token).toBe("new-access-token");
		expect(account.refresh_token).toBe("ROTATED-refresh-token");
	});

	it("fails the refresh (and does not return the token) when persisting the rotated refresh_token throws", async () => {
		const account = makeAccount();
		const refreshResult = {
			accessToken: "new-access-token",
			expiresAt: Date.now() + 60 * 60 * 1000,
			refreshToken: "ROTATED-refresh-token",
		};

		const ctx = makeContext({
			refreshResult,
			updateAccountTokens: async () => {
				throw new Error("disk full / DB unavailable");
			},
		});

		await expect(refreshAccessTokenSafe(account, ctx)).rejects.toThrow();
	});
});
