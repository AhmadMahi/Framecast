import { afterEach, describe, expect, it } from "vitest";
import {
	markQuitFromApp,
	markQuitRefused,
	noteRecordingActive,
	noteRecordingStarting,
	quitWasRefused,
	resetQuitGuard,
	shouldRefuseQuit,
} from "./quitGuard";

describe("quit guard", () => {
	afterEach(() => resetQuitGuard());

	it("lets outside quit requests through when nothing is recording", () => {
		expect(shouldRefuseQuit()).toBe(false);
	});

	it("refuses outside quit requests while a recording starts or runs", () => {
		noteRecordingStarting(5_000);
		expect(shouldRefuseQuit()).toBe(true);
		expect(shouldRefuseQuit(Date.now() + 6_000)).toBe(false);

		noteRecordingActive(true);
		expect(shouldRefuseQuit(Date.now() + 60_000)).toBe(true);

		noteRecordingActive(false);
		expect(shouldRefuseQuit()).toBe(false);
	});

	it("always honours a quit chosen from Framecast's own menus", () => {
		noteRecordingActive(true);
		markQuitFromApp();
		expect(shouldRefuseQuit()).toBe(false);
	});

	it("flags a refused quit only for the current dispatch", async () => {
		markQuitRefused();
		expect(quitWasRefused()).toBe(true);
		await new Promise((resolve) => setImmediate(resolve));
		expect(quitWasRefused()).toBe(false);
	});
});
