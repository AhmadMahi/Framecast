import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	AppWindowIcon,
	CaretDown,
	CaretUpIcon,
	Check,
	FolderOpenIcon,
	MicrophoneIcon,
	MonitorIcon,
	SpeakerHighIcon,
	TimerIcon,
	VideoCameraIcon,
} from "@/components/ui/icons";
import { useScopedT } from "@/contexts/I18nContext";
import { useMicrophoneDevices } from "@/hooks/useMicrophoneDevices";
import { useVideoDevices } from "@/hooks/useVideoDevices";
import { mapRawSource, type DesktopSource } from "./popovers/launchPopoverTypes";
import styles from "./MenuBarPanel.module.css";
import "./launchTheme.css";

type ExpandedSection = "source" | "microphone" | "webcam" | "countdown" | null;

const COUNTDOWN_OPTIONS = [0, 3, 5, 10];

function formatElapsed(totalSeconds: number) {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function Row({
	icon,
	label,
	value,
	trailing,
	highlighted,
	indented,
	disabled,
	onClick,
}: {
	icon?: React.ReactNode;
	label: React.ReactNode;
	value?: React.ReactNode;
	trailing?: React.ReactNode;
	highlighted?: boolean;
	indented?: boolean;
	disabled?: boolean;
	onClick?: () => void;
}) {
	return (
		<button
			type="button"
			className={`${styles.row} ${indented ? styles.rowIndented : ""}`}
			disabled={disabled}
			onClick={onClick}
		>
			{icon ? (
				<span className={`${styles.rowIcon} ${highlighted ? styles.rowOn : ""}`}>
					{icon}
				</span>
			) : null}
			<span className={styles.rowLabel}>{label}</span>
			{value ? <span className={styles.rowValue}>{value}</span> : null}
			{trailing}
		</button>
	);
}

/**
 * The macOS menu bar popover. It is a control surface only: the HUD window owns
 * the capture pipeline, so starting and stopping go through the main process
 * rather than running a second recorder here.
 */
export function MenuBarPanel() {
	const t = useScopedT("launch");
	const panelRef = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState<ExpandedSection>(null);
	const [sources, setSources] = useState<DesktopSource[]>([]);
	const [sourcesLoading, setSourcesLoading] = useState(false);
	const [selectedSourceName, setSelectedSourceName] = useState("");
	const [recording, setRecording] = useState(false);
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
	const [microphoneDeviceId, setMicrophoneDeviceId] = useState<string | undefined>();
	const [systemAudioEnabled, setSystemAudioEnabled] = useState(false);
	const [webcamEnabled, setWebcamEnabled] = useState(false);
	const [webcamDeviceId, setWebcamDeviceId] = useState<string | undefined>();
	const [countdownDelay, setCountdownDelay] = useState(3);
	const [busy, setBusy] = useState(false);

	const { devices: microphones } = useMicrophoneDevices(
		expanded === "microphone",
		microphoneDeviceId,
	);
	const { devices: webcams } = useVideoDevices(expanded === "webcam");

	// Keep the window exactly as tall as its contents as sections expand.
	useLayoutEffect(() => {
		const element = panelRef.current;
		if (!element) {
			return;
		}

		const report = () =>
			window.electronAPI?.resizeMenuBarPanel?.(Math.ceil(element.scrollHeight));
		report();

		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(report);
		observer?.observe(element);
		return () => observer?.disconnect();
	}, []);

	useEffect(() => {
		let active = true;

		void window.electronAPI?.getSelectedSource?.().then((source) => {
			if (active && source?.name) {
				setSelectedSourceName(source.name);
			}
		});

		void window.electronAPI?.getRecordingPreferences?.().then((prefs) => {
			if (!active || !prefs?.success) {
				return;
			}
			setMicrophoneEnabled(Boolean(prefs.microphoneEnabled));
			setMicrophoneDeviceId(prefs.microphoneDeviceId);
			setSystemAudioEnabled(Boolean(prefs.systemAudioEnabled));
			setWebcamEnabled(Boolean(prefs.webcamEnabled));
			setWebcamDeviceId(prefs.webcamDeviceId);
		});

		void window.electronAPI?.getCountdownDelay?.().then((result) => {
			if (active && result?.success && typeof result.delay === "number") {
				setCountdownDelay(result.delay);
			}
		});

		const removeSourceListener = window.electronAPI?.onSelectedSourceChanged?.((source) => {
			setSelectedSourceName(source?.name ?? "");
		});
		const removeRecordingListener = window.electronAPI?.onRecordingStateChanged?.((state) => {
			setRecording(state.recording);
		});

		return () => {
			active = false;
			removeSourceListener?.();
			removeRecordingListener?.();
		};
	}, []);

	useEffect(() => {
		if (!recording) {
			setElapsedSeconds(0);
			return;
		}

		const startedAt = Date.now();
		const timer = window.setInterval(() => {
			setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
		}, 1000);
		return () => window.clearInterval(timer);
	}, [recording]);

	const loadSources = useCallback(async () => {
		setSourcesLoading(true);
		try {
			const raw = await window.electronAPI.getSources({
				types: ["screen", "window"],
				thumbnailSize: { width: 0, height: 0 },
				fetchWindowIcons: false,
			});
			setSources(raw.map((source) => mapRawSource(source as DesktopSource)));
		} catch (error) {
			console.error("Failed to load sources for the menu bar panel:", error);
		} finally {
			setSourcesLoading(false);
		}
	}, []);

	const toggleSection = useCallback(
		(section: Exclude<ExpandedSection, null>) => {
			setExpanded((current) => {
				const next = current === section ? null : section;
				if (next === "source") {
					void loadSources();
				}
				return next;
			});
		},
		[loadSources],
	);

	const updatePreferences = useCallback(
		(patch: Parameters<Window["electronAPI"]["setRecordingPreferences"]>[0]) => {
			void window.electronAPI?.setRecordingPreferences?.(patch);
		},
		[],
	);

	const handleStart = useCallback(async () => {
		setBusy(true);
		try {
			await window.electronAPI?.startRecordingFromMenuBar?.();
		} finally {
			setBusy(false);
		}
	}, []);

	const handleStop = useCallback(async () => {
		setBusy(true);
		try {
			await window.electronAPI?.stopRecordingFromMenuBar?.();
		} finally {
			setBusy(false);
		}
	}, []);

	const caret = (section: Exclude<ExpandedSection, null>) =>
		expanded === section ? <CaretUpIcon size={13} /> : <CaretDown size={13} />;

	return (
		<div ref={panelRef} className={`${styles.panel} launch-theme`}>
			<div className={styles.header}>
				<img src="/app-icons/recordly-128.png" alt="" className={styles.headerIcon} />
				<span className={styles.headerTitle}>{t("app.name", "Recordly")}</span>
				{recording ? (
					<span className={styles.recordingBadge}>
						<span className={styles.recordingDot} />
						{formatElapsed(elapsedSeconds)}
					</span>
				) : null}
			</div>

			<Row
				icon={<MonitorIcon size={16} />}
				label={t("recording.source", "Source")}
				value={selectedSourceName || t("recording.screen", "Screen")}
				trailing={caret("source")}
				disabled={recording}
				onClick={() => toggleSection("source")}
			/>
			{expanded === "source" ? (
				<div className={styles.list}>
					{sourcesLoading && sources.length === 0 ? (
						<div className={styles.empty}>{t("common.loading", "Refreshing...")}</div>
					) : null}
					{sources.map((source) => (
						<Row
							indented
							key={source.id}
							icon={
								source.sourceType === "window" ? (
									<AppWindowIcon size={15} />
								) : (
									<MonitorIcon size={15} />
								)
							}
							label={source.windowTitle || source.name}
							trailing={
								selectedSourceName === source.name ? <Check size={14} /> : null
							}
							onClick={() => {
								void window.electronAPI
									?.selectSource?.(source as never)
									.then(() => setSelectedSourceName(source.name));
								setExpanded(null);
							}}
						/>
					))}
					{!sourcesLoading && sources.length === 0 ? (
						<div className={styles.empty}>
							{t("recording.noSourcesFound", "No sources found")}
						</div>
					) : null}
				</div>
			) : null}

			<div className={styles.divider} />

			<Row
				icon={<MicrophoneIcon size={16} />}
				label={t("recording.microphone", "Microphone")}
				value={microphoneEnabled ? t("recording.on", "On") : t("recording.off", "Off")}
				highlighted={microphoneEnabled}
				trailing={caret("microphone")}
				onClick={() => toggleSection("microphone")}
			/>
			{expanded === "microphone" ? (
				<div className={styles.list}>
					<Row
						indented
						label={
							microphoneEnabled
								? t("recording.turnOffMicrophone", "Turn off microphone")
								: t("recording.enableMicrophone", "Turn on microphone")
						}
						onClick={() => {
							const next = !microphoneEnabled;
							setMicrophoneEnabled(next);
							updatePreferences({ microphoneEnabled: next });
						}}
					/>
					{microphones.map((device) => (
						<Row
							indented
							key={device.deviceId}
							label={device.label}
							trailing={
								microphoneEnabled && microphoneDeviceId === device.deviceId ? (
									<Check size={14} />
								) : null
							}
							onClick={() => {
								setMicrophoneEnabled(true);
								setMicrophoneDeviceId(device.deviceId);
								updatePreferences({
									microphoneEnabled: true,
									microphoneDeviceId: device.deviceId,
								});
							}}
						/>
					))}
				</div>
			) : null}

			<Row
				icon={<SpeakerHighIcon size={16} />}
				label={t("recording.systemAudio", "System audio")}
				value={systemAudioEnabled ? t("recording.on", "On") : t("recording.off", "Off")}
				highlighted={systemAudioEnabled}
				onClick={() => {
					const next = !systemAudioEnabled;
					setSystemAudioEnabled(next);
					updatePreferences({ systemAudioEnabled: next });
				}}
			/>

			<Row
				icon={<VideoCameraIcon size={16} />}
				label={t("recording.webcam", "Webcam")}
				value={webcamEnabled ? t("recording.on", "On") : t("recording.off", "Off")}
				highlighted={webcamEnabled}
				trailing={caret("webcam")}
				onClick={() => toggleSection("webcam")}
			/>
			{expanded === "webcam" ? (
				<div className={styles.list}>
					<Row
						indented
						label={
							webcamEnabled
								? t("recording.turnOffWebcam", "Turn off webcam")
								: t("recording.enableWebcam", "Turn on webcam")
						}
						onClick={() => {
							const next = !webcamEnabled;
							setWebcamEnabled(next);
							updatePreferences({ webcamEnabled: next });
						}}
					/>
					{webcams.map((device) => (
						<Row
							indented
							key={device.deviceId}
							label={device.label}
							trailing={
								webcamEnabled && webcamDeviceId === device.deviceId ? (
									<Check size={14} />
								) : null
							}
							onClick={() => {
								setWebcamEnabled(true);
								setWebcamDeviceId(device.deviceId);
								updatePreferences({
									webcamEnabled: true,
									webcamDeviceId: device.deviceId,
								});
							}}
						/>
					))}
				</div>
			) : null}

			<Row
				icon={<TimerIcon size={16} />}
				label={t("recording.countdownDelay", "Countdown")}
				value={countdownDelay === 0 ? t("recording.noDelay", "None") : `${countdownDelay}s`}
				trailing={caret("countdown")}
				onClick={() => toggleSection("countdown")}
			/>
			{expanded === "countdown" ? (
				<div className={styles.list}>
					{COUNTDOWN_OPTIONS.map((delay) => (
						<Row
							indented
							key={delay}
							label={delay === 0 ? t("recording.noDelay", "None") : `${delay}s`}
							trailing={countdownDelay === delay ? <Check size={14} /> : null}
							onClick={() => {
								setCountdownDelay(delay);
								void window.electronAPI?.setCountdownDelay?.(delay);
								setExpanded(null);
							}}
						/>
					))}
				</div>
			) : null}

			<div className={styles.divider} />

			<Row
				icon={<FolderOpenIcon size={16} />}
				label={t("recording.openProject", "Open Projects")}
				onClick={() => void window.electronAPI?.openProjectsFromMenuBar?.()}
			/>

			<button
				type="button"
				className={`${styles.recordButton} ${recording ? styles.recordButtonStop : ""}`}
				disabled={busy}
				onClick={() => void (recording ? handleStop() : handleStart())}
			>
				{recording
					? t("recording.stopRecording", "Stop recording")
					: t("recording.startRecording", "Start recording")}
			</button>
		</div>
	);
}

export default MenuBarPanel;
