// A2: cost per skill / subagent. Groups by requests.agent_used.

import type { DatabaseOperations } from "@better-ccflare/database";
import {
	defaultCutoff,
	estimateCost,
	fmtNum,
	fmtPct,
	fmtUsd,
	getSqlite,
} from "./analyzer-utils";

interface Row {
	agent_used: string | null;
	model: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
}

interface Bucket {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
	cost: number;
	models: Map<string, number>;
}

function bucket(): Bucket {
	return {
		requests: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheCreation: 0,
		cost: 0,
		models: new Map(),
	};
}

interface Options {
	sinceMs?: number;
}

export async function analyzeSkill(
	dbOps: DatabaseOperations,
	options: Options = {},
): Promise<void> {
	const cutoff = defaultCutoff(options.sinceMs);
	const db = getSqlite(dbOps);

	const rows = db
		.prepare(
			`SELECT agent_used, model,
			        input_tokens, output_tokens,
			        cache_read_input_tokens, cache_creation_input_tokens
			 FROM requests
			 WHERE timestamp > ? AND success = 1`,
		)
		.all(cutoff) as Row[];

	const buckets = new Map<string, Bucket>();
	for (const r of rows) {
		const key = r.agent_used ?? "(main session)";
		const b = buckets.get(key) ?? bucket();
		b.requests++;
		b.input += r.input_tokens ?? 0;
		b.output += r.output_tokens ?? 0;
		b.cacheRead += r.cache_read_input_tokens ?? 0;
		b.cacheCreation += r.cache_creation_input_tokens ?? 0;
		b.cost += estimateCost(r.model, {
			input: r.input_tokens,
			output: r.output_tokens,
			cache_read: r.cache_read_input_tokens,
			cache_creation: r.cache_creation_input_tokens,
		});
		const m = r.model ?? "?";
		b.models.set(m, (b.models.get(m) ?? 0) + 1);
		buckets.set(key, b);
	}

	const totalCost = [...buckets.values()].reduce((s, b) => s + b.cost, 0);
	const sorted = [...buckets.entries()].sort((a, b) => b[1].cost - a[1].cost);

	process.stdout.write("\n=== Cost per skill / subagent ===\n");
	process.stdout.write(
		"agent                          requests    output    cc          $est    avg/call    %    top model\n",
	);
	for (const [key, b] of sorted) {
		const top =
			[...b.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
		const avg = b.requests > 0 ? b.cost / b.requests : 0;
		process.stdout.write(
			`${key.padEnd(30).slice(0, 30)} ${fmtNum(b.requests, 9)}  ${fmtNum(b.output, 8)}  ${fmtNum(b.cacheCreation, 10)}  ${fmtUsd(b.cost, 7)}  ${fmtUsd(avg, 9)}  ${fmtPct(b.cost, totalCost).padStart(5)}  ${top}\n`,
		);
	}
	process.stdout.write(
		`\nTotal: ${fmtUsd(totalCost)} across ${rows.length} requests, ${buckets.size} distinct agents.\n`,
	);
	process.stdout.write(
		"Hint: agents with high avg/call are candidates for pinning to a cheaper model.\n",
	);
}
