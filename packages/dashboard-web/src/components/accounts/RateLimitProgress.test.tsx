/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RateLimitProgress } from "./RateLimitProgress";

// A weekday timestamp inside the Anthropic peak window (Mon, 15:00 UTC = within
// 13:00–19:00 UTC / 5–11am PT) and also inside the Zai peak window (23:00 SGT is
// out, so this only exercises the Anthropic gate). Wed 2026-04-08 15:00:00 UTC.
const ANTHROPIC_PEAK_TS = Date.parse("2026-04-08T15:00:00Z");

describe("RateLimitProgress", () => {
	afterEach(() => {
		setSystemTime();
	});

	it("does not render the peak-hours badge for Anthropic accounts (peak hours has no pause/routing effect)", () => {
		setSystemTime(new Date(ANTHROPIC_PEAK_TS));
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(ANTHROPIC_PEAK_TS + 60 * 60 * 1000).toISOString()}
				usageUtilization={40}
				usageWindow="five_hour"
				usageData={{
					five_hour: {
						utilization: 40,
						resets_at: new Date(
							ANTHROPIC_PEAK_TS + 60 * 60 * 1000,
						).toISOString(),
					},
					seven_day: null,
				}}
				provider="anthropic"
				showWeekly
			/>,
		);

		expect(html).not.toContain("Peak hours");
		expect(html).not.toContain("Off-peak hours");
	});

	it("still renders the peak-hours badge for Zai accounts during peak hours", () => {
		// Wed 2026-04-08 07:00 UTC = 15:00 SGT, inside the Zai peak window.
		const zaiPeakTs = Date.parse("2026-04-08T07:00:00Z");
		setSystemTime(new Date(zaiPeakTs));
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(zaiPeakTs + 60 * 60 * 1000).toISOString()}
				usageUtilization={40}
				usageWindow="tokens_limit"
				usageData={{
					tokens_limit: { percentage: 40, resetAt: zaiPeakTs + 60 * 60 * 1000 },
					time_limit: null,
				}}
				provider="zai"
				showWeekly
			/>,
		);

		expect(html).toContain("Peak hours (14:00–18:00 SGT)");
	});

	it("shows the throttling message for Zai tokens_limit windows", () => {
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
				usageUtilization={92}
				usageWindow="tokens_limit"
				usageData={{
					tokens_limit: {
						percentage: 92,
						resetAt: Date.now() + 60 * 60 * 1000,
					},
					time_limit: null,
				}}
				usageThrottledUntil={Date.now() + 10 * 60 * 1000}
				usageThrottledWindows={["tokens_limit"]}
				provider="zai"
				showWeekly
			/>,
		);

		expect(html).toContain(
			"Usage throttling enabled; requests are being delayed",
		);
		expect(html).toContain("Usage (5-hour)");
	});

	it("does not display a throttled-until time past reset for over-100% usage", () => {
		const now = Date.now();
		const resetAt = now + 30 * 1000;
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(resetAt).toISOString()}
				usageUtilization={120}
				usageWindow="five_hour"
				usageData={{
					five_hour: {
						utilization: 120,
						resets_at: new Date(resetAt).toISOString(),
					},
					seven_day: null,
				}}
				usageThrottledUntil={resetAt}
				usageThrottledWindows={["five_hour"]}
				provider="codex"
				showWeekly
			/>,
		);

		expect(html).toContain(
			"Usage throttling enabled; requests are being delayed",
		);
		expect(html).not.toContain("Until");
		expect(html).toContain("Less than 1 minute");
	});
});
