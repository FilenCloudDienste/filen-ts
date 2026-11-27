import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { DESKTOP_SPEED_KBPS_MAX, type DesktopClientSpeed, type DesktopSpeed } from "@filen/shared/desktop"
import { DESKTOP_WEB_CUSTOM_CONCURRENCY_MAX, TRANSFER_PERFORMANCE_CHOICES } from "@filen/shared"
import { SettingsBlock, SettingsGroup } from "@/features/settings/components/settingsLayout"
import { SettingsNumberRow, SettingsSelectRow } from "@/features/settings/components/settingRows"
import { PRESET_LABEL_KEYS } from "@/features/settings/lib/presetLabels"
import { setDesktopPref, useDesktopPrefs } from "@/features/desktop/lib/prefs"
import type { SettingsKey } from "@/lib/i18n"

type SpeedClient = keyof DesktopSpeed

const CLIENTS: readonly { client: SpeedClient; title: SettingsKey }[] = [
	{ client: "sync", title: "settingsDesktopSpeedSync" },
	{ client: "transfers", title: "settingsDesktopSpeedTransfers" }
]

// Settings > Desktop: the shell's two SDK clients, sync and the drive's uploads and downloads, each with its preset and
// bandwidth limits (the network drive runs on rclone's own transfers, which neither limits). Main stores a change and
// the running helper applies it at once. The prefs are loaded by the Desktop page.
export function SpeedSettings() {
	const { t } = useTranslation("settings")
	const speed = useDesktopPrefs(state => state.prefs?.speed)
	const [pending, setPending] = useState(false)
	// Each client's rows sit in a group named by its subheading: the rows share their labels.
	const headingId = useId()

	function change(client: SpeedClient, patch: Partial<DesktopClientSpeed>): void {
		if (speed === undefined) {
			return
		}

		setPending(true)
		setDesktopPref({ speed: { ...speed, [client]: { ...speed[client], ...patch } } })
			.catch(() => {
				toast.error(t("settingsDesktopSaveFailed"))
			})
			.finally(() => {
				setPending(false)
			})
	}

	const presetOptions = TRANSFER_PERFORMANCE_CHOICES.map(preset => ({ value: preset, label: t(PRESET_LABEL_KEYS[preset]) }))

	return (
		<SettingsGroup title={t("settingsDesktopSpeedTitle")}>
			{CLIENTS.map(({ client, title }) => (
				<div
					key={client}
					role="group"
					aria-labelledby={`${headingId}-${client}`}
					className="divide-y divide-border/60"
				>
					<SettingsBlock className="pt-3 pb-0">
						<h3
							id={`${headingId}-${client}`}
							className="text-sm font-semibold"
						>
							{t(title)}
						</h3>
					</SettingsBlock>
					<SettingsSelectRow
						label={t("settingsDesktopSpeedPreset")}
						id={`desktop-speed-${client}-preset`}
						options={presetOptions}
						value={speed?.[client].preset}
						disabled={pending}
						onChange={preset => {
							change(client, { preset })
						}}
					/>
					{speed?.[client].preset === "custom" ? (
						<SettingsNumberRow
							label={t("settingsAdvancedTransferChunks")}
							description={t("settingsAdvancedTransferChunksDescription")}
							id={`desktop-speed-${client}-chunks`}
							value={speed[client].customConcurrency}
							min={1}
							max={DESKTOP_WEB_CUSTOM_CONCURRENCY_MAX}
							disabled={pending}
							onChange={customConcurrency => {
								change(client, { customConcurrency })
							}}
						/>
					) : null}
					<SettingsNumberRow
						label={t("settingsDesktopSpeedUploadLimit")}
						id={`desktop-speed-${client}-upload`}
						value={speed?.[client].uploadKbps}
						min={0}
						max={DESKTOP_SPEED_KBPS_MAX}
						suffix={t("settingsDesktopSpeedUnit")}
						disabled={pending}
						onChange={uploadKbps => {
							change(client, { uploadKbps })
						}}
					/>
					<SettingsNumberRow
						label={t("settingsDesktopSpeedDownloadLimit")}
						id={`desktop-speed-${client}-download`}
						value={speed?.[client].downloadKbps}
						min={0}
						max={DESKTOP_SPEED_KBPS_MAX}
						suffix={t("settingsDesktopSpeedUnit")}
						disabled={pending}
						onChange={downloadKbps => {
							change(client, { downloadKbps })
						}}
					/>
				</div>
			))}
			<SettingsBlock className="py-3">
				<p className="text-sm text-muted-foreground">{t("settingsDesktopSpeedNote")}</p>
			</SettingsBlock>
		</SettingsGroup>
	)
}
