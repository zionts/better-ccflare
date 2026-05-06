// A3 + A4: system-prefix size distribution and tool/MCP attribution.
// Quantifies what's bloating each request's cacheable prefix.

import type { DatabaseOperations } from "@better-ccflare/database";
import {
	defaultCutoff,
	fmtNum,
	fmtPct,
	getSqlite,
	systemText,
	unwrapRequestPayload,
} from "./analyzer-utils";

interface Row {
	id: string;
	timestamp: number;
	payload: string | null;
}

interface Options {
	sinceMs?: number;
	sample?: number; // optional cap on rows to scan (payload parse is the slow part)
}

interface ToolStat {
	count: number;
	totalLen: number;
	maxLen: number;
}

export async function analyzePrefix(
	dbOps: DatabaseOperations,
	options: Options = {},
): Promise<void> {
	const cutoff = defaultCutoff(options.sinceMs);
	const db = getSqlite(dbOps);

	const sql = options.sample
		? `SELECT r.id, r.timestamp, rp.json AS payload
		   FROM requests r LEFT JOIN request_payloads rp ON rp.id = r.id
		   WHERE r.timestamp > ? AND r.success = 1
		   ORDER BY r.timestamp DESC
		   LIMIT ?`
		: `SELECT r.id, r.timestamp, rp.json AS payload
		   FROM requests r LEFT JOIN request_payloads rp ON rp.id = r.id
		   WHERE r.timestamp > ? AND r.success = 1`;
	const rows = options.sample
		? (db.prepare(sql).all(cutoff, options.sample) as Row[])
		: (db.prepare(sql).all(cutoff) as Row[]);

	const sysLengths: number[] = [];
	const toolLengths: number[] = [];
	const toolStats = new Map<string, ToolStat>();
	let parseFails = 0;
	let totalRequests = 0;

	for (const r of rows) {
		if (!r.payload) continue;
		const body = unwrapRequestPayload(r.payload);
		if (!body) {
			parseFails++;
			continue;
		}
		totalRequests++;
		const sysLen = systemText(body.system).length;
		sysLengths.push(sysLen);
		const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
		const toolJsonLen = JSON.stringify(tools).length;
		toolLengths.push(toolJsonLen);
		for (const t of tools) {
			if (typeof t !== "object" || t === null) continue;
			const name = String((t as { name?: unknown }).name ?? "?");
			const len = JSON.stringify(t).length;
			const s = toolStats.get(name) ?? { count: 0, totalLen: 0, maxLen: 0 };
			s.count++;
			s.totalLen += len;
			s.maxLen = Math.max(s.maxLen, len);
			toolStats.set(name, s);
		}
	}

	const sysSorted = [...sysLengths].sort((a, b) => a - b);
	const toolsSorted = [...toolLengths].sort((a, b) => a - b);
	const pct = (arr: number[], p: number) =>
		arr.length === 0 ? 0 : arr[Math.floor(arr.length * p)];

	process.stdout.write("\n=== System-prefix size distribution (chars) ===\n");
	if (sysLengths.length > 0) {
		process.stdout.write(
			`requests=${totalRequests}  min=${fmtNum(sysSorted[0])}  ` +
				`p50=${fmtNum(pct(sysSorted, 0.5))}  ` +
				`p90=${fmtNum(pct(sysSorted, 0.9))}  ` +
				`p99=${fmtNum(pct(sysSorted, 0.99))}  ` +
				`max=${fmtNum(sysSorted[sysSorted.length - 1])}\n`,
		);
		const totalSys = sysSorted.reduce((a, b) => a + b, 0);
		process.stdout.write(
			`avg=${fmtNum(Math.round(totalSys / sysSorted.length))}  total chars cached: ${fmtNum(totalSys)}\n`,
		);
	}

	process.stdout.write("\n=== Tools array size distribution (chars) ===\n");
	if (toolsSorted.length > 0) {
		process.stdout.write(
			`min=${fmtNum(toolsSorted[0])}  ` +
				`p50=${fmtNum(pct(toolsSorted, 0.5))}  ` +
				`p90=${fmtNum(pct(toolsSorted, 0.9))}  ` +
				`max=${fmtNum(toolsSorted[toolsSorted.length - 1])}\n`,
		);
	}

	process.stdout.write(
		"\n=== Tool-by-tool size attribution (top 20 by total bytes) ===\n",
	);
	const totalToolBytes = [...toolStats.values()].reduce(
		(s, t) => s + t.totalLen,
		0,
	);
	const sortedTools = [...toolStats.entries()].sort(
		(a, b) => b[1].totalLen - a[1].totalLen,
	);
	process.stdout.write(
		"tool                                count   total chars   max chars  %\n",
	);
	for (const [name, s] of sortedTools.slice(0, 20)) {
		process.stdout.write(
			`${name.padEnd(35).slice(0, 35)} ${fmtNum(s.count, 7)}  ${fmtNum(s.totalLen, 12)}  ${fmtNum(s.maxLen, 9)}  ${fmtPct(s.totalLen, totalToolBytes).padStart(5)}\n`,
		);
	}
	if (parseFails > 0) {
		process.stdout.write(`\n(${parseFails} payloads failed to parse)\n`);
	}
}
