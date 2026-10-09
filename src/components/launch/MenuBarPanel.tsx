import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	ArrowClockwiseIcon,
	CaretDown,
	CaretUpIcon,
	Check,
	Gear,
	MicrophoneIcon,
	VideoCameraIcon,
} from "@/components/ui/icons";
import { useScopedT } from "@/contexts/I18nContext";
import { useMicrophoneDevices } from "@/hooks/useMicrophoneDevices";
import { useVideoDevices } from "@/hooks/useVideoDevices";
import styles from "./MenuBarPanel.module.css";
import "./launchTheme.css";

type ExpandedSection = "microphone" | "camera" | null;

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
 * The macOS menu bar popover. Deliberately minimal: start/stop, pause/resume,
 * microphone, camera, updates and a way into the full app. The HUD owns the
 * capture pipeline, so every recording action is relayed through the main
 * process rather than running a second recorder here.
 */
export function MenuBarPanel() {
	const t = useScopedT("launch");
	const panelRef = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState<ExpandedSection>(null);
	const [recording, setRecording] = useState(false);
	const [paused, setPaused] = useState(false);
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
	const [microphoneDeviceId, setMicrophoneDeviceId] = useState<string | undefined>();
	const [webcamEnabled, setWebcamEnabled] = useState(false);
	const [webcamDeviceId, setWebcamDeviceId] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);

	const { devices: microphones } = useMicrophoneDevices(
		expanded === "microphone",
		microphoneDeviceId,
	);
	const { devices: cameras } = useVideoDevices(expanded === "camera");

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

		void window.electronAPI?.getRecordingPreferences?.().then((prefs) => {
			if (!active || !prefs?.success) {
				return;
			}
			setMicrophoneEnabled(Boolean(prefs.microphoneEnabled));
			setMicrophoneDeviceId(prefs.microphoneDeviceId);
			setWebcamEnabled(Boolean(prefs.webcamEnabled));
			setWebcamDeviceId(prefs.webcamDeviceId);
		});

		const removeRecordingListener = window.electronAPI?.onRecordingStateChanged?.((state) => {
			setRecording(state.recording);
			if (!state.recording) {
				setPaused(false);
			}
		});
		const removePausedListener = window.electronAPI?.onRecordingPausedChanged?.((state) => {
			setPaused(state.paused);
		});

		return () => {
			active = false;
			removeRecordingListener?.();
			removePausedListener?.();
		};
	}, []);

	// Elapsed time excludes paused stretches so it matches the HUD's clock. The
	// baseline lives in a ref so resuming continues from where the pause began.
	const elapsedBaselineRef = useRef(0);
	useEffect(() => {
		if (!recording) {
			elapsedBaselineRef.current = 0;
			setElapsedSeconds(0);
			return;
		}

		if (paused) {
			return;
		}

		const resumedAt = Date.now();
		const baseline = elapsedBaselineRef.current;
		const timer = window.setInterval(() => {
			const next = baseline + Math.floor((Date.now() - resumedAt) / 1000);
			elapsedBaselineRef.current = next;
			setElapsedSeconds(next);
		}, 1000);
		return () => window.clearInterval(timer);
	}, [recording, paused]);

	const updatePreferences = useCallback(
		(patch: Parameters<Window["electronAPI"]["setRecordingPreferences"]>[0]) => {
			void window.electronAPI?.setRecordingPreferences?.(patch);
		},
		[],
	);

	const relay = useCallback(async (action: () => Promise<unknown> | undefined) => {
		setBusy(true);
		try {
			await action();
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
				<span className={styles.headerTitle}>{t("app.name", "Framecast")}</span>
				{recording ? (
					<span className={styles.recordingBadge}>
						<span
							className={`${styles.recordingDot} ${paused ? styles.recordingDotPaused : ""}`}
						/>
						{formatElapsed(elapsedSeconds)}
					</span>
				) : null}
			</div>

			<button
				type="button"
				className={`${styles.recordButton} ${recording ? styles.recordButtonStop : ""}`}
				disabled={busy}
				onClick={() =>
					void relay(() =>
						recording
							? window.electronAPI?.stopRecordingFromMenuBar?.()
							: window.electronAPI?.startRecordingFromMenuBar?.(),
					)
				}
			>
				{recording
					? t("recording.stopRecording", "Stop recording")
					: t("recording.startRecording", "Start recording")}
			</button>

			{recording ? (
				<Row
					icon={<span className={styles.pauseGlyph} aria-hidden="true" />}
					label={
						paused
							? t("recording.resumeRecording", "Resume recording")
							: t("recording.pauseRecording", "Pause recording")
					}
					disabled={busy}
					onClick={() =>
						void relay(() =>
							paused
								? window.electronAPI?.resumeRecordingFromMenuBar?.()
								: window.electronAPI?.pauseRecordingFromMenuBar?.(),
						)
					}
				/>
			) : null}

			<div className={styles.divider} />

			<Row
				icon={<MicrophoneIcon size={16} />}
				label={t("recording.microphone", "Microphone")}
				value={microphoneEnabled ? t("recording.on", "On") : t("recording.off", "Off")}
				highlighted={microphoneEnabled}
				trailing={caret("microphone")}
				onClick={() =>
					setExpanded((current) => (current === "microphone" ? null : "microphone"))
				}
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
							key={device.deviceId}
							indented
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
				icon={<VideoCameraIcon size={16} />}
				label={t("recording.camera", "Camera")}
				value={webcamEnabled ? t("recording.on", "On") : t("recording.off", "Off")}
				highlighted={webcamEnabled}
				trailing={caret("camera")}
				onClick={() => setExpanded((current) => (current === "camera" ? null : "camera"))}
			/>
			{expanded === "camera" ? (
				<div className={styles.list}>
					<Row
						indented
						label={
							webcamEnabled
								? t("recording.turnOffCamera", "Turn off camera")
								: t("recording.turnOnCamera", "Turn on camera")
						}
						onClick={() => {
							const next = !webcamEnabled;
							setWebcamEnabled(next);
							updatePreferences({ webcamEnabled: next });
						}}
					/>
					{cameras.map((device) => (
						<Row
							key={device.deviceId}
							indented
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

			<div className={styles.divider} />

			<Row
				icon={<ArrowClockwiseIcon size={16} />}
				label={t("recording.checkForUpdates", "Check for updates")}
				disabled={busy}
				onClick={() =>
					void relay(() => window.electronAPI?.checkForAppUpdatesFromMenuBar?.())
				}
			/>
			<Row
				icon={<Gear size={16} />}
				label={t("recording.openSettings", "Open Settings")}
				onClick={() => void window.electronAPI?.openSettingsFromMenuBar?.()}
			/>
		</div>
	);
}

export default MenuBarPanel;
