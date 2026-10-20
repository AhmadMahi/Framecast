import { useEffect, useState } from "react";

export interface MicrophoneDevice {
	deviceId: string;
	label: string;
	groupId: string;
}

let hasRequestedMicrophoneLabels = false;

/**
 * Lists the microphones. Pass a new `refreshKey` to list them again, for
 * example after the user grants microphone access.
 */
export function useMicrophoneDevices(
	enabled: boolean = true,
	preferredDeviceId?: string,
	refreshKey = 0,
) {
	const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
	const [selectedDeviceId, setSelectedDeviceId] = useState<string>("default");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!enabled) {
			return;
		}

		let mounted = true;

		const loadDevices = async () => {
			let permissionStream: MediaStream | null = null;

			try {
				setIsLoading(true);
				setError(null);

				const readInputs = async () =>
					(await navigator.mediaDevices.enumerateDevices()).filter(
						(device) => device.kind === "audioinput",
					);

				let rawInputs = await readInputs();

				// Chromium hides microphone names (and ids) until this page has used
				// the microphone once. Check the raw labels, before any placeholder
				// name is filled in, and open the microphone briefly to reveal them.
				const needsLabelPermission =
					rawInputs.length > 0 && rawInputs.every((device) => !device.label.trim());

				if (needsLabelPermission && (!hasRequestedMicrophoneLabels || refreshKey > 0)) {
					hasRequestedMicrophoneLabels = true;
					try {
						permissionStream = await navigator.mediaDevices.getUserMedia({
							audio: true,
						});
						rawInputs = await readInputs();
					} catch (permissionError) {
						console.warn("Microphone names are unavailable:", permissionError);
					}
				}

				const audioInputs = rawInputs.map((device) => ({
					deviceId: device.deviceId,
					label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`.trim(),
					groupId: device.groupId,
				}));

				if (mounted) {
					setDevices(audioInputs);
					setSelectedDeviceId((currentDeviceId) => {
						const normalizedPreferredDeviceId = preferredDeviceId ?? "default";
						if (
							audioInputs.some(
								(device) => device.deviceId === normalizedPreferredDeviceId,
							)
						) {
							return normalizedPreferredDeviceId;
						}

						if (
							currentDeviceId !== "default" &&
							audioInputs.some((device) => device.deviceId === currentDeviceId)
						) {
							return currentDeviceId;
						}

						return (
							audioInputs.find((device) => device.deviceId !== "default")?.deviceId ??
							audioInputs[0]?.deviceId ??
							"default"
						);
					});
					setIsLoading(false);
				}
			} catch (error) {
				if (mounted) {
					const message =
						error instanceof Error
							? error.message
							: "Failed to enumerate audio devices";
					setError(message);
					setIsLoading(false);
					console.error("Error loading microphone devices:", error);
				}
			} finally {
				permissionStream?.getTracks().forEach((track) => track.stop());
			}
		};

		void loadDevices();

		const handleDeviceChange = () => {
			void loadDevices();
		};

		navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

		return () => {
			mounted = false;
			navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
		};
	}, [enabled, preferredDeviceId, refreshKey]);

	return {
		devices,
		selectedDeviceId,
		setSelectedDeviceId,
		isLoading,
		error,
	};
}
