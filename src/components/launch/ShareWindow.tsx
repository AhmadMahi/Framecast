import { useCallback, useEffect, useMemo, useState } from "react";
import {
	AppWindowIcon,
	ArrowClockwiseIcon,
	CaretDown,
	Check,
	MagicWand,
	MicrophoneIcon,
	MonitorIcon,
	SpeakerHighIcon,
	XIcon,
} from "@/components/ui/icons";
import { useScopedT } from "@/contexts/I18nContext";
import { useMicrophoneDevices } from "@/hooks/useMicrophoneDevices";
import styles from "./ShareWindow.module.css";
import "./launchTheme.css";

type Intent = "record" | "select";
type NoiseChoice = "off" | "light" | "standard" | "strong" | "studio";
type MicAccess = "unknown" | "granted" | "denied" | "restricted" | "not-determined";
type Selection = { kind: "screen"; id: string } | { kind: "windows"; ids: string[] } | null;

const NOISE_CHOICES: NoiseChoice[] = ["off", "light", "standard", "strong", "studio"];

function readIntent(): Intent {
	return new URLSearchParams(window.location.search).get("intent") === "select"
		? "select"
		: "record";
}

function windowNumber(sourceId: string): number | null {
	const value = Number.parseInt(sourceId.split(":")[1] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : null;
}

function mostCommon(values: string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const value of values) {
		if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	let best: string | undefined;
	let bestCount = 0;
	for (const [value, count] of counts) {
		if (count > bestCount) {
			best = value;
			bestCount = count;
		}
	}
	return best;
}

/** Drops the USB vendor/product suffix Chromium adds, e.g. "Mic (046d:0825)". */
function cleanMicName(label: string): string {
	return label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "").trim();
}

function fetchSources() {
	return window.electronAPI.getSources({
		types: ["screen", "window"],
		thumbnailSize: { width: 352, height: 220 },
		fetchWindowIcons: true,
	});
}

/** Restores whatever was chosen last, falling back to the primary screen. */
function initialSelection(sources: ProcessedDesktopSource[], currentId: string): Selection {
	const screens = sources.filter((s) => s.id.startsWith("screen:"));
	if (currentId.startsWith("screen:") && screens.some((s) => s.id === currentId)) {
		return { kind: "screen", id: currentId };
	}
	if (currentId.startsWith("window:") && sources.some((s) => s.id === currentId)) {
		return { kind: "windows", ids: [currentId] };
	}
	if (currentId.startsWith("windows:")) {
		const wanted = new Set(currentId.slice("windows:".length).split(","));
		const ids = sources
			.filter((s) => s.id.startsWith("window:"))
			.filter((s) => wanted.has(String(windowNumber(s.id))))
			.map((s) => s.id);
		if (ids.length > 0) return { kind: "windows", ids };
	}
	const primary = screens.find((s) => s.name.includes("Primary")) ?? screens[0];
	return primary ? { kind: "screen", id: primary.id } : null;
}

/**
 * Zoom-style chooser shown from the menu bar and the HUD's screen button. One
 * screen, or any number of windows (full-screen apps included), plus the audio
 * sources for the recording. Nothing is saved until the user confirms.
 */
export function ShareWindow() {
	const t = useScopedT("launch");
	const intent = useMemo(readIntent, []);
	const [sources, setSources] = useState<ProcessedDesktopSource[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [windowsBlocked, setWindowsBlocked] = useState(false);
	const [selection, setSelection] = useState<Selection>(null);
	const [micChoice, setMicChoice] = useState<string>("off");
	const [savedMicId, setSavedMicId] = useState<string | undefined>();
	const [systemAudio, setSystemAudio] = useState(false);
	const [noise, setNoise] = useState<NoiseChoice>("strong");
	const [busy, setBusy] = useState(false);
	const [micAccess, setMicAccess] = useState<MicAccess>("unknown");
	const [micRefresh, setMicRefresh] = useState(0);

	const { devices: microphones } = useMicrophoneDevices(true, savedMicId, micRefresh);

	/**
	 * Without microphone access Chromium lists one nameless device. Ask macOS
	 * (its own prompt, shown once), then list the microphones again by name.
	 */
	const ensureMicAccess = useCallback(async () => {
		try {
			const result = await window.electronAPI.requestMicrophoneAccess?.();
			if (!result) return;
			setMicAccess((result.status as MicAccess) ?? "unknown");
			if (result.status === "granted") setMicRefresh((value) => value + 1);
		} catch (error) {
			console.warn("Could not check microphone access:", error);
		}
	}, []);

	const micsUnnamed =
		microphones.length > 0 && microphones.every((device) => device.deviceId === "");
	const micBlocked = micAccess === "denied" || micAccess === "restricted";

	const screens = useMemo(
		() => sources.filter((source) => source.id.startsWith("screen:")),
		[sources],
	);
	const windows = useMemo(
		() => sources.filter((source) => source.id.startsWith("window:")),
		[sources],
	);

	/**
	 * An empty window list on macOS almost always means this copy of Framecast
	 * has no Screen & System Audio Recording permission yet. Say so plainly
	 * instead of claiming there are no windows.
	 */
	const checkWindowsBlocked = useCallback(async (list: ProcessedDesktopSource[]) => {
		if (list.some((source) => source.id.startsWith("window:"))) {
			setWindowsBlocked(false);
			return;
		}
		try {
			const [platform, permission, health] = await Promise.all([
				window.electronAPI.getPlatform(),
				window.electronAPI.getScreenRecordingPermissionStatus?.(),
				window.electronAPI.getWindowListHealth?.(),
			]);
			setWindowsBlocked(
				platform === "darwin" &&
					(Boolean(health?.error) ||
						(permission?.success === true && permission.status !== "granted")),
			);
		} catch {
			setWindowsBlocked(false);
		}
	}, []);

	useEffect(() => {
		let active = true;
		void Promise.all([
			fetchSources(),
			window.electronAPI.getSelectedSource(),
			window.electronAPI.getRecordingPreferences(),
			window.electronAPI.getMicrophoneEnhancement(),
		])
			.then(([rawSources, current, prefs, enhancement]) => {
				if (!active) return;
				setSources(rawSources);
				setSelection(initialSelection(rawSources, current?.id ?? ""));
				void checkWindowsBlocked(rawSources);

				if (prefs?.success) {
					setSavedMicId(prefs.microphoneDeviceId);
					setMicChoice(
						prefs.microphoneEnabled ? (prefs.microphoneDeviceId ?? "default") : "off",
					);
					setSystemAudio(Boolean(prefs.systemAudioEnabled));
					// The microphone is already on, so make sure it can be named and used.
					if (prefs.microphoneEnabled) void ensureMicAccess();
				}
				if (enhancement?.settings) {
					setNoise(
						enhancement.settings.noiseSuppression
							? enhancement.settings.noiseProfile
							: "off",
					);
				}
			})
			.catch((error) => console.error("Failed to load the share window:", error))
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [checkWindowsBlocked, ensureMicAccess]);

	const refresh = useCallback(async () => {
		setRefreshing(true);
		try {
			const rawSources = await fetchSources();
			setSources(rawSources);
			void checkWindowsBlocked(rawSources);
			// Keep the selection, minus anything that has since closed.
			setSelection((current) => {
				if (!current) return initialSelection(rawSources, "");
				if (current.kind === "screen") {
					return rawSources.some((s) => s.id === current.id)
						? current
						: initialSelection(rawSources, "");
				}
				const ids = current.ids.filter((id) => rawSources.some((s) => s.id === id));
				return ids.length > 0 ? { kind: "windows", ids } : initialSelection(rawSources, "");
			});
		} catch (error) {
			console.error("Failed to refresh sources:", error);
		} finally {
			setRefreshing(false);
		}
	}, [checkWindowsBlocked]);

	// If the saved microphone is gone, fall back to the first available one.
	useEffect(() => {
		if (micChoice === "off" || microphones.length === 0 || micsUnnamed) return;
		if (!microphones.some((device) => device.deviceId === micChoice)) {
			setMicChoice(microphones[0].deviceId);
		}
	}, [micChoice, microphones, micsUnnamed]);

	const toggleWindow = useCallback((id: string) => {
		setSelection((current) => {
			if (current?.kind !== "windows") return { kind: "windows", ids: [id] };
			const ids = current.ids.includes(id)
				? current.ids.filter((existing) => existing !== id)
				: [...current.ids, id];
			return ids.length > 0 ? { kind: "windows", ids } : null;
		});
	}, []);

	const summary = useMemo(() => {
		if (!selection) return t("share.nothingSelected", "Nothing selected");
		if (selection.kind === "screen") {
			return screens.find((s) => s.id === selection.id)?.name ?? "";
		}
		if (selection.ids.length === 1) {
			const only = windows.find((w) => w.id === selection.ids[0]);
			return only?.windowTitle || only?.name || "";
		}
		return t("share.windowCount", "{{count}} windows", { count: selection.ids.length });
	}, [selection, screens, windows, t]);

	/**
	 * One ordinary window keeps the stock tight window capture. A full-screen
	 * window or several windows record their screen Zoom-style, showing only
	 * the chosen windows.
	 */
	const buildSource = useCallback((): ProcessedDesktopSource | null => {
		if (!selection) return null;
		if (selection.kind === "screen") {
			return screens.find((s) => s.id === selection.id) ?? null;
		}

		const chosen = windows.filter((w) => selection.ids.includes(w.id));
		if (chosen.length === 0) return null;
		if (chosen.length === 1 && !chosen[0].isFullScreen) {
			return chosen[0];
		}

		const numbers = chosen
			.map((w) => windowNumber(w.id))
			.filter((n): n is number => n !== null);
		const primaryScreen = screens.find((s) => s.name.includes("Primary")) ?? screens[0];
		return {
			id: `windows:${numbers.join(",")}`,
			name:
				chosen.length === 1
					? chosen[0].windowTitle || chosen[0].name
					: t("share.windowCount", "{{count}} windows", { count: chosen.length }),
			display_id:
				mostCommon(chosen.map((w) => w.display_id)) ?? primaryScreen?.display_id ?? "",
			thumbnail: null,
			appIcon: null,
			sourceType: "screen",
		};
	}, [selection, screens, windows, t]);

	const cancel = useCallback(() => {
		void window.electronAPI.cancelShareWindow();
	}, []);

	const confirm = useCallback(async () => {
		const source = buildSource();
		if (!source || busy) return;
		setBusy(true);
		try {
			const microphoneEnabled = micChoice !== "off";
			const microphoneDeviceId =
				microphoneEnabled && micChoice !== "default" ? micChoice : undefined;
			await window.electronAPI.selectSource(source);
			await window.electronAPI.setRecordingPreferences({
				microphoneEnabled,
				microphoneDeviceId,
				systemAudioEnabled: systemAudio,
			});
			await window.electronAPI.setMicrophoneEnhancement(
				noise === "off"
					? { noiseSuppression: false }
					: { noiseSuppression: true, noiseProfile: noise },
			);
			await window.electronAPI.completeShareWindow({
				start: intent === "record",
				microphoneEnabled,
				microphoneDeviceId,
				systemAudioEnabled: systemAudio,
			});
		} catch (error) {
			console.error("Failed to apply share choices:", error);
			setBusy(false);
		}
	}, [buildSource, busy, intent, micChoice, noise, systemAudio]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") cancel();
			if (event.key === "Enter" && !event.isComposing) void confirm();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [cancel, confirm]);

	/** macOS lists the system default input as "Default - <name>". */
	const micOptionLabel = (device: { deviceId: string; label: string }) => {
		const name = cleanMicName(device.label);
		if (device.deviceId !== "default") return name;
		const actual = name.replace(/^Default\s*-\s*/i, "");
		return t("share.defaultMicrophoneNamed", "System default ({{name}})", { name: actual });
	};
	const chosenMic =
		micChoice === "off"
			? undefined
			: (microphones.find((device) => device.deviceId === micChoice) ??
				microphones.find((device) => device.deviceId === "default"));
	const micLabel =
		micChoice === "off"
			? t("share.noMicrophone", "No microphone")
			: chosenMic && chosenMic.deviceId !== ""
				? micOptionLabel(chosenMic)
				: t("share.defaultMicrophone", "System default");
	const noiseLabel = (choice: NoiseChoice) =>
		t(`share.noise_${choice}`, choice.charAt(0).toUpperCase() + choice.slice(1));

	const renderTile = (source: ProcessedDesktopSource, selected: boolean, onClick: () => void) => {
		const isScreen = source.id.startsWith("screen:");
		const title = isScreen ? source.name : source.windowTitle || source.name;
		return (
			<button
				key={source.id}
				type="button"
				className={`${styles.tile} ${selected ? styles.tileSelected : ""}`}
				aria-pressed={selected}
				title={title}
				onClick={onClick}
			>
				<div className={styles.thumb}>
					{source.thumbnail ? (
						<img src={source.thumbnail} alt="" className={styles.thumbImage} />
					) : (
						<div className={styles.thumbFallback}>
							{source.appIcon ? (
								<img
									src={source.appIcon}
									alt=""
									className={styles.thumbFallbackIcon}
								/>
							) : isScreen ? (
								<MonitorIcon size={36} />
							) : (
								<AppWindowIcon size={36} />
							)}
							{!isScreen && !source.isFullScreen ? (
								<span className={styles.thumbCaption}>
									{t("share.noPreview", "No preview while off screen")}
								</span>
							) : null}
						</div>
					)}
					{selected ? (
						<span className={styles.check}>
							<Check size={13} />
						</span>
					) : null}
					{source.isFullScreen ? (
						<span className={styles.badge}>{t("share.fullScreen", "Full screen")}</span>
					) : null}
				</div>
				<div className={styles.meta}>
					{!isScreen && source.appIcon ? (
						<img src={source.appIcon} alt="" className={styles.metaIcon} />
					) : null}
					<span className={styles.metaText}>
						{!isScreen && source.appName ? (
							<span className={styles.metaApp}>{source.appName} · </span>
						) : null}
						{title}
					</span>
				</div>
			</button>
		);
	};

	return (
		<div className={`${styles.window} launch-theme`}>
			<header className={styles.header}>
				<div className={styles.headerText}>
					<h1 className={styles.title}>{t("share.title", "Choose what to record")}</h1>
					<p className={styles.subtitle}>
						{t(
							"share.subtitle",
							"Pick one screen, or tick several windows. Full-screen apps are listed too.",
						)}
					</p>
				</div>
				<span className={styles.summary}>{summary}</span>
				<button
					type="button"
					className={styles.refresh}
					onClick={() => void refresh()}
					disabled={loading || refreshing}
				>
					<ArrowClockwiseIcon
						size={13}
						className={refreshing ? styles.refreshSpinning : undefined}
					/>
					{t("share.refresh", "Refresh")}
				</button>
				<button
					type="button"
					className={styles.close}
					onClick={cancel}
					aria-label={t("share.close", "Close")}
					title={t("share.close", "Close")}
				>
					<XIcon size={13} />
				</button>
			</header>

			<main className={styles.body}>
				{loading ? (
					<div className={styles.empty}>{t("share.loading", "Loading…")}</div>
				) : (
					<>
						<h2 className={styles.sectionLabel}>{t("share.screens", "Screens")}</h2>
						<div className={styles.grid}>
							{screens.map((source) =>
								renderTile(
									source,
									selection?.kind === "screen" && selection.id === source.id,
									() => setSelection({ kind: "screen", id: source.id }),
								),
							)}
						</div>

						<h2 className={styles.sectionLabel}>{t("share.windows", "Windows")}</h2>
						{windowsBlocked ? (
							<div className={styles.notice} role="alert">
								<div className={styles.noticeText}>
									<strong>
										{t(
											"share.permissionTitle",
											"Framecast can't see your windows yet",
										)}
									</strong>
									<span>
										{t(
											"share.permissionBody",
											"Turn on Framecast in System Settings › Privacy & Security › Screen & System Audio Recording, choose Quit & Reopen, then open this window again.",
										)}
									</span>
								</div>
								<button
									type="button"
									className={styles.secondaryButton}
									onClick={() =>
										void window.electronAPI.openScreenRecordingPreferences?.()
									}
								>
									{t("share.openSettings", "Open System Settings")}
								</button>
							</div>
						) : windows.length === 0 ? (
							<div className={styles.empty}>
								{t(
									"share.noWindows",
									"No open windows found. Open an app, then press Refresh.",
								)}
							</div>
						) : (
							<div className={styles.grid}>
								{windows.map((source) =>
									renderTile(
										source,
										selection?.kind === "windows" &&
											selection.ids.includes(source.id),
										() => toggleWindow(source.id),
									),
								)}
							</div>
						)}
					</>
				)}
			</main>

			<footer className={styles.footer}>
				<div className={styles.controls}>
					{micBlocked || micsUnnamed ? (
						<button
							type="button"
							className={`${styles.control} ${styles.controlAttention}`}
							onClick={() =>
								micBlocked
									? void window.electronAPI.openMicrophonePreferences?.()
									: void ensureMicAccess()
							}
						>
							<MicrophoneIcon size={17} className={styles.controlIcon} />
							<span className={styles.controlText}>
								<span className={styles.controlLabel}>
									{t("share.microphone", "Microphone")}
								</span>
								<span className={styles.controlValue}>
									{micBlocked
										? t("share.micBlocked", "Turn on access in Settings")
										: t("share.micAllow", "Allow access to list microphones")}
								</span>
							</span>
						</button>
					) : (
						<label className={styles.control}>
							<MicrophoneIcon size={17} className={styles.controlIcon} />
							<span className={styles.controlText}>
								<span className={styles.controlLabel}>
									{t("share.microphone", "Microphone")}
								</span>
								<span className={styles.controlValue} title={micLabel}>
									{micLabel}
								</span>
							</span>
							<CaretDown size={12} className={styles.controlCaret} />
							<select
								className={styles.controlSelect}
								aria-label={t("share.microphone", "Microphone")}
								value={micChoice}
								onChange={(event) => setMicChoice(event.target.value)}
							>
								<option value="off">
									{t("share.noMicrophone", "No microphone")}
								</option>
								{microphones.map((device) => (
									<option key={device.deviceId} value={device.deviceId}>
										{micOptionLabel(device)}
									</option>
								))}
							</select>
						</label>
					)}

					<button
						type="button"
						role="switch"
						aria-checked={systemAudio}
						className={`${styles.control} ${systemAudio ? styles.controlOn : ""}`}
						onClick={() => setSystemAudio((value) => !value)}
					>
						<SpeakerHighIcon size={17} className={styles.controlIcon} />
						<span className={styles.controlText}>
							<span className={styles.controlLabel}>
								{t("share.systemAudio", "System audio")}
							</span>
							<span className={styles.controlValue}>
								{systemAudio ? t("share.on", "On") : t("share.off", "Off")}
							</span>
						</span>
						<span className={styles.toggle} aria-hidden="true">
							<span className={styles.toggleKnob} />
						</span>
					</button>

					<label
						className={`${styles.control} ${micChoice === "off" ? styles.controlDisabled : ""}`}
					>
						<MagicWand size={17} className={styles.controlIcon} />
						<span className={styles.controlText}>
							<span className={styles.controlLabel}>
								{t("share.noise", "Noise cancellation")}
							</span>
							<span className={styles.controlValue}>
								{micChoice === "off"
									? t("share.needsMic", "Needs a microphone")
									: noiseLabel(noise)}
							</span>
						</span>
						<CaretDown size={12} className={styles.controlCaret} />
						<select
							className={styles.controlSelect}
							aria-label={t("share.noise", "Noise cancellation")}
							value={noise}
							disabled={micChoice === "off"}
							onChange={(event) => setNoise(event.target.value as NoiseChoice)}
						>
							{NOISE_CHOICES.map((choice) => (
								<option key={choice} value={choice}>
									{noiseLabel(choice)}
								</option>
							))}
						</select>
					</label>
				</div>

				<div className={styles.actions}>
					<button
						type="button"
						className={styles.secondaryButton}
						onClick={cancel}
						disabled={busy}
					>
						{t("share.cancel", "Cancel")}
					</button>
					<button
						type="button"
						className={styles.primaryButton}
						onClick={() => void confirm()}
						disabled={!selection || busy}
					>
						{intent === "record"
							? t("share.startRecording", "Start recording")
							: t("share.select", "Select")}
					</button>
				</div>
			</footer>
		</div>
	);
}

export default ShareWindow;
