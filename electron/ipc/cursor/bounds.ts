import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureNativeWindowListBinary } from "../paths/binaries";
import {
	cachedNativeMacWindowSources,
	cachedNativeMacWindowSourcesAtMs,
	interactionCaptureCleanup,
	selectedSource,
	setCachedNativeMacWindowSources,
	setCachedNativeMacWindowSourcesAtMs,
	setInteractionCaptureCleanup,
	setSelectedWindowBounds,
	setWindowBoundsCaptureInterval,
	windowBoundsCaptureInterval,
} from "../state";
import type { NativeMacWindowSource, SelectedSource, WindowBounds } from "../types";
import { parseWindowId } from "../utils";
import { resolveWindowsWindowBounds } from "../windowsWindowControl";

const execFileAsync = promisify(execFile);

let windowHelperQueue: Promise<unknown> = Promise.resolve();
const pendingWindowHelperRuns = new Map<string, Promise<{ stdout: string; stderr: string }>>();

/**
 * Runs the native window helper strictly one at a time. When two processes ask
 * ScreenCaptureKit for the window list at the same moment, macOS can leave one
 * of them waiting forever. The helper exits on its own after 12 seconds
 * (code 3); a run that timed out like that is retried once.
 */
function runWindowListHelper(
	args: string[],
	options: { timeout: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
	const run = async () => {
		const binaryPath = await ensureNativeWindowListBinary();
		try {
			return await execFileAsync(binaryPath, args, options);
		} catch (error) {
			const code = (error as { code?: number | string }).code;
			if (code === 3 && args[0] !== "--focus") {
				return await execFileAsync(binaryPath, args, options);
			}
			throw error;
		}
	};
	// An identical request already waiting (window tracking polls four times a
	// second) shares that run instead of queueing another one.
	const key = args.join(" ");
	const pending = pendingWindowHelperRuns.get(key);
	if (pending) {
		return pending;
	}
	const result = windowHelperQueue.then(run, run);
	pendingWindowHelperRuns.set(key, result);
	windowHelperQueue = result
		.catch(() => undefined)
		.finally(() => pendingWindowHelperRuns.delete(key));
	return result;
}

let lastNativeWindowListError: string | null = null;

/**
 * Why the last native window listing failed, or null if it succeeded. The
 * usual cause is missing Screen & System Audio Recording permission, which
 * an unsigned build loses every time it is reinstalled.
 */
export function getLastNativeWindowListError() {
	return lastNativeWindowListError;
}

/**
 * Brings windows that are minimized, hidden, or on another desktop on screen,
 * the way Zoom does when sharing starts, because macOS can only record what is
 * on screen. Visible windows are left alone. Resolves with the ids that are
 * on screen afterwards, or null when the helper could not run.
 */
export async function focusNativeMacWindows(
	ids: number[],
): Promise<{ onScreen: number[]; offScreen: number[] } | null> {
	const wanted = ids.filter((id) => Number.isInteger(id) && id > 0);
	if (process.platform !== "darwin" || wanted.length === 0) {
		return null;
	}
	try {
		const { stdout } = await runWindowListHelper(["--focus", wanted.join(",")], {
			timeout: 2500 * wanted.length + 1000,
		});
		const parsed = JSON.parse(stdout) as { onScreen?: number[]; offScreen?: number[] };
		return {
			onScreen: Array.isArray(parsed.onScreen) ? parsed.onScreen : [],
			offScreen: Array.isArray(parsed.offScreen) ? parsed.offScreen : [],
		};
	} catch (error) {
		console.warn("[window-list] Could not bring windows on screen:", error);
		return null;
	}
}

export async function getNativeMacWindowSources(options?: {
	maxAgeMs?: number;
	/** Attach a JPEG preview of each window, fitting this size. */
	thumbnailSize?: { width: number; height: number };
	/** Only list these window ids. */
	ids?: number[];
}) {
	if (process.platform !== "darwin") {
		return [] as NativeMacWindowSource[];
	}

	// Previews and id filters are one-off requests; they never touch the cache
	// that cursor and highlight lookups rely on.
	const args: string[] = [];
	if (options?.thumbnailSize) {
		args.push(
			"--thumbnails",
			`${Math.round(options.thumbnailSize.width)}x${Math.round(options.thumbnailSize.height)}`,
		);
	}
	if (options?.ids?.length) {
		args.push("--ids", options.ids.join(","));
	}
	if (args.length > 0) {
		try {
			const { stdout } = await runWindowListHelper(args, {
				timeout: 30000,
				maxBuffer: 64 * 1024 * 1024,
			});
			const parsed = JSON.parse(stdout);
			lastNativeWindowListError = null;
			return Array.isArray(parsed)
				? (parsed.filter(
						(entry: Partial<NativeMacWindowSource>) =>
							typeof entry?.id === "string" && typeof entry?.name === "string",
					) as NativeMacWindowSource[])
				: [];
		} catch (error) {
			const details = error as { stderr?: string; message?: string };
			lastNativeWindowListError =
				(details.stderr || details.message || String(error)).trim() || "unknown error";
			console.warn("[window-list] Native window listing failed:", lastNativeWindowListError);
			return [] as NativeMacWindowSource[];
		}
	}

	const maxAgeMs = options?.maxAgeMs ?? 5000;
	const now = Date.now();
	if (cachedNativeMacWindowSources && now - cachedNativeMacWindowSourcesAtMs < maxAgeMs) {
		return cachedNativeMacWindowSources;
	}

	try {
		const { stdout } = await runWindowListHelper([], {
			timeout: 30000,
			maxBuffer: 10 * 1024 * 1024,
		});

		const parsed = JSON.parse(stdout);
		if (!Array.isArray(parsed)) {
			return [] as NativeMacWindowSource[];
		}

		const entries = parsed.filter((entry: unknown): entry is NativeMacWindowSource => {
			if (!entry || typeof entry !== "object") {
				return false;
			}

			const candidate = entry as Partial<NativeMacWindowSource>;
			return typeof candidate.id === "string" && typeof candidate.name === "string";
		});

		setCachedNativeMacWindowSources(entries);
		setCachedNativeMacWindowSourcesAtMs(now);
		lastNativeWindowListError = null;
		return entries;
	} catch (error) {
		const details = error as { stderr?: string; message?: string };
		lastNativeWindowListError =
			(details.stderr || details.message || String(error)).trim() || "unknown error";
		console.warn("[window-list] Native window listing failed:", lastNativeWindowListError);
		return cachedNativeMacWindowSources ?? ([] as NativeMacWindowSource[]);
	}
}

export function getWindowBoundsFromNativeSource(
	source?: NativeMacWindowSource | null,
): WindowBounds | null {
	if (!source) {
		return null;
	}

	const { x, y, width, height } = source;
	if (
		typeof x !== "number" ||
		!Number.isFinite(x) ||
		typeof y !== "number" ||
		!Number.isFinite(y) ||
		typeof width !== "number" ||
		!Number.isFinite(width) ||
		typeof height !== "number" ||
		!Number.isFinite(height)
	) {
		return null;
	}

	if (width <= 0 || height <= 0) {
		return null;
	}

	return { x, y, width, height };
}

export async function resolveMacWindowBounds(source: SelectedSource): Promise<WindowBounds | null> {
	const windowId = parseWindowId(source.id);
	if (!windowId) {
		return null;
	}

	try {
		// Ask about this one window only. That path reads the window server
		// directly instead of ScreenCaptureKit, so polling it during a
		// recording never competes with the recorder's own requests.
		const nativeSources = await getNativeMacWindowSources({ ids: [windowId] });
		const matchedSource = nativeSources.find((entry) => parseWindowId(entry.id) === windowId);
		return getWindowBoundsFromNativeSource(matchedSource);
	} catch {
		return null;
	}
}

export function parseXwininfoBounds(stdout: string): WindowBounds | null {
	const absX = stdout.match(/Absolute upper-left X:\s+(-?\d+)/);
	const absY = stdout.match(/Absolute upper-left Y:\s+(-?\d+)/);
	const width = stdout.match(/Width:\s+(\d+)/);
	const height = stdout.match(/Height:\s+(\d+)/);

	if (!absX || !absY || !width || !height) {
		return null;
	}

	return {
		x: Number.parseInt(absX[1], 10),
		y: Number.parseInt(absY[1], 10),
		width: Number.parseInt(width[1], 10),
		height: Number.parseInt(height[1], 10),
	};
}

export async function resolveLinuxWindowBounds(
	source: SelectedSource,
): Promise<WindowBounds | null> {
	const windowId = parseWindowId(source?.id);

	if (windowId) {
		try {
			const { stdout } = await execFileAsync("xwininfo", ["-id", String(windowId)], {
				timeout: 1500,
			});
			const bounds = parseXwininfoBounds(stdout);
			if (bounds && bounds.width > 0 && bounds.height > 0) {
				return bounds;
			}
		} catch {
			// fall back to title lookup below
		}
	}

	const windowTitle =
		typeof source.windowTitle === "string" ? source.windowTitle.trim() : source.name.trim();
	if (!windowTitle) {
		return null;
	}

	try {
		const { stdout } = await execFileAsync("xwininfo", ["-name", windowTitle], {
			timeout: 1500,
		});
		const bounds = parseXwininfoBounds(stdout);
		return bounds && bounds.width > 0 && bounds.height > 0 ? bounds : null;
	} catch {
		return null;
	}
}

export function stopInteractionCapture() {
	if (interactionCaptureCleanup) {
		interactionCaptureCleanup();
		setInteractionCaptureCleanup(null);
	}
}

export function stopWindowBoundsCapture() {
	if (windowBoundsCaptureInterval) {
		clearInterval(windowBoundsCaptureInterval);
		setWindowBoundsCaptureInterval(null);
	}
	setSelectedWindowBounds(null);
}

async function refreshSelectedWindowBounds() {
	if (!selectedSource?.id?.startsWith("window:")) {
		setSelectedWindowBounds(null);
		return;
	}

	let bounds: WindowBounds | null = null;

	if (process.platform === "darwin") {
		bounds = await resolveMacWindowBounds(selectedSource);
	} else if (process.platform === "win32") {
		bounds = await resolveWindowsWindowBounds(selectedSource);
	} else if (process.platform === "linux") {
		bounds = await resolveLinuxWindowBounds(selectedSource);
	}

	setSelectedWindowBounds(bounds);
}

export function startWindowBoundsCapture() {
	stopWindowBoundsCapture();

	if (
		!["darwin", "win32", "linux"].includes(process.platform) ||
		!selectedSource?.id?.startsWith("window:")
	) {
		return;
	}

	void refreshSelectedWindowBounds();
	setWindowBoundsCaptureInterval(
		setInterval(() => {
			void refreshSelectedWindowBounds();
		}, 250),
	);
}
