import {
	MagicWand,
	MicrophoneSlashIcon,
	SpeakerHighIcon,
	SpeakerXIcon,
} from "@/components/ui/icons";
import { useScopedT } from "@/contexts/I18nContext";
import { DropdownItem, HudPopover, MicDeviceRow } from "./PopoverScaffold";
import { useLaunchPopoverCoordinator } from "./LaunchPopoverCoordinator";
import type { DeviceOption } from "./launchPopoverTypes";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import styles from "../LaunchWindow.module.css";

interface MicrophoneEnhancement {
	noiseSuppression: boolean;
	echoCancellation: boolean;
	autoGainControl: boolean;
}

const DEFAULT_ENHANCEMENT: MicrophoneEnhancement = {
	noiseSuppression: true,
	echoCancellation: true,
	autoGainControl: false,
};

const POPOVER_ID = "mic";

export function MicPopover({
	trigger,
	disabled,
	systemAudioEnabled,
	onToggleSystemAudio,
	microphoneEnabled,
	onDisableMicrophone,
	devices,
	microphoneDeviceId,
	selectedDeviceId,
	onSelectDevice,
}: {
	trigger: ReactElement;
	disabled?: boolean;
	systemAudioEnabled: boolean;
	onToggleSystemAudio: () => void;
	microphoneEnabled: boolean;
	onDisableMicrophone: () => void;
	devices: DeviceOption[];
	microphoneDeviceId?: string;
	selectedDeviceId?: string;
	onSelectDevice: (deviceId: string) => void;
}) {
	const t = useScopedT("launch");
	const { isOpen, requestOpen, requestClose } = useLaunchPopoverCoordinator();
	const open = isOpen(POPOVER_ID);
	const [enhancement, setEnhancement] = useState<MicrophoneEnhancement>(DEFAULT_ENHANCEMENT);

	// Enhancement settings live in the main process so native macOS capture and
	// browser capture stay in step. Refresh whenever the popover opens.
	useEffect(() => {
		if (!open) {
			return;
		}

		let active = true;
		void window.electronAPI?.getMicrophoneEnhancement?.().then((result) => {
			if (active && result?.settings) {
				setEnhancement(result.settings);
			}
		});

		return () => {
			active = false;
		};
	}, [open]);

	const toggleEnhancement = useCallback(
		(key: keyof MicrophoneEnhancement) => {
			const next = { ...enhancement, [key]: !enhancement[key] };
			setEnhancement(next);
			void window.electronAPI
				?.setMicrophoneEnhancement?.({ [key]: next[key] })
				.then((result) => {
					if (result?.settings) {
						setEnhancement(result.settings);
					}
				});
		},
		[enhancement],
	);

	return (
		<HudPopover
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					requestClose(POPOVER_ID);
					return;
				}
				if (disabled) {
					return;
				}
				requestOpen(POPOVER_ID);
			}}
			trigger={trigger}
			align="start"
		>
			<div className={styles.ddLabel}>{t("recording.microphone")}</div>
			<DropdownItem
				icon={
					systemAudioEnabled ? <SpeakerHighIcon size={16} /> : <SpeakerXIcon size={16} />
				}
				selected={systemAudioEnabled}
				onClick={onToggleSystemAudio}
			>
				{systemAudioEnabled
					? t("recording.disableSystemAudio")
					: t("recording.enableSystemAudio")}
			</DropdownItem>
			{microphoneEnabled && (
				<DropdownItem
					icon={<MicrophoneSlashIcon size={16} />}
					onClick={() => {
						onDisableMicrophone();
						requestClose(POPOVER_ID);
					}}
				>
					{t("recording.turnOffMicrophone")}
				</DropdownItem>
			)}
			{!microphoneEnabled && (
				<div className="px-3 py-2 text-xs text-[var(--launch-text-muted)]">
					{t("recording.selectMicToEnable")}
				</div>
			)}
			{devices.map((device) => (
				<MicDeviceRow
					key={device.deviceId}
					device={device}
					selected={
						microphoneEnabled &&
						(microphoneDeviceId === device.deviceId ||
							selectedDeviceId === device.deviceId)
					}
					onSelect={() => onSelectDevice(device.deviceId)}
				/>
			))}
			{devices.length === 0 && (
				<div className="text-center text-xs text-[var(--launch-text-muted)] py-4">
					{t("recording.noMicrophonesFound")}
				</div>
			)}
			{microphoneEnabled && (
				<>
					<div className={styles.ddLabel}>
						{t("recording.micEnhancement", "Enhancement")}
					</div>
					<DropdownItem
						icon={<MagicWand size={16} />}
						selected={enhancement.noiseSuppression}
						onClick={() => toggleEnhancement("noiseSuppression")}
					>
						{t("recording.noiseSuppression", "Noise suppression")}
					</DropdownItem>
					<DropdownItem
						icon={<MagicWand size={16} />}
						selected={enhancement.echoCancellation}
						onClick={() => toggleEnhancement("echoCancellation")}
					>
						{t("recording.echoCancellation", "Echo cancellation")}
					</DropdownItem>
					<DropdownItem
						icon={<MagicWand size={16} />}
						selected={enhancement.autoGainControl}
						onClick={() => toggleEnhancement("autoGainControl")}
					>
						{t("recording.autoGainControl", "Auto level")}
					</DropdownItem>
				</>
			)}
		</HudPopover>
	);
}
