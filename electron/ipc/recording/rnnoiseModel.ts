import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

/**
 * The RNNoise model behind the "Studio" noise profile. Ships as an extra
 * resource (not inside the asar) because ffmpeg has to open it by path.
 */
export const RNNOISE_MODEL_FILE = "sh.rnnn";

export function getRnnoiseModelCandidates(): string[] {
	const relative = ["models", "rnnoise", RNNOISE_MODEL_FILE];
	if (app.isPackaged) {
		return [path.join(process.resourcesPath, "assets", ...relative)];
	}

	return [path.join(app.getAppPath(), "electron", "native", ...relative)];
}

let cachedModelPath: string | null | undefined;

/** Absolute path to the bundled model, or null when this build lacks it. */
export function resolveRnnoiseModelPath(): string | null {
	if (cachedModelPath !== undefined) {
		return cachedModelPath;
	}

	cachedModelPath = null;
	for (const candidate of getRnnoiseModelCandidates()) {
		try {
			if (fs.statSync(candidate).size > 0) {
				cachedModelPath = candidate;
				break;
			}
		} catch {
			// Try the next location.
		}
	}

	return cachedModelPath;
}
