import { describe, expect, it } from "vitest";

import {
	BROWSER_MIC_SIDECAR_FILTERS,
	BROWSER_MIC_SIDECAR_NO_AGC_GAIN_FILTERS,
	DEFAULT_MICROPHONE_ENHANCEMENT,
	getBrowserMicrophoneProfileForEnhancement,
	getBrowserMicSidecarFilters,
	getMacNativeMicFilters,
	MAC_NATIVE_MIC_GAIN_FILTERS,
	MAC_NATIVE_MIC_LIMITER_FILTERS,
	MAC_NATIVE_MIC_NOISE_SUPPRESSION_FILTERS,
	normalizeMicrophoneEnhancement,
	RECORDING_AUDIO_SIDECAR_DEBUG_ENV,
	shouldKeepRecordingAudioSidecars,
	WINDOWS_NATIVE_MIC_PRE_FILTERS,
} from "./audioFilters";

describe("Windows native mic pre-filter policy", () => {
	it("keeps repair filters without automatic gain or loudness normalization", () => {
		expect(WINDOWS_NATIVE_MIC_PRE_FILTERS).toContain("adeclip=threshold=1");
		expect(
			WINDOWS_NATIVE_MIC_PRE_FILTERS.some((filter) =>
				/(^|,)(loudnorm|dynaudnorm|volume)=/i.test(filter),
			),
		).toBe(false);
	});

	it("keeps native audio sidecars only when explicitly requested", () => {
		expect(shouldKeepRecordingAudioSidecars({})).toBe(false);
		expect(
			shouldKeepRecordingAudioSidecars({
				[RECORDING_AUDIO_SIDECAR_DEBUG_ENV]: "1",
			}),
		).toBe(true);
		expect(
			shouldKeepRecordingAudioSidecars({
				[RECORDING_AUDIO_SIDECAR_DEBUG_ENV]: "true",
			}),
		).toBe(true);
		expect(
			shouldKeepRecordingAudioSidecars({
				[RECORDING_AUDIO_SIDECAR_DEBUG_ENV]: "off",
			}),
		).toBe(false);
	});
});

describe("browser microphone sidecar post-processing", () => {
	it("keeps the browser fallback chain conservative and speech-oriented", () => {
		expect(BROWSER_MIC_SIDECAR_FILTERS).toEqual([
			"adeclip=threshold=1",
			"adeclick=w=40:o=75:t=3:b=2",
			"highpass=f=85",
			"lowpass=f=9500",
			"afftdn=nr=10:nf=-45:tn=1",
			"alimiter=limit=0.92:level=0",
		]);
		expect(
			BROWSER_MIC_SIDECAR_FILTERS.some((filter) =>
				/(^|,)(loudnorm|dynaudnorm|volume)=/i.test(filter),
			),
		).toBe(false);
	});

	it("adds bounded speech gain only for the no-AGC browser mic profile", () => {
		expect(getBrowserMicSidecarFilters("processed")).toEqual(BROWSER_MIC_SIDECAR_FILTERS);
		expect(getBrowserMicSidecarFilters("no-agc")).toEqual([
			"adeclip=threshold=1",
			"adeclick=w=40:o=75:t=3:b=2",
			"highpass=f=85",
			"lowpass=f=9500",
			"afftdn=nr=10:nf=-45:tn=1",
			...BROWSER_MIC_SIDECAR_NO_AGC_GAIN_FILTERS,
		]);
		expect(BROWSER_MIC_SIDECAR_NO_AGC_GAIN_FILTERS).toContain(
			"speechnorm=p=0.92:e=12:c=2:r=0.0005:f=0.001",
		);
		expect(BROWSER_MIC_SIDECAR_NO_AGC_GAIN_FILTERS).toContain("alimiter=limit=0.92:level=0");
	});
});

describe("microphone enhancement settings", () => {
	it("falls back to the defaults for malformed stored values", () => {
		expect(normalizeMicrophoneEnhancement(null)).toEqual(DEFAULT_MICROPHONE_ENHANCEMENT);
		expect(normalizeMicrophoneEnhancement("processed")).toEqual(DEFAULT_MICROPHONE_ENHANCEMENT);
		expect(normalizeMicrophoneEnhancement([true])).toEqual(DEFAULT_MICROPHONE_ENHANCEMENT);
	});

	it("keeps stored switches and fills only the missing ones", () => {
		expect(normalizeMicrophoneEnhancement({ noiseSuppression: false })).toEqual({
			noiseSuppression: false,
			echoCancellation: DEFAULT_MICROPHONE_ENHANCEMENT.echoCancellation,
			autoGainControl: DEFAULT_MICROPHONE_ENHANCEMENT.autoGainControl,
		});
	});

	it("ignores non-boolean switch values", () => {
		expect(normalizeMicrophoneEnhancement({ noiseSuppression: "yes" })).toEqual(
			DEFAULT_MICROPHONE_ENHANCEMENT,
		);
	});
});

describe("macOS native mic filters", () => {
	it("records untouched audio when every enhancement is off", () => {
		expect(
			getMacNativeMicFilters({
				noiseSuppression: false,
				echoCancellation: false,
				autoGainControl: false,
			}),
		).toEqual([]);
	});

	it("applies denoise and a limiter when noise suppression is on", () => {
		const filters = getMacNativeMicFilters({
			noiseSuppression: true,
			echoCancellation: true,
			autoGainControl: false,
		});

		expect(filters).toEqual([
			...MAC_NATIVE_MIC_NOISE_SUPPRESSION_FILTERS,
			...MAC_NATIVE_MIC_LIMITER_FILTERS,
		]);
		expect(filters.some((filter) => filter.startsWith("afftdn="))).toBe(true);
		expect(filters.some((filter) => filter.startsWith("speechnorm="))).toBe(false);
	});

	it("adds speech levelling only when auto level is on", () => {
		const filters = getMacNativeMicFilters({
			noiseSuppression: true,
			echoCancellation: true,
			autoGainControl: true,
		});

		expect(filters).toEqual([
			...MAC_NATIVE_MIC_NOISE_SUPPRESSION_FILTERS,
			...MAC_NATIVE_MIC_GAIN_FILTERS,
			...MAC_NATIVE_MIC_LIMITER_FILTERS,
		]);
	});

	it("still limits the output when only auto level is on", () => {
		expect(
			getMacNativeMicFilters({
				noiseSuppression: false,
				echoCancellation: false,
				autoGainControl: true,
			}),
		).toEqual([...MAC_NATIVE_MIC_GAIN_FILTERS, ...MAC_NATIVE_MIC_LIMITER_FILTERS]);
	});

	it("never applies automatic loudness normalization", () => {
		const filters = getMacNativeMicFilters(DEFAULT_MICROPHONE_ENHANCEMENT);
		expect(filters.some((filter) => /^(loudnorm|dynaudnorm|volume)=/i.test(filter))).toBe(
			false,
		);
	});
});

describe("browser microphone profile mapping", () => {
	it("keeps full processing when every enhancement is on", () => {
		expect(
			getBrowserMicrophoneProfileForEnhancement({
				noiseSuppression: true,
				echoCancellation: true,
				autoGainControl: true,
			}),
		).toBe("processed");
	});

	it("bypasses all voice processing when every enhancement is off", () => {
		expect(
			getBrowserMicrophoneProfileForEnhancement({
				noiseSuppression: false,
				echoCancellation: false,
				autoGainControl: false,
			}),
		).toBe("raw");
	});

	it("maps each disabled switch onto its profile", () => {
		expect(
			getBrowserMicrophoneProfileForEnhancement({
				noiseSuppression: false,
				echoCancellation: true,
				autoGainControl: true,
			}),
		).toBe("no-noise-suppression");
		expect(
			getBrowserMicrophoneProfileForEnhancement({
				noiseSuppression: true,
				echoCancellation: false,
				autoGainControl: true,
			}),
		).toBe("no-echo");
		expect(
			getBrowserMicrophoneProfileForEnhancement({
				noiseSuppression: true,
				echoCancellation: true,
				autoGainControl: false,
			}),
		).toBe("no-agc");
	});

	it("produces a profile the recorder recognizes", () => {
		const known = new Set(["processed", "no-agc", "no-echo", "no-noise-suppression", "raw"]);
		for (const noiseSuppression of [true, false]) {
			for (const echoCancellation of [true, false]) {
				for (const autoGainControl of [true, false]) {
					expect(
						known.has(
							getBrowserMicrophoneProfileForEnhancement({
								noiseSuppression,
								echoCancellation,
								autoGainControl,
							}),
						),
					).toBe(true);
				}
			}
		}
	});
});
