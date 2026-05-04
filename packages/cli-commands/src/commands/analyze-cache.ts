import { createHash } from "node:crypto";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";

interface RequestRow {
	id: string;
	timestamp: number;
	account_used: string | null;
	model: string | null;
	cache_creation_input_tokens: number | null;
	cache_read_input_tokens: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	agent_used: string | null;
	payload: string | null;
}

interface PrefixHashes {
	systemFullHash: string;
	systemBlockHashes: string[];
	systemBlockSamples: string[]; // first 80 chars of each block — for human-readable diffs
	systemBlockCount: number;
	toolsSortedHash: string;
	toolsCount: number;
	toolsList: string[];
	messagesCount: number;
	firstUserMsgHash: string;
	systemTextLen: number;
	toolsJsonLen: number;
}

interface SessionState {
	sessionId: string;
	prevRow: RequestRow | null;
	prevHashes: PrefixHashes | null;
	prevTimestamp: number;
}

const SESSION_GAP_MS = TIME_CONSTANTS.HOUR; // 1h ephemeral TTL boundary

function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function hashSystem(system: unknown): {
	full: string;
	blocks: string[];
	samples: string[];
	count: number;
	textLen: number;
} {
	if (system == null)
		return { full: "∅", blocks: [], samples: [], count: 0, textLen: 0 };
	if (typeof system === "string") {
		return {
			full: sha256(system),
			blocks: [sha256(system)],
			samples: [system.slice(0, 80)],
			count: 1,
			textLen: system.length,
		};
	}
	if (Array.isArray(system)) {
		const blocks = system.map((b) => sha256(JSON.stringify(b)));
		const samples = system.map((b) => {
			const t =
				typeof b === "object" && b && "text" in (b as Record<string, unknown>)
					? String((b as { text?: unknown }).text ?? "")
					: JSON.stringify(b);
			return t.slice(0, 80);
		});
		const textLen = JSON.stringify(system).length;
		return {
			full: sha256(blocks.join("|")),
			blocks,
			samples,
			count: blocks.length,
			textLen,
		};
	}
	return { full: "?", blocks: [], samples: [], count: 0, textLen: 0 };
}

function hashTools(tools: unknown): {
	hash: string;
	count: number;
	names: string[];
	jsonLen: number;
} {
	if (!Array.isArray(tools) || tools.length === 0)
		return { hash: "∅", count: 0, names: [], jsonLen: 0 };
	const sorted = [...tools].sort((a, b) => {
		const an = (a as { name?: string })?.name ?? "";
		const bn = (b as { name?: string })?.name ?? "";
		return an.localeCompare(bn);
	});
	const names = sorted.map((t) => (t as { name?: string })?.name ?? "?");
	const json = JSON.stringify(sorted);
	return {
		hash: sha256(json),
		count: sorted.length,
		names,
		jsonLen: json.length,
	};
}

function hashFirstUserMessage(messages: unknown): string {
	if (!Array.isArray(messages)) return "∅";
	const first = messages.find((m) => (m as { role?: string })?.role === "user");
	if (!first) return "∅";
	return sha256(JSON.stringify(first));
}

function computeHashes(payloadJson: string): PrefixHashes | null {
	// request_payloads.json is a wrapper {request: {headers, body}, response, meta}
	// where request.body is a JSON-encoded string of the actual Anthropic API request.
	let wrapper: Record<string, unknown>;
	try {
		wrapper = JSON.parse(payloadJson) as Record<string, unknown>;
	} catch {
		return null;
	}
	const req = wrapper.request as { body?: unknown } | undefined;
	const bodyRaw = req?.body;
	let parsed: Record<string, unknown>;
	if (typeof bodyRaw === "string") {
		// Body is base64-encoded JSON. Try base64 first, fall back to raw string.
		let decoded = bodyRaw;
		try {
			decoded = Buffer.from(bodyRaw, "base64").toString("utf8");
			// Sanity check: decoded should start with {
			if (!decoded.trimStart().startsWith("{")) {
				decoded = bodyRaw;
			}
		} catch {
			decoded = bodyRaw;
		}
		try {
			parsed = JSON.parse(decoded) as Record<string, unknown>;
		} catch {
			return null;
		}
	} else if (bodyRaw && typeof bodyRaw === "object") {
		parsed = bodyRaw as Record<string, unknown>;
	} else {
		parsed = wrapper;
	}
	const sys = hashSystem(parsed.system);
	const tools = hashTools(parsed.tools);
	const msgs = Array.isArray(parsed.messages)
		? (parsed.messages as unknown[])
		: [];
	return {
		systemFullHash: sys.full,
		systemBlockHashes: sys.blocks,
		systemBlockSamples: sys.samples,
		systemBlockCount: sys.count,
		toolsSortedHash: tools.hash,
		toolsCount: tools.count,
		toolsList: tools.names,
		messagesCount: msgs.length,
		firstUserMsgHash: hashFirstUserMessage(msgs),
		systemTextLen: sys.textLen,
		toolsJsonLen: tools.jsonLen,
	};
}

function diffSystemBlocks(prev: string[], curr: string[]): number[] {
	const changed: number[] = [];
	const max = Math.max(prev.length, curr.length);
	for (let i = 0; i < max; i++) {
		if (prev[i] !== curr[i]) changed.push(i);
	}
	return changed;
}

function diffToolNames(
	prev: string[],
	curr: string[],
): {
	added: string[];
	removed: string[];
} {
	const prevSet = new Set(prev);
	const currSet = new Set(curr);
	return {
		added: curr.filter((n) => !prevSet.has(n)),
		removed: prev.filter((n) => !currSet.has(n)),
	};
}

interface AnalyzeCacheOptions {
	sinceMs?: number; // default: 7 days
	output?: string; // file path; default: stdout
	verbose?: boolean;
}

export async function analyzeCacheInvalidation(
	dbOps: DatabaseOperations,
	options: AnalyzeCacheOptions = {},
): Promise<void> {
	const since = options.sinceMs ?? TIME_CONSTANTS.DAY * 7;
	const cutoff = Date.now() - since;
	const adapter = dbOps.getAdapter();
	const db = adapter.getSQLiteDb();

	const sql = `
		SELECT
			r.id,
			r.timestamp,
			r.account_used,
			r.model,
			r.cache_creation_input_tokens,
			r.cache_read_input_tokens,
			r.input_tokens,
			r.output_tokens,
			r.agent_used,
			rp.json AS payload
		FROM requests r
		LEFT JOIN request_payloads rp ON rp.id = r.id
		WHERE r.timestamp > ?
			AND r.success = 1
		ORDER BY r.account_used ASC, r.timestamp ASC
	`;

	const rows = db.prepare(sql).all(cutoff) as RequestRow[];

	const writer = options.output
		? Bun.file(options.output).writer()
		: { write: (s: string) => process.stdout.write(s), end: async () => {} };

	const sessionsByAccount = new Map<string, SessionState>();
	let totalRecacheEvents = 0;
	let totalRecacheTokens = 0;
	const causeBuckets = new Map<string, { count: number; tokens: number }>();
	const blockIndexBuckets = new Map<
		number,
		{ count: number; tokens: number }
	>();
	// Capture one sample per (block index, prev/curr) pair so the human reader can see what mutated
	const blockSampleMap = new Map<number, { prev: string; curr: string }>();
	const sessionsSeen = new Set<string>();

	for (const row of rows) {
		const account = row.account_used ?? "no_account";
		const payload = row.payload;
		if (!payload) continue;

		const hashes = computeHashes(payload);
		if (!hashes) continue;

		const prev = sessionsByAccount.get(account);
		const isNewSession =
			!prev || row.timestamp - prev.prevTimestamp > SESSION_GAP_MS;

		let sessionId: string;
		if (isNewSession) {
			sessionId = `${account}-${row.timestamp}`;
		} else {
			sessionId = (prev as SessionState).sessionId;
		}
		sessionsSeen.add(sessionId);

		const cc = row.cache_creation_input_tokens ?? 0;
		const cr = row.cache_read_input_tokens ?? 0;

		// Re-cache event: cache_creation > 0 AND we have a prior request in the same session
		const isRecache = cc > 0 && !isNewSession && prev?.prevHashes != null;

		if (isRecache && prev?.prevHashes) {
			totalRecacheEvents++;
			totalRecacheTokens += cc;

			const gapMs = row.timestamp - prev.prevTimestamp;
			const ph = prev.prevHashes;

			const systemChanged = ph.systemFullHash !== hashes.systemFullHash;
			const toolsChanged = ph.toolsSortedHash !== hashes.toolsSortedHash;
			const firstMsgChanged = ph.firstUserMsgHash !== hashes.firstUserMsgHash;
			const systemBlocksDelta = hashes.systemBlockCount - ph.systemBlockCount;
			const toolsDelta = hashes.toolsCount - ph.toolsCount;
			const messagesDelta = hashes.messagesCount - ph.messagesCount;

			const changedBlocks = systemChanged
				? diffSystemBlocks(ph.systemBlockHashes, hashes.systemBlockHashes)
				: [];
			const toolDiff = toolsChanged
				? diffToolNames(ph.toolsList, hashes.toolsList)
				: { added: [], removed: [] };

			const causes: string[] = [];
			if (systemChanged) {
				// Granular: which block indices? "system_block_N" lets us see what's actually mutating
				if (changedBlocks.length === 1) {
					causes.push(`system_block_${changedBlocks[0]}_only`);
				} else if (changedBlocks.length > 1) {
					causes.push(`system_blocks_${changedBlocks.join("+")}`);
				} else {
					causes.push("system");
				}
			}
			if (toolsChanged) causes.push("tools");
			if (firstMsgChanged) causes.push("first_user_msg");
			if (gapMs > SESSION_GAP_MS) causes.push("idle_gap_over_1h"); // defensive
			if (causes.length === 0) causes.push("none_detected");

			const primaryCause = causes[0];
			const bucket = causeBuckets.get(primaryCause) ?? { count: 0, tokens: 0 };
			bucket.count++;
			bucket.tokens += cc;
			causeBuckets.set(primaryCause, bucket);

			for (const idx of changedBlocks) {
				const b = blockIndexBuckets.get(idx) ?? { count: 0, tokens: 0 };
				b.count++;
				b.tokens += cc;
				blockIndexBuckets.set(idx, b);
				if (!blockSampleMap.has(idx)) {
					blockSampleMap.set(idx, {
						prev: ph.systemBlockSamples[idx] ?? "(missing)",
						curr: hashes.systemBlockSamples[idx] ?? "(missing)",
					});
				}
			}

			const event = {
				kind: "recache",
				session_id: sessionId,
				request_id: row.id,
				prev_request_id: prev.prevRow?.id ?? null,
				timestamp: row.timestamp,
				timestamp_iso: new Date(row.timestamp).toISOString(),
				account,
				model: row.model,
				agent: row.agent_used,
				gap_ms: gapMs,
				cache_creation_tokens: cc,
				cache_read_tokens: cr,
				input_tokens: row.input_tokens,
				output_tokens: row.output_tokens,
				causes,
				system_changed: systemChanged,
				tools_changed: toolsChanged,
				first_user_msg_changed: firstMsgChanged,
				system_block_count_delta: systemBlocksDelta,
				tools_count_delta: toolsDelta,
				messages_count_delta: messagesDelta,
				changed_system_block_indices: changedBlocks,
				tools_added: toolDiff.added,
				tools_removed: toolDiff.removed,
				prev_system_block_count: ph.systemBlockCount,
				curr_system_block_count: hashes.systemBlockCount,
				prev_tools_count: ph.toolsCount,
				curr_tools_count: hashes.toolsCount,
				prev_messages_count: ph.messagesCount,
				curr_messages_count: hashes.messagesCount,
				system_text_len: hashes.systemTextLen,
				tools_json_len: hashes.toolsJsonLen,
			};
			writer.write(`${JSON.stringify(event)}\n`);
		}

		sessionsByAccount.set(account, {
			sessionId,
			prevRow: row,
			prevHashes: hashes,
			prevTimestamp: row.timestamp,
		});
	}

	if (writer.end) await writer.end();

	// Summary to stderr (so JSONL stdout stays clean for piping)
	const sinceDays = (since / TIME_CONSTANTS.DAY).toFixed(1);
	process.stderr.write(
		`\n=== Cache invalidation analysis (last ${sinceDays}d) ===\n`,
	);
	process.stderr.write(`Rows scanned: ${rows.length}\n`);
	process.stderr.write(`Sessions: ${sessionsSeen.size}\n`);
	process.stderr.write(`Re-cache events: ${totalRecacheEvents}\n`);
	process.stderr.write(
		`Re-cache tokens (cache_creation): ${totalRecacheTokens.toLocaleString()}\n`,
	);
	process.stderr.write(`\nPrimary cause breakdown:\n`);
	const sortedCauses = [...causeBuckets.entries()].sort(
		(a, b) => b[1].tokens - a[1].tokens,
	);
	for (const [cause, stats] of sortedCauses) {
		const pct =
			totalRecacheTokens > 0
				? ((stats.tokens / totalRecacheTokens) * 100).toFixed(1)
				: "0.0";
		process.stderr.write(
			`  ${cause.padEnd(28)} ${stats.count
				.toString()
				.padStart(6)} events  ${stats.tokens
				.toLocaleString()
				.padStart(15)} tok  (${pct}%)\n`,
		);
	}

	if (blockIndexBuckets.size > 0) {
		process.stderr.write(`\nMutated system block indices (any cause):\n`);
		const sortedIdx = [...blockIndexBuckets.entries()].sort(
			(a, b) => b[1].tokens - a[1].tokens,
		);
		for (const [idx, stats] of sortedIdx) {
			const pct =
				totalRecacheTokens > 0
					? ((stats.tokens / totalRecacheTokens) * 100).toFixed(1)
					: "0.0";
			process.stderr.write(
				`  block[${idx}] ${stats.count
					.toString()
					.padStart(6)} events  ${stats.tokens
					.toLocaleString()
					.padStart(15)} tok  (${pct}%)\n`,
			);
		}
		process.stderr.write(`\nSample of one mutation per block:\n`);
		for (const [idx, sample] of [...blockSampleMap.entries()].sort(
			(a, b) => a[0] - b[0],
		)) {
			process.stderr.write(`  block[${idx}]\n`);
			process.stderr.write(`    prev: ${JSON.stringify(sample.prev)}\n`);
			process.stderr.write(`    curr: ${JSON.stringify(sample.curr)}\n`);
		}
	}

	if (options.output) {
		process.stderr.write(`\nJSONL written to ${options.output}\n`);
	}
}
