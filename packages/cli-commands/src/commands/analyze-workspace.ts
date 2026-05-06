// A1: cost per Conductor workspace.
// Extracts cwd from the system prompt (Claude Code injects "Primary working directory: <path>").

import type { DatabaseOperations } from "@better-ccflare/database";
import {
	defaultCutoff,
	estimateCost,
	extractCwd,
	fmtNum,
	fmtPct,
	fmtUsd,
	getSqlite,
	systemText,
	unwrapRequestPayload,
} from "./analyzer-utils";

interface Row {
	id: string;
	timestamp: number;
	model: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
	payload: string | null;
}

interface Bucket {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
	cost: number;
}

interface Options {
	sinceMs?: number;
	groupBy?: "full" | "workspace" | "project";
	// "full" = full path; "workspace" = strip last segment; "project" = top-level under conductor
}

function bucket(): Bucket {
	return {
		requests: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheCreation: 0,
		cost: 0,
	};
}

function groupKey(cwd: string, mode: NonNullable<Options["groupBy"]>): string {
	if (mode === "full") return cwd;
	// Recognise Conductor workspace pattern: /Users/<u>/conductor/workspaces/<project>/<wt>
	const conductor = cwd.match(
		/^(\/Users\/[^/]+\/conductor\/workspaces\/[^/]+)(?:\/([^/]+))?/,
	);
	if (conductor) {
		if (mode === "workspace") return conductor[1];
		if (mode === "project") {
			return conductor[1].split("/").pop() ?? cwd;
		}
	}
	// Fall back to top-level project dir under home
	const m = cwd.match(/^(\/Users\/[^/]+\/[^/]+\/[^/]+)/);
	return m ? m[1] : cwd;
}

export async function analyzeWorkspace(
	dbOps: DatabaseOperations,
	options: Options = {},
): Promise<void> {
	const cutoff = defaultCutoff(options.sinceMs);
	const mode = options.groupBy ?? "project";
	const db = getSqlite(dbOps);

	const rows = db
		.prepare(
			`SELECT r.id, r.timestamp, r.model,
			        r.input_tokens, r.output_tokens,
			        r.cache_read_input_tokens, r.cache_creation_input_tokens,
			        rp.json AS payload
			 FROM requests r LEFT JOIN request_payloads rp ON rp.id = r.id
			 WHERE r.timestamp > ? AND r.success = 1
			 ORDER BY r.timestamp ASC`,
		)
		.all(cutoff) as Row[];

	const buckets = new Map<string, Bucket>();
	let unknownCwd = 0;

	for (const r of rows) {
		let cwd: string | null = null;
		if (r.payload) {
			const body = unwrapRequestPayload(r.payload);
			if (body) {
				cwd = extractCwd(systemText(body.system));
			}
		}
		const key = cwd ? groupKey(cwd, mode) : "<unknown-cwd>";
		if (!cwd) unknownCwd++;
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
		buckets.set(key, b);
	}

	const totalCost = [...buckets.values()].reduce((s, b) => s + b.cost, 0);
	const sorted = [...buckets.entries()].sort((a, b) => b[1].cost - a[1].cost);

	process.stdout.write(`\n=== Cost per workspace (group=${mode}) ===\n`);
	process.stdout.write(
		`requests   in        out       cc        cr         $est    %    workspace\n`,
	);
	for (const [key, b] of sorted) {
		const display = key.length > 60 ? `…${key.slice(-59)}` : key;
		process.stdout.write(
			`${fmtNum(b.requests, 8)}  ${fmtNum(b.input, 8)}  ${fmtNum(b.output, 8)}  ${fmtNum(b.cacheCreation, 8)}  ${fmtNum(b.cacheRead, 9)}  ${fmtUsd(b.cost, 7)}  ${fmtPct(b.cost, totalCost).padStart(5)}  ${display}\n`,
		);
	}
	process.stdout.write(
		`\nTotal: ${fmtUsd(totalCost)} across ${rows.length} requests. ${unknownCwd} requests had no extractable cwd (e.g. subagents without env block).\n`,
	);
}
