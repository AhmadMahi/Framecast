import { describe, expect, it } from "vitest";

import {
	parseCompositeWindowIds,
	getScreenSourceIdForDisplay,
	LINUX_PORTAL_SCREEN_SOURCE_ID,
} from "./sourceMapping";

describe("getScreenSourceIdForDisplay", () => {
	it("keeps the live Electron screen source when one is available", () => {
		expect(
			getScreenSourceIdForDisplay({
				displayId: "42",
				matchedSourceId: "screen:42:0",
				platform: "linux",
			}),
		).toBe("screen:42:0");
	});

	it("routes unmatched Linux Wayland screens through the portal sentinel", () => {
		expect(
			getScreenSourceIdForDisplay({
				displayId: "42",
				env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" },
				matchedSourceId: null,
				platform: "linux",
			}),
		).toBe(LINUX_PORTAL_SCREEN_SOURCE_ID);
	});

	it("keeps unmatched Linux X11 screens on the explicit fallback id", () => {
		expect(
			getScreenSourceIdForDisplay({
				displayId: "42",
				env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
				matchedSourceId: null,
				platform: "linux",
			}),
		).toBe("screen:fallback:42");
	});

	it("keeps non-Linux unmatched screens on the explicit fallback id", () => {
		expect(
			getScreenSourceIdForDisplay({
				displayId: "42",
				matchedSourceId: undefined,
				platform: "win32",
			}),
		).toBe("screen:fallback:42");
	});
});

describe("parseCompositeWindowIds", () => {
	it("reads the window ids of a Zoom-style multi-window source", () => {
		expect(parseCompositeWindowIds("windows:101,102,7")).toEqual([101, 102, 7]);
		expect(parseCompositeWindowIds("windows:103")).toEqual([103]);
	});

	it("is empty for every other kind of source", () => {
		expect(parseCompositeWindowIds("window:101:0")).toEqual([]);
		expect(parseCompositeWindowIds("screen:1:0")).toEqual([]);
		expect(parseCompositeWindowIds(undefined)).toEqual([]);
		expect(parseCompositeWindowIds(null)).toEqual([]);
	});

	it("ignores malformed ids instead of passing them to the capture helper", () => {
		expect(parseCompositeWindowIds("windows:12,abc,,-4,0,9")).toEqual([12, 9]);
		expect(parseCompositeWindowIds("windows:")).toEqual([]);
	});
});
