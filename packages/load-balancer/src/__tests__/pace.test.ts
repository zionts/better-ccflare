import { describe, expect, it } from "bun:test";
import type { UsageWindowSnapshot } from "@better-ccflare/types";
import {
	CEILING_PENALTY,
	isAtCeiling,
	type PaceOptions,
	pacePenalty,
} from "../pace";

const NOW = 1_000_000_000_000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

const ON: PaceOptions = { enabled: true, floorPct: 55, ceilingPct: 92 };
const OFF: PaceOptions = { enabled: false, floorPct: 55, ceilingPct: 92 };

/**
 * Build a five_hour window snapshot at a given utilization and elapsed
 * fraction. elapsedFraction 0 = window just reset, 1 = about to roll over.
 */
function fiveHour(
	utilization: number,
	elapsedFraction: number,
): UsageWindowSnapshot {
	return {
		window: "five_hour",
		utilization,
		resetAtMs: NOW + (1 - elapsedFraction) * FIVE_HOUR_MS,
	};
}

describe("pacePenalty", () => {
	it("is 0 when disabled, regardless of how far ahead of pace", () => {
		expect(pacePenalty([fiveHour(90, 0.1)], NOW, OFF)).toBe(0);
	});

	it("is 0 with no windows", () => {
		expect(pacePenalty([], NOW, ON)).toBe(0);
	});

	it("is 0 below the floor — even early in the window (the anti-lag-out guard)", () => {
		// 20% used 2% into a fresh 5h window: expected pace ≈ 2%, so this is wildly
		// "ahead of pace" — but it's below the 55% floor, so NO penalty. This is the
		// exact case that the old hard-filter parked for ~30min and lagged the client.
		expect(pacePenalty([fiveHour(20, 0.02)], NOW, ON)).toBe(0);
	});

	it("is 0 when above the floor but at/under linear pace", () => {
		// 60% used 80% through the window → expected 80% → under pace → no penalty.
		expect(pacePenalty([fiveHour(60, 0.8)], NOW, ON)).toBe(0);
	});

	it("penalizes proportionally to how far ahead of pace (above floor)", () => {
		// 70% used 40% through the window → expected 40% → 30 points ahead.
		expect(pacePenalty([fiveHour(70, 0.4)], NOW, ON)).toBeCloseTo(30, 5);
	});

	it("makes an at/above-ceiling account last-resort (>= CEILING_PENALTY)", () => {
		const p = pacePenalty([fiveHour(95, 0.99)], NOW, ON);
		expect(p).toBeGreaterThanOrEqual(CEILING_PENALTY);
		expect(p).toBeCloseTo(CEILING_PENALTY + 95, 5);
	});

	it("takes the most-constrained window (max penalty across windows)", () => {
		const healthy = fiveHour(58, 0.55); // barely above floor, ~3 ahead
		const ceilinged: UsageWindowSnapshot = {
			window: "seven_day",
			utilization: 96,
			resetAtMs: NOW + 1000,
		};
		expect(pacePenalty([healthy, ceilinged], NOW, ON)).toBeGreaterThanOrEqual(
			CEILING_PENALTY,
		);
	});

	it("ignores unmodeled windows (e.g. provider monthly)", () => {
		const monthly: UsageWindowSnapshot = {
			window: "monthly",
			utilization: 99,
			resetAtMs: NOW + 1000,
		};
		expect(pacePenalty([monthly], NOW, ON)).toBe(0);
	});
});

describe("isAtCeiling", () => {
	it("is false when disabled", () => {
		expect(isAtCeiling([fiveHour(99, 0.5)], OFF)).toBe(false);
	});

	it("is false below the ceiling", () => {
		expect(isAtCeiling([fiveHour(80, 0.5)], ON)).toBe(false);
	});

	it("is true at/above the ceiling", () => {
		expect(isAtCeiling([fiveHour(92, 0.5)], ON)).toBe(true);
		expect(isAtCeiling([fiveHour(99, 0.5)], ON)).toBe(true);
	});

	it("ignores unmodeled windows", () => {
		expect(
			isAtCeiling([{ window: "monthly", utilization: 99, resetAtMs: NOW }], ON),
		).toBe(false);
	});
});
