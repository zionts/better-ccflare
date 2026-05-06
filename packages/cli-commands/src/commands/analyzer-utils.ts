// Shared utilities for the analyze-* family of CLI subcommands.
// Centralises payload unwrapping, session grouping, and formatting.

import { TIME_CONSTANTS } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";

export const SESSION_GAP_MS = TIME_CONSTANTS.HOUR;

// request_payloads.json is a wrapper:
//   { request: { headers, body }, response, meta }
// where body is base64-encoded JSON of the actual Anthropic Messages API request.
export function unwrapRequestPayload(
	payloadJson: string,
): Record<string, unknown> | null {
	let wrapper: Record<string, unknown>;
	try {
		wrapper = JSON.parse(payloadJson) as Record<string, unknown>;
	} catch {
		return null;
	}
	const req = wrapper.request as { body?: unknown } | undefined;
	const bodyRaw = req?.body;
	if (typeof bodyRaw === "string") {
		let decoded = bodyRaw;
		try {
			decoded = Buffer.from(bodyRaw, "base64").toString("utf8");
			if (!decoded.trimStart().startsWith("{")) decoded = bodyRaw;
		} catch {
			decoded = bodyRaw;
		}
		try {
			return JSON.parse(decoded) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
	if (bodyRaw && typeof bodyRaw === "object") {
		return bodyRaw as Record<string, unknown>;
	}
	return wrapper;
}

// Same wrapper. The response field shape varies but is usually { body: <encoded?>, status, ... }
export function unwrapResponsePayload(
	payloadJson: string,
): Record<string, unknown> | null {
	let wrapper: Record<string, unknown>;
	try {
		wrapper = JSON.parse(payloadJson) as Record<string, unknown>;
	} catch {
		return null;
	}
	const resp = wrapper.response as { body?: unknown } | undefined;
	const bodyRaw = resp?.body;
	if (typeof bodyRaw === "string") {
		let decoded = bodyRaw;
		try {
			decoded = Buffer.from(bodyRaw, "base64").toString("utf8");
			if (
				!decoded.trimStart().startsWith("{") &&
				!decoded.trimStart().startsWith("[")
			)
				decoded = bodyRaw;
		} catch {
			decoded = bodyRaw;
		}
		try {
			return JSON.parse(decoded) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
	if (bodyRaw && typeof bodyRaw === "object") {
		return bodyRaw as Record<string, unknown>;
	}
	return null;
}

// Concatenate all text from system blocks (string or array) for length / cwd extraction.
export function systemText(system: unknown): string {
	if (system == null) return "";
	if (typeof system === "string") return system;
	if (Array.isArray(system)) {
		return system
			.map((b) => {
				if (typeof b === "string") return b;
				if (
					b &&
					typeof b === "object" &&
					"text" in (b as Record<string, unknown>)
				)
					return String((b as { text?: unknown }).text ?? "");
				return JSON.stringify(b);
			})
			.join("\n");
	}
	return "";
}

// Extract Primary working directory from the boilerplate "<env>" block in the system prompt.
// Returns null if not present.
export function extractCwd(text: string): string | null {
	const m = text.match(/Primary working directory:\s*(\S+)/);
	return m ? m[1] : null;
}

// Pretty number for tables.
export function fmtNum(n: number, width = 0): string {
	const s = n.toLocaleString();
	return width > 0 ? s.padStart(width) : s;
}

export function fmtPct(num: number, denom: number, decimals = 1): string {
	if (denom <= 0) return "0.0%";
	return `${((num / denom) * 100).toFixed(decimals)}%`;
}

export function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = s / 60;
	if (m < 60) return `${m.toFixed(1)}m`;
	return `${(m / 60).toFixed(1)}h`;
}

// Anthropic's published list rates (USD per Mtok). Adjust here if rates change.
// Used as a rough cost estimate for reporting only — actual billing is what your plan defines.
export const RATE_USD_PER_MTOK = {
	"claude-opus-4-7": {
		input: 15,
		output: 75,
		cache_read: 1.5,
		cache_creation: 18.75,
	},
	"claude-opus-4-6": {
		input: 15,
		output: 75,
		cache_read: 1.5,
		cache_creation: 18.75,
	},
	"claude-sonnet-4-6": {
		input: 3,
		output: 15,
		cache_read: 0.3,
		cache_creation: 3.75,
	},
	"claude-haiku-4-5-20251001": {
		input: 1,
		output: 5,
		cache_read: 0.1,
		cache_creation: 1.25,
	},
	default: { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 },
} as const;

export function estimateCost(
	model: string | null,
	tokens: {
		input?: number | null;
		output?: number | null;
		cache_read?: number | null;
		cache_creation?: number | null;
	},
): number {
	const rate =
		model && model in RATE_USD_PER_MTOK
			? RATE_USD_PER_MTOK[model as keyof typeof RATE_USD_PER_MTOK]
			: RATE_USD_PER_MTOK.default;
	return (
		((tokens.input ?? 0) * rate.input +
			(tokens.output ?? 0) * rate.output +
			(tokens.cache_read ?? 0) * rate.cache_read +
			(tokens.cache_creation ?? 0) * rate.cache_creation) /
		1_000_000
	);
}

export function fmtUsd(n: number, width = 0): string {
	const s = n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
	return width > 0 ? s.padStart(width) : s;
}

// Get the underlying SQLite handle from dbOps. Centralises the pattern.
export function getSqlite(dbOps: DatabaseOperations) {
	return dbOps.getAdapter().getSQLiteDb();
}

export function defaultCutoff(sinceMs?: number): number {
	const since = sinceMs ?? TIME_CONSTANTS.DAY * 7;
	return Date.now() - since;
}
