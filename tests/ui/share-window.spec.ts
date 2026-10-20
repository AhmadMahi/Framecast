import { expect, test, type Page } from "@playwright/test";

/**
 * The Share window talks only to the preload bridge, so a small fake bridge is
 * enough to drive it end to end: real React, real CSS, real clicks.
 */
async function installShareBridge(page: Page) {
	await page.addInitScript(() => {
		const calls: Array<{ name: string; args: unknown[] }> = [];
		const record =
			(name: string, result: unknown = { success: true }) =>
			async (...args: unknown[]) => {
				calls.push({ name, args });
				return result;
			};
		const tile = (fill: string) =>
			`data:image/svg+xml;utf8,${encodeURIComponent(
				`<svg xmlns="http://www.w3.org/2000/svg" width="352" height="220"><rect width="352" height="220" fill="${fill}"/></svg>`,
			)}`;

		Object.assign(window, {
			__shareCalls: calls,
			electronAPI: {
				getAppSetting: () => null,
				setAppSetting: () => true,
				getPlatform: async () => "darwin",
				getSources: async () => [
					{
						id: "screen:1:0",
						name: "Screen 1 (Primary)",
						display_id: "1",
						thumbnail: tile("#1f2937"),
						appIcon: null,
						sourceType: "screen",
					},
					{
						id: "screen:2:0",
						name: "Screen 2",
						display_id: "2",
						thumbnail: tile("#374151"),
						appIcon: null,
						sourceType: "screen",
					},
					{
						id: "window:101:0",
						name: "Chrome — Docs",
						windowTitle: "Docs",
						appName: "Chrome",
						display_id: "1",
						thumbnail: tile("#2563eb"),
						appIcon: null,
						sourceType: "window",
					},
					{
						id: "window:102:0",
						name: "Notes — Script",
						windowTitle: "Script",
						appName: "Notes",
						display_id: "1",
						thumbnail: tile("#f59e0b"),
						appIcon: null,
						sourceType: "window",
					},
					{
						id: "window:103:0",
						name: "Keynote — Deck",
						windowTitle: "Deck",
						appName: "Keynote",
						display_id: "2",
						thumbnail: null,
						appIcon: null,
						sourceType: "window",
						isFullScreen: true,
					},
				],
				getSelectedSource: async () => null,
				getRecordingPreferences: async () => ({
					success: true,
					microphoneEnabled: false,
					systemAudioEnabled: false,
					webcamEnabled: false,
				}),
				getMicrophoneEnhancement: async () => ({
					success: true,
					settings: {
						noiseSuppression: true,
						echoCancellation: true,
						autoGainControl: false,
						noiseProfile: "strong",
					},
				}),
				selectSource: record("selectSource"),
				setRecordingPreferences: record("setRecordingPreferences"),
				setMicrophoneEnhancement: record("setMicrophoneEnhancement", {
					success: true,
					settings: {},
				}),
				completeShareWindow: record("completeShareWindow"),
				cancelShareWindow: record("cancelShareWindow"),
			},
		});
	});
}

async function calls(page: Page) {
	return page.evaluate(
		() =>
			(window as unknown as { __shareCalls: Array<{ name: string; args: unknown[] }> })
				.__shareCalls,
	);
}

test("ticking several windows records them Zoom-style on one screen", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await installShareBridge(page);
	await page.goto("/?windowType=share&intent=record");

	await expect(page.getByRole("heading", { name: "Choose what to record" })).toBeVisible();
	// The primary screen is preselected when nothing was chosen before.
	await expect(page.getByRole("button", { name: /Screen 1 \(Primary\)/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	// Full-screen apps on other Spaces are listed and labelled.
	await expect(page.getByText("Full screen")).toBeVisible();

	await page.getByRole("button", { name: /Docs/ }).click();
	await page.getByRole("button", { name: /Script/ }).click();
	// Picking windows deselects the screen; two windows are now ticked.
	await expect(page.getByRole("button", { name: /Screen 1 \(Primary\)/ })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(page.getByText("2 windows")).toBeVisible();

	await page.getByText("System audio", { exact: true }).click();
	await expect(page.getByRole("switch", { name: "System audio" })).toBeChecked();
	await page.getByRole("button", { name: "Start recording" }).click();

	await expect
		.poll(async () => (await calls(page)).map((c) => c.name))
		.toContain("completeShareWindow");
	const recorded = await calls(page);
	const selected = recorded.find((c) => c.name === "selectSource")?.args[0] as {
		id: string;
		display_id: string;
		sourceType: string;
	};
	expect(selected.id).toBe("windows:101,102");
	expect(selected.display_id).toBe("1");
	expect(selected.sourceType).toBe("screen");
	expect(recorded.find((c) => c.name === "completeShareWindow")?.args[0]).toEqual({
		start: true,
		microphoneEnabled: false,
		microphoneDeviceId: undefined,
		systemAudioEnabled: true,
	});
	expect(errors).toEqual([]);
});

test("one ordinary window keeps the stock tight window capture", async ({ page }) => {
	await installShareBridge(page);
	await page.goto("/?windowType=share&intent=select");

	await page.getByRole("button", { name: /Docs/ }).click();
	await page.getByRole("button", { name: "Select", exact: true }).click();

	await expect
		.poll(async () => (await calls(page)).map((c) => c.name))
		.toContain("completeShareWindow");
	const recorded = await calls(page);
	expect((recorded.find((c) => c.name === "selectSource")?.args[0] as { id: string }).id).toBe(
		"window:101:0",
	);
	expect(
		(recorded.find((c) => c.name === "completeShareWindow")?.args[0] as { start: boolean })
			.start,
	).toBe(false);
});

test("a single full-screen window records its screen so swiping Spaces cannot break it", async ({
	page,
}) => {
	await installShareBridge(page);
	await page.goto("/?windowType=share&intent=record");

	await page.getByRole("button", { name: /Deck/ }).click();
	await page.getByRole("button", { name: "Start recording" }).click();

	await expect.poll(async () => (await calls(page)).map((c) => c.name)).toContain("selectSource");
	const selected = (await calls(page)).find((c) => c.name === "selectSource")?.args[0] as {
		id: string;
		display_id: string;
	};
	expect(selected.id).toBe("windows:103");
	expect(selected.display_id).toBe("2");
});

test("Escape cancels without saving anything", async ({ page }) => {
	await installShareBridge(page);
	await page.goto("/?windowType=share&intent=record");
	await expect(page.getByRole("heading", { name: "Choose what to record" })).toBeVisible();

	await page.keyboard.press("Escape");

	await expect
		.poll(async () => (await calls(page)).map((c) => c.name))
		.toEqual(["cancelShareWindow"]);
});
