// B7: top-N most expensive single turns + B6: idle-gap cache loss.

import type { DatabaseOperations } from "@better-ccflare/database";
import {
	defaultCutoff,
	estimateCost,
	fmtDuration,
	fmtNum,
	fmtPct,
	fmtUsd,
	getSqlite,
	SESSION_GAP_MS,
} from "./analyzer-utils";

interface Row {
	id: string;
	timestamp: number;
	account_used: string | null;
	model: string | null;
	agent_used: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
	response_time_ms: number | null;
}

interface Options {
	sinceMs?: number;
	topN?: number;
}

export async function analyzeTopTurns(
	dbOps: DatabaseOperations,
	options: Options = {},
): Promise<void> {
	const cutoff = defaultCutoff(options.sinceMs);
	const topN = options.topN ?? 20;
	const db = getSqlite(dbOps);

	const rows = db
		.prepare(
			`SELECT id, timestamp, account_used, model, agent_used,
			        input_tokens, output_tokens,
			        cache_read_input_tokens, cache_creation_input_tokens,
			        response_time_ms
			 FROM requests
			 WHERE timestamp > ? AND success = 1
			 ORDER BY timestamp ASC`,
		)
		.all(cutoff) as Row[];

	// Sort by estimated cost descending; pick top N.
	const withCost = rows.map((r) => ({
		row: r,
		cost: estimateCost(r.model, {
			input: r.input_tokens,
			output: r.output_tokens,
			cache_read: r.cache_read_input_tokens,
			cache_creation: r.cache_creation_input_tokens,
		}),
	}));
	withCost.sort((a, b) => b.cost - a.cost);
	const top = withCost.slice(0, topN);

	process.stdout.write("\n=== Top expensive turns ===\n");
	process.stdout.write(
		`time              model                       agent           in       out     cc       cr   $est   ms\n`,
	);
	for (const { row, cost } of top) {
		const t = new Date(row.timestamp).toISOString().slice(11, 19);
		const model = (row.model ?? "?").padEnd(26).slice(0, 26);
		const agent = (row.agent_used ?? "-").padEnd(15).slice(0, 15);
		const line =
			`${t}  ${model}  ${agent}  ${fmtNum(row.input_tokens ?? 0, 7)}  ` +
			`${fmtNum(row.output_tokens ?? 0, 6)}  ` +
			`${fmtNum(row.cache_creation_input_tokens ?? 0, 6)}  ` +
			`${fmtNum(row.cache_read_input_tokens ?? 0, 7)}  ` +
			`${fmtUsd(cost, 6)}  ${fmtNum(row.response_time_ms ?? 0, 5)}\n`;
		process.stdout.write(line);
	}

	// B6: idle-gap analysis. Group by account, find consecutive requests with gap > 1h.
	const byAccount = new Map<string, Row[]>();
	for (const r of rows) {
		const a = r.account_used ?? "no_account";
		const arr = byAccount.get(a) ?? [];
		arr.push(r);
		byAccount.set(a, arr);
	}

	let idleCrossings = 0;
	let idleCcTokens = 0;
	let idleCcCost = 0;
	let totalCc = 0;
	const gapBuckets = new Map<string, number>();
	for (const arr of byAccount.values()) {
		for (let i = 1; i < arr.length; i++) {
			const prev = arr[i - 1];
			const cur = arr[i];
			const gap = cur.timestamp - prev.timestamp;
			const cc = cur.cache_creation_input_tokens ?? 0;
			totalCc += cc;
			if (gap > SESSION_GAP_MS && cc > 0) {
				idleCrossings++;
				idleCcTokens += cc;
				idleCcCost += estimateCost(cur.model, { cache_creation: cc });
				const hr = Math.floor(gap / 3_600_000);
				const bucket =
					hr < 2 ? "1-2h" : hr < 4 ? "2-4h" : hr < 12 ? "4-12h" : "12h+";
				gapBuckets.set(bucket, (gapBuckets.get(bucket) ?? 0) + 1);
			}
		}
	}

	process.stdout.write(
		"\n=== Idle-gap cache loss (gap > 1h forced re-cache) ===\n",
	);
	process.stdout.write(
		`Crossings: ${idleCrossings}  cache_creation tokens: ${fmtNum(idleCcTokens)}  ` +
			`(${fmtPct(idleCcTokens, totalCc)} of total cc)  est cost: ${fmtUsd(idleCcCost)}\n`,
	);
	if (gapBuckets.size > 0) {
		process.stdout.write("Gap distribution:\n");
		for (const [k, v] of gapBuckets) {
			process.stdout.write(`  ${k.padEnd(8)} ${fmtNum(v, 5)} crossings\n`);
		}
	}
	process.stdout.write(
		`\nWindow scanned: ${rows.length} requests over ${fmtDuration(Date.now() - cutoff)}\n`,
	);
}
