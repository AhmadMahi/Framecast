import { expect, type Page, test } from "@playwright/test";

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

/**
 * Fakes the microphone list. Until access is granted Chromium reports one
 * nameless device, exactly as it does for a page without microphone access.
 */
async function installMicrophones(page: Page, options: { granted: boolean; enabled: boolean }) {
	await page.addInitScript((opts) => {
		const state = { granted: opts.granted };
		const named = [
			{ deviceId: "default", label: "Default - MacBook Air Microphone", groupId: "a" },
			{ deviceId: "builtin", label: "MacBook Air Microphone", groupId: "a" },
			{ deviceId: "usb-1", label: "Studio Mic (046d:0825)", groupId: "b" },
		];
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: {
				enumerateDevices: async () =>
					(state.granted ? named : [{ deviceId: "", label: "", groupId: "" }]).map(
						(device) => ({ ...device, kind: "audioinput", toJSON: () => device }),
					),
				getUserMedia: async () => {
					if (!state.granted) throw new DOMException("denied", "NotAllowedError");
					return { getTracks: () => [] };
				},
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
			},
		});
		const api = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
		api.requestMicrophoneAccess = async () => {
			state.granted = true;
			document.documentElement.dataset.micRequested = "true";
			return { success: true, status: "granted" };
		};
		const prefs = api.getRecordingPreferences as () => Promise<Record<string, unknown>>;
		api.getRecordingPreferences = async () => ({
			...(await prefs()),
			microphoneEnabled: opts.enabled,
			microphoneDeviceId: opts.enabled ? "usb-1" : undefined,
		});
	}, options);
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

test("an empty window list explains the missing permission instead of claiming no windows", async ({
	page,
}) => {
	await installShareBridge(page);
	await page.addInitScript(() => {
		const api = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
		const original = api.getSources as () => Promise<Array<{ id: string }>>;
		api.getSources = async () => (await original()).filter((s) => s.id.startsWith("screen:"));
		api.getWindowListHealth = async () => ({ error: "SCREEN_RECORDING_PERMISSION_DENIED" });
		api.getScreenRecordingPermissionStatus = async () => ({ success: true, status: "denied" });
		api.openScreenRecordingPreferences = async () => {
			document.documentElement.dataset.openedSettings = "true";
			return { success: true };
		};
	});
	await page.goto("/?windowType=share&intent=record");

	await expect(page.getByText("Framecast can't see your windows yet")).toBeVisible();
	await expect(page.getByText("No open windows found", { exact: false })).toHaveCount(0);
	await page.getByRole("button", { name: "Open System Settings" }).click();
	await expect(page.locator("html")).toHaveAttribute("data-opened-settings", "true");
});

test("the microphone chip names the chosen microphone", async ({ page }) => {
	await installShareBridge(page);
	await installMicrophones(page, { granted: true, enabled: true });
	await page.goto("/?windowType=share&intent=select");

	const chip = page.locator("label").filter({ hasText: "Microphone" });
	// The USB vendor id Chromium appends is dropped from the name.
	await expect(chip).toContainText("Studio Mic");
	await expect(chip).not.toContainText("046d");
	await expect(page.getByRole("combobox", { name: "Microphone" })).toHaveValue("usb-1");
	await expect(
		page.locator("option", { hasText: "System default (MacBook Air Microphone)" }),
	).toHaveCount(1);
});

test("nameless microphones ask for access, then show their names", async ({ page }) => {
	await installShareBridge(page);
	await installMicrophones(page, { granted: false, enabled: false });
	await page.goto("/?windowType=share&intent=select");

	const allow = page.getByRole("button", { name: /Allow access to list microphones/ });
	await expect(allow).toBeVisible();
	await allow.click();

	await expect(page.locator("html")).toHaveAttribute("data-mic-requested", "true");
	await expect(allow).toHaveCount(0);
	await page.getByRole("combobox", { name: "Microphone" }).selectOption("builtin");
	await expect(page.locator("label").filter({ hasText: "Microphone" })).toContainText(
		"MacBook Air Microphone",
	);
});

test("a window without a preview says why, and the close button cancels", async ({ page }) => {
	await installShareBridge(page);
	await page.addInitScript(() => {
		const api = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
		const original = api.getSources as () => Promise<Array<Record<string, unknown>>>;
		api.getSources = async () =>
			(await original()).map((source) =>
				source.id === "window:102:0" ? { ...source, thumbnail: null } : source,
			);
	});
	await page.goto("/?windowType=share&intent=record");

	// Only the minimized/off-screen window gets the caption, not the full-screen app.
	await expect(page.getByText("No preview while off screen")).toHaveCount(1);
	await expect(page.getByRole("button", { name: /Script/ })).toContainText(
		"No preview while off screen",
	);

	await page.getByRole("button", { name: "Close" }).click();
	await expect
		.poll(async () => (await calls(page)).map((c) => c.name))
		.toEqual(["cancelShareWindow"]);
});
