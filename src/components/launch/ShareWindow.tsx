import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { AppWindowIcon, Check, MonitorIcon } from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import { useScopedT } from "@/contexts/I18nContext";
import { useMicrophoneDevices } from "@/hooks/useMicrophoneDevices";
import styles from "./ShareWindow.module.css";
import "./launchTheme.css";

type Intent = "record" | "select";
type NoiseChoice = "off" | "light" | "standard" | "strong" | "studio";
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
	const [selection, setSelection] = useState<Selection>(null);
	const [micChoice, setMicChoice] = useState<string>("off");
	const [savedMicId, setSavedMicId] = useState<string | undefined>();
	const [systemAudio, setSystemAudio] = useState(false);
	const [noise, setNoise] = useState<NoiseChoice>("strong");
	const [busy, setBusy] = useState(false);

	const { devices: microphones } = useMicrophoneDevices(true, savedMicId);

	const screens = useMemo(
		() => sources.filter((source) => source.id.startsWith("screen:")),
		[sources],
	);
	const windows = useMemo(
		() => sources.filter((source) => source.id.startsWith("window:")),
		[sources],
	);

	useEffect(() => {
		let active = true;
		void Promise.all([
			window.electronAPI.getSources({
				types: ["screen", "window"],
				thumbnailSize: { width: 352, height: 220 },
				fetchWindowIcons: true,
			}),
			window.electronAPI.getSelectedSource(),
			window.electronAPI.getRecordingPreferences(),
			window.electronAPI.getMicrophoneEnhancement(),
		])
			.then(([rawSources, current, prefs, enhancement]) => {
				if (!active) return;
				setSources(rawSources);

				// Start from what is already selected, falling back to the primary screen.
				const screenList = rawSources.filter((s) => s.id.startsWith("screen:"));
				const currentId = current?.id ?? "";
				if (currentId.startsWith("screen:") && screenList.some((s) => s.id === currentId)) {
					setSelection({ kind: "screen", id: currentId });
				} else if (currentId.startsWith("window:")) {
					setSelection({ kind: "windows", ids: [currentId] });
				} else if (currentId.startsWith("windows:")) {
					const wanted = new Set(currentId.slice("windows:".length).split(","));
					const ids = rawSources
						.filter((s) => s.id.startsWith("window:"))
						.filter((s) => wanted.has(String(windowNumber(s.id))))
						.map((s) => s.id);
					setSelection(ids.length > 0 ? { kind: "windows", ids } : null);
				} else {
					const primary =
						screenList.find((s) => s.name.includes("Primary")) ?? screenList[0];
					setSelection(primary ? { kind: "screen", id: primary.id } : null);
				}

				if (prefs?.success) {
					setSavedMicId(prefs.microphoneDeviceId);
					setMicChoice(
						prefs.microphoneEnabled ? (prefs.microphoneDeviceId ?? "default") : "off",
					);
					setSystemAudio(Boolean(prefs.systemAudioEnabled));
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
	}, []);

	// If the saved microphone is gone, fall back to the first available one.
	useEffect(() => {
		if (micChoice === "off" || microphones.length === 0) return;
		if (!microphones.some((device) => device.deviceId === micChoice)) {
			setMicChoice(microphones[0].deviceId);
		}
	}, [micChoice, microphones]);

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
								<MonitorIcon size={40} />
							) : (
								<AppWindowIcon size={40} />
							)}
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
				<h1 className={styles.title}>{t("share.title", "Choose what to record")}</h1>
				<p className={styles.subtitle}>
					{t(
						"share.subtitle",
						"Pick one screen, or tick several windows. Full-screen apps are listed too.",
					)}
				</p>
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
						{windows.length === 0 ? (
							<div className={styles.empty}>
								{t("recording.noSourcesFound", "No sources found")}
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
				<div className={styles.audio}>
					<label className={styles.field}>
						{t("share.microphone", "Microphone")}
						<select
							className={styles.select}
							value={micChoice}
							onChange={(event) => setMicChoice(event.target.value)}
						>
							<option value="off">{t("share.noMicrophone", "No microphone")}</option>
							{microphones.map((device) => (
								<option key={device.deviceId} value={device.deviceId}>
									{device.label}
								</option>
							))}
						</select>
					</label>
					{/* The switch renders its own label; passing the text as its children
					    makes the words clickable too, without nesting labels. */}
					<div className={styles.field}>
						<Switch checked={systemAudio} onCheckedChange={setSystemAudio}>
							<span className={styles.fieldText}>
								{t("share.systemAudio", "System audio")}
							</span>
						</Switch>
					</div>
					<label className={styles.field}>
						{t("share.noise", "Noise cancellation")}
						<select
							className={styles.select}
							value={noise}
							disabled={micChoice === "off"}
							onChange={(event) => setNoise(event.target.value as NoiseChoice)}
						>
							{NOISE_CHOICES.map((choice) => (
								<option key={choice} value={choice}>
									{t(`share.noise_${choice}`, choice)}
								</option>
							))}
						</select>
					</label>
				</div>
				<div className={styles.actions}>
					<span className={styles.summary}>{summary}</span>
					<Button variant="secondary" size="sm" onClick={cancel} disabled={busy}>
						{t("share.cancel", "Cancel")}
					</Button>
					<Button size="sm" onClick={() => void confirm()} disabled={!selection || busy}>
						{intent === "record"
							? t("share.startRecording", "Start recording")
							: t("share.select", "Select")}
					</Button>
				</div>
			</footer>
		</div>
	);
}

export default ShareWindow;
