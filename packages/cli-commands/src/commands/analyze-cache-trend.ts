// B8: cache efficiency rolled up by hour or day.
// Shows cache_read / (cache_read + cache_creation) over time so you can spot
// when fixes (e.g. CLAUDE_CODE_ATTRIBUTION_HEADER=0) take effect.

import type { DatabaseOperations } from "@better-ccflare/database";
import {
	defaultCutoff,
	fmtNum,
	fmtPct,
	fmtUsd,
	getSqlite,
} from "./analyzer-utils";

interface Row {
	bucket: string;
	requests: number;
	cc: number;
	cr: number;
	in_tok: number;
	out_tok: number;
}

interface Options {
	sinceMs?: number;
	granularity?: "hour" | "day";
}

export async function analyzeCacheTrend(
	dbOps: DatabaseOperations,
	options: Options = {},
): Promise<void> {
	const cutoff = defaultCutoff(options.sinceMs);
	const granularity = options.granularity ?? "day";
	const fmt = granularity === "hour" ? "%Y-%m-%d %H:00" : "%Y-%m-%d";
	const db = getSqlite(dbOps);

	const rows = db
		.prepare(
			`SELECT strftime(?, timestamp/1000, 'unixepoch', 'localtime') AS bucket,
			        COUNT(*) AS requests,
			        SUM(COALESCE(cache_creation_input_tokens, 0)) AS cc,
			        SUM(COALESCE(cache_read_input_tokens, 0)) AS cr,
			        SUM(COALESCE(input_tokens, 0)) AS in_tok,
			        SUM(COALESCE(output_tokens, 0)) AS out_tok
			 FROM requests
			 WHERE timestamp > ? AND success = 1
			 GROUP BY bucket
			 ORDER BY bucket ASC`,
		)
		.all(fmt, cutoff) as Row[];

	process.stdout.write(
		`\n=== Cache efficiency trend (per ${granularity}) ===\n`,
	);
	process.stdout.write(
		"bucket             requests    cc           cr           hit-ratio  cc/req   cost-est\n",
	);
	let totalCc = 0;
	let totalCr = 0;
	for (const r of rows) {
		const ratio = fmtPct(r.cr, r.cr + r.cc);
		const ccPerReq = r.requests > 0 ? Math.round(r.cc / r.requests) : 0;
		// rough cost estimate: cc at $18.75/Mtok (Opus 4.7 cache_creation), cr at $1.5/Mtok
		const cost = (r.cc * 18.75 + r.cr * 1.5) / 1_000_000;
		process.stdout.write(
			`${r.bucket.padEnd(17)}  ${fmtNum(r.requests, 8)}  ${fmtNum(r.cc, 11)}  ${fmtNum(r.cr, 11)}  ${ratio.padStart(8)}  ${fmtNum(ccPerReq, 7)}  ${fmtUsd(cost, 8)}\n`,
		);
		totalCc += r.cc;
		totalCr += r.cr;
	}
	process.stdout.write(
		`\nWindow total: cache_creation=${fmtNum(totalCc)}  cache_read=${fmtNum(totalCr)}  hit-ratio=${fmtPct(totalCr, totalCr + totalCc)}\n`,
	);
	process.stdout.write(
		"Higher hit-ratio = more cache reuse. Watch for inflection points after config changes.\n",
	);
}
