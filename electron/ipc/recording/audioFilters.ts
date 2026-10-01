// Keep native mic capture dry by default. Automatic loudness normalization
// amplified wireless-headset noise and WASAPI discontinuities during beta tests.
export const WINDOWS_NATIVE_MIC_PRE_FILTERS = ["adeclip=threshold=1"];

// Browser mic fallback uses Chromium/WebRTC voice processing, but beta tests
// showed its realtime AGC can introduce short crackle bursts on some Realtek
// and headset paths. Default to no AGC, then restore usable level offline with
// bounded speech expansion and a limiter.
export const BROWSER_MIC_SIDECAR_BASE_FILTERS = [
	"adeclip=threshold=1",
	"adeclick=w=40:o=75:t=3:b=2",
	"highpass=f=85",
	"lowpass=f=9500",
	"afftdn=nr=10:nf=-45:tn=1",
];

export const BROWSER_MIC_SIDECAR_NO_AGC_GAIN_FILTERS = [
	"speechnorm=p=0.92:e=12:c=2:r=0.0005:f=0.001",
	"alimiter=limit=0.92:level=0",
];

export const BROWSER_MIC_SIDECAR_FILTERS = [
	...BROWSER_MIC_SIDECAR_BASE_FILTERS,
	"alimiter=limit=0.92:level=0",
];

export function getBrowserMicSidecarFilters(profile?: string | null) {
	if (profile === "no-agc") {
		return [...BROWSER_MIC_SIDECAR_BASE_FILTERS, ...BROWSER_MIC_SIDECAR_NO_AGC_GAIN_FILTERS];
	}

	return BROWSER_MIC_SIDECAR_FILTERS;
}

export const RECORDING_AUDIO_SIDECAR_DEBUG_ENV = "RECORDLY_KEEP_RECORDING_AUDIO_SIDECARS"; // not used yet, because we need to have seperate audio files for system and mic for each recording

export function shouldKeepRecordingAudioSidecars(env: NodeJS.ProcessEnv = process.env) {
	const value = env[RECORDING_AUDIO_SIDECAR_DEBUG_ENV]?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Microphone enhancement is stored as three independent switches so the UI can
 * expose them in plain language. They map onto the browser capture constraints
 * and, on macOS native capture, onto an offline ffmpeg pass.
 */
export interface MicrophoneEnhancementSettings {
	noiseSuppression: boolean;
	echoCancellation: boolean;
	autoGainControl: boolean;
}

export const DEFAULT_MICROPHONE_ENHANCEMENT: MicrophoneEnhancementSettings = {
	noiseSuppression: true,
	echoCancellation: true,
	autoGainControl: false,
};

export function normalizeMicrophoneEnhancement(
	value: unknown,
	fallback: MicrophoneEnhancementSettings = DEFAULT_MICROPHONE_ENHANCEMENT,
): MicrophoneEnhancementSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ...fallback };
	}

	const raw = value as Partial<Record<keyof MicrophoneEnhancementSettings, unknown>>;
	const pick = (key: keyof MicrophoneEnhancementSettings) =>
		typeof raw[key] === "boolean" ? (raw[key] as boolean) : fallback[key];

	return {
		noiseSuppression: pick("noiseSuppression"),
		echoCancellation: pick("echoCancellation"),
		autoGainControl: pick("autoGainControl"),
	};
}

/**
 * ScreenCaptureKit hands back the raw microphone feed with no voice processing,
 * so macOS native recordings need the denoise pass applied offline. Mirrors the
 * browser sidecar chain: declick, band-limit to speech, spectral denoise, then
 * keep the result inside a safe ceiling.
 */
export const MAC_NATIVE_MIC_NOISE_SUPPRESSION_FILTERS = [
	"adeclip=threshold=1",
	"adeclick=w=40:o=75:t=3:b=2",
	"highpass=f=85",
	"lowpass=f=9500",
	"afftdn=nr=12:nf=-45:tn=1",
];

export const MAC_NATIVE_MIC_GAIN_FILTERS = ["speechnorm=p=0.92:e=12:c=2:r=0.0005:f=0.001"];

export const MAC_NATIVE_MIC_LIMITER_FILTERS = ["alimiter=limit=0.92:level=0"];

/**
 * Returns the ffmpeg audio filters for a macOS native microphone track, or an
 * empty array when the user has turned every enhancement off and the recording
 * should stay untouched.
 */
export function getMacNativeMicFilters(
	settings: MicrophoneEnhancementSettings = DEFAULT_MICROPHONE_ENHANCEMENT,
): string[] {
	const filters: string[] = [];

	if (settings.noiseSuppression) {
		filters.push(...MAC_NATIVE_MIC_NOISE_SUPPRESSION_FILTERS);
	}

	if (settings.autoGainControl) {
		filters.push(...MAC_NATIVE_MIC_GAIN_FILTERS);
	}

	if (filters.length > 0) {
		filters.push(...MAC_NATIVE_MIC_LIMITER_FILTERS);
	}

	return filters;
}

/**
 * Maps the three switches onto the browser capture profile names that already
 * drive `createProcessedMicrophoneConstraints` and the sidecar filter chain.
 */
export function getBrowserMicrophoneProfileForEnhancement(
	settings: MicrophoneEnhancementSettings = DEFAULT_MICROPHONE_ENHANCEMENT,
): string {
	if (!settings.noiseSuppression && !settings.echoCancellation && !settings.autoGainControl) {
		return "raw";
	}

	if (!settings.noiseSuppression) {
		return "no-noise-suppression";
	}

	if (!settings.echoCancellation) {
		return "no-echo";
	}

	if (!settings.autoGainControl) {
		return "no-agc";
	}

	return "processed";
}
