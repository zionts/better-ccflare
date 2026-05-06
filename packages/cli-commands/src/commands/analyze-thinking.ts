// B5: output thinking percentage by model / agent.
// Best-effort: parses the response payload to find thinking content_blocks
// vs text content_blocks. SSE-streamed responses may not preserve a clean
// content array; in that case we fall back to detecting a "<thinking>" tag
// or the cache_creation/output token ratio as a heuristic.

import type { DatabaseOperations } from "@better-ccflare/database";
import {
	defaultCutoff,
	fmtNum,
	fmtPct,
	getSqlite,
	unwrapResponsePayload,
} from "./analyzer-utils";

interface Row {
	model: string | null;
	agent_used: string | null;
	output_tokens: number | null;
	payload: string | null;
}

interface Bucket {
	requests: number;
	withThinking: number;
	totalOutput: number;
	estThinkingChars: number;
	estTextChars: number;
}

function bucket(): Bucket {
	return {
		requests: 0,
		withThinking: 0,
		totalOutput: 0,
		estThinkingChars: 0,
		estTextChars: 0,
	};
}

function classify(resp: Record<string, unknown> | null): {
	hasThinking: boolean;
	thinkingChars: number;
	textChars: number;
} {
	if (!resp) return { hasThinking: false, thinkingChars: 0, textChars: 0 };
	const content = resp.content as unknown[] | undefined;
	if (!Array.isArray(content)) {
		// Streaming responses may store events; try a substring scan as fallback.
		const raw = JSON.stringify(resp);
		const has = raw.includes('"type":"thinking"') || raw.includes("<thinking>");
		return { hasThinking: has, thinkingChars: 0, textChars: 0 };
	}
	let thinkingChars = 0;
	let textChars = 0;
	let hasThinking = false;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as { type?: string; text?: unknown; thinking?: unknown };
		const len =
			typeof b.text === "string"
				? b.text.length
				: typeof b.thinking === "string"
					? b.thinking.length
					: 0;
		if (b.type === "thinking") {
			hasThinking = true;
			thinkingChars += len;
		} else if (b.type === "text") {
			textChars += len;
		}
	}
	return { hasThinking, thinkingChars, textChars };
}

interface Options {
	sinceMs?: number;
	groupBy?: "model" | "agent" | "model+agent";
	sample?: number;
}

export async function analyzeThinking(
	dbOps: DatabaseOperations,
	options: Options = {},
): Promise<void> {
	const cutoff = defaultCutoff(options.sinceMs);
	const groupBy = options.groupBy ?? "model";
	const db = getSqlite(dbOps);

	const sql = options.sample
		? `SELECT r.model, r.agent_used, r.output_tokens, rp.json AS payload
		   FROM requests r LEFT JOIN request_payloads rp ON rp.id = r.id
		   WHERE r.timestamp > ? AND r.success = 1
		   ORDER BY r.timestamp DESC LIMIT ?`
		: `SELECT r.model, r.agent_used, r.output_tokens, rp.json AS payload
		   FROM requests r LEFT JOIN request_payloads rp ON rp.id = r.id
		   WHERE r.timestamp > ? AND r.success = 1`;
	const rows = options.sample
		? (db.prepare(sql).all(cutoff, options.sample) as Row[])
		: (db.prepare(sql).all(cutoff) as Row[]);

	const buckets = new Map<string, Bucket>();
	let parseFails = 0;

	for (const r of rows) {
		if (!r.payload) continue;
		const resp = unwrapResponsePayload(r.payload);
		const { hasThinking, thinkingChars, textChars } = classify(resp);
		if (resp === null) parseFails++;
		const key =
			groupBy === "agent"
				? (r.agent_used ?? "(main)")
				: groupBy === "model+agent"
					? `${r.model ?? "?"} / ${r.agent_used ?? "(main)"}`
					: (r.model ?? "?");
		const b = buckets.get(key) ?? bucket();
		b.requests++;
		if (hasThinking) b.withThinking++;
		b.totalOutput += r.output_tokens ?? 0;
		b.estThinkingChars += thinkingChars;
		b.estTextChars += textChars;
		buckets.set(key, b);
	}

	const sorted = [...buckets.entries()].sort(
		(a, b) => b[1].totalOutput - a[1].totalOutput,
	);
	process.stdout.write(`\n=== Thinking usage by ${groupBy} ===\n`);
	process.stdout.write(
		"key                                 requests  w/thinking   thinking%   thinking-chars   text-chars   thinking-share-of-chars\n",
	);
	for (const [key, b] of sorted) {
		const totalChars = b.estThinkingChars + b.estTextChars;
		process.stdout.write(
			`${key.padEnd(35).slice(0, 35)} ${fmtNum(b.requests, 9)}  ${fmtNum(b.withThinking, 10)}  ${fmtPct(b.withThinking, b.requests).padStart(9)}  ${fmtNum(b.estThinkingChars, 14)}  ${fmtNum(b.estTextChars, 11)}  ${fmtPct(b.estThinkingChars, totalChars).padStart(8)}\n`,
		);
	}
	if (parseFails > 0) {
		process.stdout.write(
			`\n(${parseFails} responses had no parseable JSON body — likely SSE streams. The 'w/thinking' column still reflects substring detection.)\n`,
		);
	}
	process.stdout.write(
		"\nNote: thinking-chars is a proxy, not a token count. The ratio is more reliable than absolute values.\n",
	);
}
