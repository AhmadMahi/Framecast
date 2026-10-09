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

export function getBrowserMicSidecarFilters(
	profile?: string | null,
	noiseProfile?: MicrophoneNoiseProfile | null,
	options: NoiseFilterOptions = {},
) {
	// With a noise profile the denoise stage follows the user's choice; without
	// one the legacy chain stays byte-for-byte the same.
	const base = noiseProfile
		? noiseProfile === "off"
			? ["adeclip=threshold=1", "adeclick=w=40:o=75:t=3:b=2"]
			: getNoiseSuppressionFilters(noiseProfile, options)
		: BROWSER_MIC_SIDECAR_BASE_FILTERS;

	if (profile === "no-agc") {
		return [...base, ...BROWSER_MIC_SIDECAR_NO_AGC_GAIN_FILTERS];
	}

	return [...base, "alimiter=limit=0.92:level=0"];
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
/**
 * How hard the spectral denoiser works. Measured on synthesized speech mixed
 * with pink, white and brown noise (50 ms frames, noise floor in the clean
 * file's silent gaps vs. speech level in its loud frames):
 *
 *   light    afftdn nr=20   fan -3.7 dB  hiss  -5.4 dB  speech -0.7..-1.1 dB
 *   standard afftdn nr=30   fan -5.4 dB  hiss  -8.7 dB  speech -0.8..-1.4 dB
 *   strong   afftdn nr=40   fan -8.1 dB  hiss -16.1 dB  speech -1.0..-1.6 dB
 *
 * Strong wins on every noise type for a fraction of a dB more speech loss, so
 * it is the default. Low rumble that overlaps voice fundamentals moves only
 * ~2 dB in every profile; no spectral method can remove it without hurting
 * the voice, and the 85 Hz high-pass already takes the sub-bass part.
 */
export type MicrophoneNoiseProfile = "off" | "light" | "standard" | "strong" | "studio";

export const MICROPHONE_NOISE_PROFILES: MicrophoneNoiseProfile[] = [
	"off",
	"light",
	"standard",
	"strong",
	"studio",
];

/** Runtime inputs the filter builder cannot know on its own. */
export interface NoiseFilterOptions {
	/** Absolute path to the bundled RNNoise model; null when it is unavailable. */
	rnnoiseModelPath?: string | null;
}

/**
 * Escapes a value for use inside an ffmpeg filter option (`key=value`), where
 * backslash, colon and single quote are structural characters.
 */
export function escapeFilterOptionValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export const DEFAULT_MICROPHONE_NOISE_PROFILE: MicrophoneNoiseProfile = "strong";

export interface MicrophoneEnhancementSettings {
	noiseSuppression: boolean;
	echoCancellation: boolean;
	autoGainControl: boolean;
	noiseProfile: MicrophoneNoiseProfile;
}

export const DEFAULT_MICROPHONE_ENHANCEMENT: MicrophoneEnhancementSettings = {
	noiseSuppression: true,
	echoCancellation: true,
	autoGainControl: false,
	noiseProfile: DEFAULT_MICROPHONE_NOISE_PROFILE,
};

export function normalizeMicrophoneNoiseProfile(
	value: unknown,
	fallback: MicrophoneNoiseProfile = DEFAULT_MICROPHONE_NOISE_PROFILE,
): MicrophoneNoiseProfile {
	return typeof value === "string" &&
		(MICROPHONE_NOISE_PROFILES as string[]).includes(value.toLowerCase())
		? (value.toLowerCase() as MicrophoneNoiseProfile)
		: fallback;
}

export function normalizeMicrophoneEnhancement(
	value: unknown,
	fallback: MicrophoneEnhancementSettings = DEFAULT_MICROPHONE_ENHANCEMENT,
): MicrophoneEnhancementSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ...fallback };
	}

	const raw = value as Partial<Record<keyof MicrophoneEnhancementSettings, unknown>>;
	type SwitchKey = "noiseSuppression" | "echoCancellation" | "autoGainControl";
	const pick = (key: SwitchKey): boolean =>
		typeof raw[key] === "boolean" ? (raw[key] as boolean) : fallback[key];

	return {
		noiseSuppression: pick("noiseSuppression"),
		echoCancellation: pick("echoCancellation"),
		autoGainControl: pick("autoGainControl"),
		noiseProfile: normalizeMicrophoneNoiseProfile(raw.noiseProfile, fallback.noiseProfile),
	};
}

/**
 * The denoise stage for each classic profile; `off` has none. `studio` is the
 * RNNoise neural suppressor and is built from the model path at call time.
 */
export const MICROPHONE_NOISE_PROFILE_DENOISE: Record<
	Exclude<MicrophoneNoiseProfile, "studio">,
	string | null
> = {
	off: null,
	light: "afftdn=nr=20:nf=-40:tn=1",
	standard: "afftdn=nr=30:nf=-35:tn=1",
	strong: "afftdn=nr=40:nf=-30:tn=1:om=o",
};

/** Shared clean-up stages that precede the denoiser on every profile. */
export const MICROPHONE_NOISE_PRE_FILTERS = [
	"adeclip=threshold=1",
	"adeclick=w=40:o=75:t=3:b=2",
	"highpass=f=85",
	"lowpass=f=9500",
];

export function getNoiseSuppressionFilters(
	profile: MicrophoneNoiseProfile = DEFAULT_MICROPHONE_NOISE_PROFILE,
	options: NoiseFilterOptions = {},
): string[] {
	if (profile === "studio") {
		// Without the model the strongest classic chain is the honest fallback.
		if (!options.rnnoiseModelPath) {
			return getNoiseSuppressionFilters("strong", options);
		}
		return [
			...MICROPHONE_NOISE_PRE_FILTERS,
			`arnndn=m=${escapeFilterOptionValue(options.rnnoiseModelPath)}:mix=1`,
		];
	}

	const denoise = MICROPHONE_NOISE_PROFILE_DENOISE[profile];
	return denoise ? [...MICROPHONE_NOISE_PRE_FILTERS, denoise] : [];
}

/**
 * ScreenCaptureKit hands back the raw microphone feed with no voice processing,
 * so macOS native recordings need the denoise pass applied offline. Mirrors the
 * browser sidecar chain: declick, band-limit to speech, spectral denoise, then
 * keep the result inside a safe ceiling.
 */
export const MAC_NATIVE_MIC_NOISE_SUPPRESSION_FILTERS = getNoiseSuppressionFilters(
	DEFAULT_MICROPHONE_NOISE_PROFILE,
);

export const MAC_NATIVE_MIC_GAIN_FILTERS = ["speechnorm=p=0.92:e=12:c=2:r=0.0005:f=0.001"];

export const MAC_NATIVE_MIC_LIMITER_FILTERS = ["alimiter=limit=0.92:level=0"];

/**
 * Returns the ffmpeg audio filters for a macOS native microphone track, or an
 * empty array when the user has turned every enhancement off and the recording
 * should stay untouched.
 */
export function getMacNativeMicFilters(
	settings: MicrophoneEnhancementSettings = DEFAULT_MICROPHONE_ENHANCEMENT,
	options: NoiseFilterOptions = {},
): string[] {
	const filters: string[] = [];

	if (settings.noiseSuppression) {
		filters.push(
			...getNoiseSuppressionFilters(
				settings.noiseProfile ?? DEFAULT_MICROPHONE_NOISE_PROFILE,
				options,
			),
		);
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
