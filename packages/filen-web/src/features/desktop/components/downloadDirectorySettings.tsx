import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { SettingsGroup, SettingsRow } from "@/features/settings/components/settingsLayout"
import { chooseDownloadDirectory, setDesktopPref, useDesktopPrefs } from "@/features/desktop/lib/prefs"
import { MiddleEllipsis } from "@/components/middleEllipsis"
import { Button } from "@/components/ui/button"

// Settings > Desktop: where downloads go without asking. Only main's directory picker sets a path; the page can only
// clear it. The prefs are loaded by the Desktop page.
export function DownloadDirectorySettings() {
	const { t } = useTranslation("settings")
	const loaded = useDesktopPrefs(state => state.prefs !== null)
	const directory = useDesktopPrefs(state => state.prefs?.downloadDirectory ?? null)
	const [busy, setBusy] = useState(false)

	function run(action: () => Promise<void>, failure: string): void {
		setBusy(true)
		action()
			.catch(() => {
				toast.error(failure)
			})
			.finally(() => {
				setBusy(false)
			})
	}

	return (
		<SettingsGroup title={t("settingsDesktopDownloadsTitle")}>
			<SettingsRow
				label={t("settingsDesktopDownloadLocation")}
				description={t("settingsDesktopDownloadLocationDescription")}
			>
				{directory === null ? (
					<span className="text-sm text-muted-foreground">{t("settingsDesktopDownloadAsk")}</span>
				) : (
					<MiddleEllipsis
						value={directory}
						start={20}
						end={24}
						className="text-sm text-muted-foreground"
					/>
				)}
				<Button
					type="button"
					variant="outline"
					disabled={!loaded || busy}
					onClick={() => {
						run(chooseDownloadDirectory, t("settingsDesktopDownloadChooseFailed"))
					}}
				>
					{t("settingsDesktopDownloadChange")}
				</Button>
				{directory !== null && (
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() => {
							run(() => setDesktopPref({ downloadDirectory: null }), t("settingsDesktopSaveFailed"))
						}}
					>
						{t("settingsDesktopDownloadAsk")}
					</Button>
				)}
			</SettingsRow>
		</SettingsGroup>
	)
}
