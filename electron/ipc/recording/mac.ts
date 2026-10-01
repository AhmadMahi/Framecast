import { execFile } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { BrowserWindow } from "electron";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { getMacNativeMicFilters, type MicrophoneEnhancementSettings } from "./audioFilters";
import { readMicrophoneEnhancementSetting } from "../settings/microphoneEnhancement";
import {
	persistPendingCursorTelemetry,
	snapshotCursorTelemetryForPersistence,
} from "../cursor/telemetry";
import {
	lastNativeCaptureDiagnostics,
	nativeCaptureMicrophonePath,
	nativeCaptureOutputBuffer,
	nativeCaptureStopRequested,
	nativeCaptureSystemAudioPath,
	nativeCaptureTargetPath,
	nativeScreenRecordingActive,
	selectedSource,
	setCurrentProjectPath,
	setCurrentVideoPath,
	setNativeCaptureMicrophonePath,
	setNativeCaptureProcess,
	setNativeCaptureStopRequested,
	setNativeCaptureSystemAudioPath,
	setNativeCaptureTargetPath,
	setNativeScreenRecordingActive,
} from "../state";
import { moveFileWithOverwrite } from "../utils";
import {
	getFileSizeIfPresent,
	recordNativeCaptureDiagnostics,
	validateRecordedVideo,
} from "./diagnostics";
import { emitRecordingInterrupted } from "./events";
import { getFinalMacCompanionAudioPath } from "./macCompanionAudio";

const execFileAsync = promisify(execFile);

/**
 * ScreenCaptureKit writes the microphone track with no voice processing, so the
 * user's microphone enhancement settings are applied here instead. Failing the
 * pass leaves the untouched recording in place: a slightly noisier take beats
 * losing the audio entirely.
 */
async function applyMacNativeMicEnhancement(
	micPath: string,
	settings?: MicrophoneEnhancementSettings | null,
): Promise<void> {
	const filters = getMacNativeMicFilters(settings ?? readMicrophoneEnhancementSetting());
	if (filters.length === 0) {
		return;
	}

	const processedPath = `${micPath}.processed.m4a`;
	try {
		await execFileAsync(
			getFfmpegBinaryPath(),
			[
				"-y",
				"-hide_banner",
				"-nostdin",
				"-nostats",
				"-i",
				micPath,
				"-vn",
				"-af",
				filters.join(","),
				"-c:a",
				"aac",
				"-b:a",
				"192k",
				processedPath,
			],
			{ timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
		);

		const processedStat = await fs.stat(processedPath);
		if (processedStat.size <= 0) {
			throw new Error("Processed microphone track is empty");
		}

		await moveFileWithOverwrite(processedPath, micPath);
		console.log("[mac-mux] Applied microphone enhancement:", filters.join(","));
	} catch (error) {
		console.error("[mac-mux] Microphone enhancement failed, keeping raw audio:", error);
		await fs.rm(processedPath, { force: true }).catch(() => undefined);
	}
}

export function waitForNativeCaptureStart(process: ChildProcessWithoutNullStreams) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out waiting for ScreenCaptureKit recorder to start"));
		}, 12000);

		let stdoutBuffer = "";
		const onStdout = (chunk: Buffer) => {
			stdoutBuffer += chunk.toString();
			if (stdoutBuffer.includes("Recording started")) {
				cleanup();
				resolve();
			}
		};

		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};

		const onExit = (code: number | null) => {
			cleanup();
			reject(
				new Error(
					nativeCaptureOutputBuffer.trim() ||
						`Native capture helper exited before recording started (code ${code ?? "unknown"})`,
				),
			);
		};

		const cleanup = () => {
			clearTimeout(timer);
			process.stdout.off("data", onStdout);
			process.off("error", onError);
			process.off("exit", onExit);
		};

		process.stdout.on("data", onStdout);
		process.once("error", onError);
		process.once("exit", onExit);
	});
}

export function waitForNativeCaptureCommand(
	process: ChildProcessWithoutNullStreams,
	marker: "Recording paused" | "Recording resumed",
) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for ScreenCaptureKit helper: ${marker}`));
		}, 5000);

		let stdoutBuffer = "";
		const onStdout = (chunk: Buffer) => {
			stdoutBuffer += chunk.toString();
			if (stdoutBuffer.includes(marker)) {
				cleanup();
				resolve();
			}
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null) => {
			cleanup();
			reject(
				new Error(
					`Native capture helper exited before ${marker.toLowerCase()} (code ${code ?? "unknown"})`,
				),
			);
		};
		const cleanup = () => {
			clearTimeout(timer);
			process.stdout.off("data", onStdout);
			process.off("error", onError);
			process.off("exit", onExit);
		};

		process.stdout.on("data", onStdout);
		process.once("error", onError);
		process.once("exit", onExit);
	});
}

export function waitForNativeCaptureStop(process: ChildProcessWithoutNullStreams) {
	return new Promise<string>((resolve, reject) => {
		const onClose = (code: number | null) => {
			cleanup();
			const match = nativeCaptureOutputBuffer.match(/Recording stopped\. Output path: (.+)/);
			if (match?.[1]) {
				resolve(match[1].trim());
				return;
			}
			if (code === 0 && nativeCaptureTargetPath) {
				resolve(nativeCaptureTargetPath);
				return;
			}
			reject(
				new Error(
					nativeCaptureOutputBuffer.trim() ||
						`Native capture helper exited with code ${code ?? "unknown"}`,
				),
			);
		};

		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};

		const cleanup = () => {
			process.off("close", onClose);
			process.off("error", onError);
		};

		process.once("close", onClose);
		process.once("error", onError);
	});
}

export async function muxNativeMacRecordingWithAudio(
	videoPath: string,
	systemAudioPath?: string | null,
	microphonePath?: string | null,
	microphoneEnhancement?: MicrophoneEnhancementSettings | null,
) {
	console.log("[mac-mux] Optimization active: keeping tracks separate.");

	// Optimization: instead of heavy FFmpeg muxing, we ensure audio sidecars
	// are available alongside the video for the editor.
	if (systemAudioPath) {
		const finalSystemPath = getFinalMacCompanionAudioPath(videoPath, systemAudioPath, "system");
		try {
			const stat = await fs.stat(systemAudioPath);
			if (stat.size > 0 && systemAudioPath !== finalSystemPath) {
				await moveFileWithOverwrite(systemAudioPath, finalSystemPath);
			}
		} catch (err) {
			console.error(`[mac-mux] Failed to handle system audio:`, err);
		}
	}

	if (microphonePath) {
		const finalMicPath = getFinalMacCompanionAudioPath(videoPath, microphonePath, "mic");
		try {
			const stat = await fs.stat(microphonePath);
			if (stat.size > 0) {
				await applyMacNativeMicEnhancement(microphonePath, microphoneEnhancement);
				if (microphonePath !== finalMicPath) {
					await moveFileWithOverwrite(microphonePath, finalMicPath);
				}
			}
		} catch (err) {
			console.error(`[mac-mux] Failed to handle mic audio:`, err);
		}
	}
}

export function attachNativeCaptureLifecycle(process: ChildProcessWithoutNullStreams) {
	process.once("close", () => {
		const wasActive = nativeScreenRecordingActive;
		setNativeCaptureProcess(null);

		if (!wasActive || nativeCaptureStopRequested) {
			return;
		}

		setNativeScreenRecordingActive(false);
		console.log("[mac-finalize] Optimization active: skipping safety-net muxing.");
		setNativeCaptureTargetPath(null);
		setNativeCaptureStopRequested(false);
		setNativeCaptureSystemAudioPath(null);
		setNativeCaptureMicrophonePath(null);

		const sourceName = selectedSource?.name ?? "Screen";
		BrowserWindow.getAllWindows().forEach((window) => {
			if (!window.isDestroyed()) {
				window.webContents.send("recording-state-changed", {
					recording: false,
					sourceName,
				});
			}
		});

		const reason = nativeCaptureOutputBuffer.includes("WINDOW_UNAVAILABLE")
			? "window-unavailable"
			: "capture-stopped";
		const message =
			reason === "window-unavailable"
				? "The selected window is no longer capturable. Please reselect a window."
				: "Recording stopped unexpectedly.";

		emitRecordingInterrupted(reason, message);
	});
}

export async function finalizeStoredVideo(videoPath: string) {
	console.log("[finalize] Optimization active: skipping safety-net muxing.");

	let validation: { fileSizeBytes: number; durationSeconds: number | null };
	try {
		validation = await validateRecordedVideo(videoPath);
	} catch (error) {
		if (
			lastNativeCaptureDiagnostics?.backend === "mac-screencapturekit" ||
			lastNativeCaptureDiagnostics?.backend === "windows-wgc"
		) {
			recordNativeCaptureDiagnostics({
				backend: lastNativeCaptureDiagnostics.backend,
				phase: lastNativeCaptureDiagnostics.phase === "mux" ? "mux" : "stop",
				sourceId: lastNativeCaptureDiagnostics.sourceId ?? null,
				sourceType: lastNativeCaptureDiagnostics.sourceType ?? "unknown",
				displayId: lastNativeCaptureDiagnostics.displayId ?? null,
				displayBounds: lastNativeCaptureDiagnostics.displayBounds ?? null,
				windowHandle: lastNativeCaptureDiagnostics.windowHandle ?? null,
				helperPath: lastNativeCaptureDiagnostics.helperPath ?? null,
				outputPath: videoPath,
				systemAudioPath: lastNativeCaptureDiagnostics.systemAudioPath ?? null,
				microphonePath: lastNativeCaptureDiagnostics.microphonePath ?? null,
				osRelease: lastNativeCaptureDiagnostics.osRelease,
				supported: lastNativeCaptureDiagnostics.supported,
				helperExists: lastNativeCaptureDiagnostics.helperExists,
				processOutput: lastNativeCaptureDiagnostics.processOutput,
				fileSizeBytes: await getFileSizeIfPresent(videoPath),
				error: error instanceof Error ? error.message : String(error),
			});
		}
		throw error;
	}

	snapshotCursorTelemetryForPersistence();
	setCurrentVideoPath(videoPath);
	setCurrentProjectPath(null);
	try {
		await persistPendingCursorTelemetry(videoPath);
	} catch (error) {
		console.warn("[mac-stop] Failed to persist cursor telemetry:", error);
	}

	if (
		lastNativeCaptureDiagnostics?.backend === "mac-screencapturekit" ||
		lastNativeCaptureDiagnostics?.backend === "windows-wgc"
	) {
		recordNativeCaptureDiagnostics({
			backend: lastNativeCaptureDiagnostics.backend,
			phase: lastNativeCaptureDiagnostics.phase === "mux" ? "mux" : "stop",
			sourceId: lastNativeCaptureDiagnostics.sourceId ?? null,
			sourceType: lastNativeCaptureDiagnostics.sourceType ?? "unknown",
			displayId: lastNativeCaptureDiagnostics.displayId ?? null,
			displayBounds: lastNativeCaptureDiagnostics.displayBounds ?? null,
			windowHandle: lastNativeCaptureDiagnostics.windowHandle ?? null,
			helperPath: lastNativeCaptureDiagnostics.helperPath ?? null,
			outputPath: videoPath,
			systemAudioPath: lastNativeCaptureDiagnostics.systemAudioPath ?? null,
			microphonePath: lastNativeCaptureDiagnostics.microphonePath ?? null,
			osRelease: lastNativeCaptureDiagnostics.osRelease,
			supported: lastNativeCaptureDiagnostics.supported,
			helperExists: lastNativeCaptureDiagnostics.helperExists,
			processOutput: lastNativeCaptureDiagnostics.processOutput,
			fileSizeBytes: validation.fileSizeBytes,
		});
	}

	return {
		success: true,
		path: videoPath,
		message:
			validation.durationSeconds !== null
				? `Video stored successfully (${validation.fileSizeBytes} bytes, ${validation.durationSeconds.toFixed(2)}s)`
				: `Video stored successfully`,
	};
}

export async function recoverNativeMacCaptureOutput() {
	const macDiagnostics =
		lastNativeCaptureDiagnostics?.backend === "mac-screencapturekit"
			? lastNativeCaptureDiagnostics
			: null;
	const diagnosticsPath = macDiagnostics?.outputPath ?? null;
	const candidatePath = nativeCaptureTargetPath ?? diagnosticsPath;
	const systemAudioPath = nativeCaptureSystemAudioPath ?? macDiagnostics?.systemAudioPath ?? null;
	const microphonePath = nativeCaptureMicrophonePath ?? macDiagnostics?.microphonePath ?? null;

	if (!candidatePath) {
		return null;
	}

	try {
		if (systemAudioPath || microphonePath) {
			try {
				await muxNativeMacRecordingWithAudio(
					candidatePath,
					systemAudioPath,
					microphonePath,
				);
			} catch (muxError) {
				console.warn("Failed to mux audio during recovery:", muxError);
			}
		}

		return await finalizeStoredVideo(candidatePath);
	} catch (error) {
		recordNativeCaptureDiagnostics({
			backend: "mac-screencapturekit",
			phase: "stop",
			outputPath: candidatePath,
			systemAudioPath,
			microphonePath,
			processOutput: nativeCaptureOutputBuffer.trim() || undefined,
			fileSizeBytes: await getFileSizeIfPresent(candidatePath),
			error: String(error),
		});
		return null;
	}
}
