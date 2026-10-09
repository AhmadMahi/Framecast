import { SettingsSections, SettingsCategory } from "../SettingsSections";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { SettingsRow } from "../SettingsRow";
import { Switch } from "@/components/ui/switch";
import { supportsHudCaptureProtection } from "@/lib/hudCaptureProtection";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

type NoiseProfile = "off" | "light" | "standard" | "strong" | "studio";

const NOISE_PROFILES: Array<{ value: NoiseProfile; label: string; detail: string }> = [
	{
		value: "studio",
		label: "Studio (RNNoise)",
		detail: "Neural speech denoiser; strongest on voices, may clip very quiet speech",
	},
	{ value: "strong", label: "Strong (recommended)", detail: "Hiss -16 dB, fan -8 dB" },
	{ value: "standard", label: "Standard", detail: "Hiss -9 dB, fan -5 dB" },
	{ value: "light", label: "Light", detail: "Hiss -5 dB, fan -4 dB" },
	{ value: "off", label: "Off", detail: "Microphone recorded as captured" },
];
export const DashboardSettingsContext = createContext<ReactNode>(null);
export function DashboardSettings({ onImportFile }: { onImportFile: () => Promise<void> }) {
	const settingsContent = useContext(DashboardSettingsContext);
	const [directory, setDirectory] = useState("");
	const [recordings, setRecordings] = useState("");
	const [hideHud, setHideHud] = useState(true);
	const [captureSupported, setCaptureSupported] = useState(false);
	const [menuBarSupported, setMenuBarSupported] = useState(false);
	const [menuBarEnabled, setMenuBarEnabled] = useState(false);
	const [noiseProfile, setNoiseProfile] = useState<NoiseProfile>("strong");
	const [noiseSuppression, setNoiseSuppression] = useState(true);
	const [busy, setBusy] = useState(false);
	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		try {
			await action();
		} catch (error) {
			toast.error(String(error));
		} finally {
			setBusy(false);
		}
	};
	useEffect(() => {
		let active = true;
		void Promise.all([
			window.electronAPI.getRecordingsDirectory(),
			window.electronAPI.getHudOverlayCaptureProtection(),
			window.electronAPI.getPlatform(),
			window.electronAPI.getMenuBarIcon(),
			window.electronAPI.getMicrophoneEnhancement(),
		])
			.then(([directory, protection, platform, menuBar, enhancement]) => {
				if (enhancement?.settings) {
					setNoiseProfile(enhancement.settings.noiseProfile);
					setNoiseSuppression(enhancement.settings.noiseSuppression);
				}
				if (!active) return;
				if (directory.success) setRecordings(directory.path);
				if (protection.success) setHideHud(protection.enabled);
				setCaptureSupported(supportsHudCaptureProtection(platform));
				setMenuBarSupported(menuBar.supported);
				setMenuBarEnabled(menuBar.enabled);
			})
			.catch((error) => toast.error(String(error)));
		return () => {
			active = false;
		};
	}, []);
	return (
		<section aria-label="Dashboard settings" className="dashboard-settings max-w-2xl py-10">
			<h1 className="mb-8 text-lg font-semibold">Settings</h1>
			<SettingsSections categories={["general", "motion", "recording", "files", "advanced"]}>
				<SettingsCategory category={["general", "motion", "advanced"]}>
					{settingsContent}
				</SettingsCategory>
				<SettingsCategory category="files">
					<SettingsRow title="Open video or project">
						<Button
							variant="secondary"
							size="sm"
							disabled={busy}
							onClick={() => void run(onImportFile)}
						>
							Open file
						</Button>
					</SettingsRow>
				</SettingsCategory>
				<SettingsCategory category="recording">
					<SettingsRow
						title="Recordings folder"
						description={
							<span className="block truncate" title={recordings}>
								{recordings}
							</span>
						}
					>
						<Button
							variant="secondary"
							size="sm"
							disabled={busy}
							onClick={() =>
								void run(async () => {
									const result =
										await window.electronAPI.chooseRecordingsDirectory();
									if (result.canceled) return;
									if (!result.success || !result.path)
										throw Error("Could not change recordings folder");
									setRecordings(result.path);
								})
							}
						>
							Change folder
						</Button>
					</SettingsRow>
					<SettingsRow
						title="Noise cancellation"
						description={
							noiseSuppression
								? `Applied to the microphone track on every recording. ${NOISE_PROFILES.find((p) => p.value === noiseProfile)?.detail ?? ""}`
								: "Turned off in the microphone menu. Pick a profile to turn it back on."
						}
					>
						<Select
							value={noiseSuppression ? noiseProfile : "off"}
							onValueChange={(value) =>
								void run(async () => {
									const next = value as NoiseProfile;
									const result =
										await window.electronAPI.setMicrophoneEnhancement(
											next === "off"
												? { noiseSuppression: false }
												: { noiseSuppression: true, noiseProfile: next },
										);
									if (!result.success)
										throw Error("Could not save noise cancellation");
									setNoiseProfile(result.settings.noiseProfile);
									setNoiseSuppression(result.settings.noiseSuppression);
								})
							}
						>
							<SelectTrigger className="w-56" aria-label="Noise cancellation">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{NOISE_PROFILES.map((profile) => (
									<SelectItem key={profile.value} value={profile.value}>
										{profile.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SettingsRow>
					{menuBarSupported && (
						<SettingsRow
							title="Show in menu bar"
							description="Adds a Recordly icon to the menu bar. Click it to open or hide the recording bar wherever you are."
						>
							<Switch
								aria-label="Show in menu bar"
								checked={menuBarEnabled}
								disabled={busy}
								onCheckedChange={(enabled) =>
									void run(async () => {
										const result =
											await window.electronAPI.setMenuBarIcon(enabled);
										if (!result.success)
											throw Error("Could not update the menu bar icon");
										setMenuBarEnabled(result.enabled);
									})
								}
							/>
						</SettingsRow>
					)}
					{captureSupported && (
						<SettingsRow
							title="Hide HUD from recordings"
							description="Only while recording. The idle HUD stays visible in captures."
						>
							<Switch
								aria-label="Hide HUD from recordings"
								checked={hideHud}
								disabled={busy}
								onCheckedChange={(enabled) =>
									void run(async () => {
										const result =
											await window.electronAPI.setHudOverlayCaptureProtection(
												enabled,
											);
										if (!result.success)
											throw Error("Could not update capture protection");
										setHideHud(result.enabled);
									})
								}
							/>
						</SettingsRow>
					)}
				</SettingsCategory>
				<SettingsCategory category="advanced">
					{import.meta.env.DEV && (
						<SettingsRow title="Preview update UI">
							<Button
								variant="secondary"
								size="sm"
								disabled={busy}
								onClick={() =>
									void run(async () => {
										await window.electronAPI.previewUpdateToast();
									})
								}
							>
								Preview
							</Button>
						</SettingsRow>
					)}
				</SettingsCategory>
				<SettingsCategory category="files">
					<SettingsRow
						title="Projects folder"
						description={directory || "Named projects save automatically."}
					>
						<Button
							variant="secondary"
							size="sm"
							onClick={async () => {
								try {
									const result = await window.electronAPI.getProjectsDirectory();
									if (!result.success || !result.path)
										throw Error("Could not open projects folder");
									setDirectory(result.path);
									await window.electronAPI.revealInFolder(result.path);
								} catch (e) {
									toast.error(String(e));
								}
							}}
						>
							Show folder
						</Button>
					</SettingsRow>
					<p className="text-xs text-muted-foreground">
						Named projects save automatically. Previews refresh when you return to
						Projects.
					</p>
				</SettingsCategory>
			</SettingsSections>
		</section>
	);
}
