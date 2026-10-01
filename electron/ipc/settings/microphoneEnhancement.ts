import { readAppSetting, writeAppSetting } from "../../appSettingsStore";
import {
	DEFAULT_MICROPHONE_ENHANCEMENT,
	type MicrophoneEnhancementSettings,
	normalizeMicrophoneEnhancement,
} from "../recording/audioFilters";

export const MICROPHONE_ENHANCEMENT_SETTING_KEY = "microphoneEnhancement";

export function readMicrophoneEnhancementSetting(): MicrophoneEnhancementSettings {
	try {
		return normalizeMicrophoneEnhancement(readAppSetting(MICROPHONE_ENHANCEMENT_SETTING_KEY));
	} catch {
		return { ...DEFAULT_MICROPHONE_ENHANCEMENT };
	}
}

export function writeMicrophoneEnhancementSetting(
	patch: Partial<MicrophoneEnhancementSettings>,
): MicrophoneEnhancementSettings {
	const next = normalizeMicrophoneEnhancement(
		{ ...readMicrophoneEnhancementSetting(), ...patch },
		readMicrophoneEnhancementSetting(),
	);
	writeAppSetting(MICROPHONE_ENHANCEMENT_SETTING_KEY, next);
	return next;
}
