import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { RotateCwIcon } from "lucide-react"
import { log, type LogEntry } from "@/lib/log"
import { collectLogs, logsExportFilename, logsExportText } from "@/features/settings/lib/logs"
import { buildLabel } from "@/lib/buildId"
import { sdkApi } from "@/lib/sdk/client"
import { storage } from "@/lib/storage/adapter"
import { downloadTextFile } from "@/features/settings/lib/downloadTextFile"
import { Button } from "@/components/ui/button"
import { LogsList } from "@/features/settings/components/advanced/logsList"
import { SettingsBlock } from "@/features/settings/components/settingsLayout"

// Renders this tab's ring merged with the SDK worker's, the db worker's and the service worker's (collectLogs, see
// features/settings/lib/logs.ts). The page's own entries show at once; the pull fills in the rest. No live
// subscription: the rings are plain arrays, not event sources, so "Refresh" pulls them again (each capped at
// LOG_RING_MAX entries).
function LogsBlock() {
	const { t } = useTranslation("settings")
	const [entries, setEntries] = useState(() => log.dump())
	// Only the latest pull lands: an earlier one answering late would show older entries.
	const pullRef = useRef(0)

	async function refresh(): Promise<LogEntry[]> {
		const pullId = ++pullRef.current
		const merged = await collectLogs(log.dump(), { sdk: sdkApi, storage })

		if (pullRef.current === pullId) {
			setEntries(merged)
		}

		return merged
	}

	useEffect(() => {
		void refresh()
	}, [])

	// Pulls afresh rather than reading `entries`, so a click before the mount pull lands still exports every realm.
	async function handleExport(): Promise<void> {
		const merged = await refresh()

		downloadTextFile(
			logsExportFilename(),
			logsExportText(merged, { build: buildLabel(), userAgent: navigator.userAgent, exportedAt: new Date() })
		)
		toast.success(t("settingsLogsExportSuccess"))
	}

	return (
		<SettingsBlock className="flex flex-col gap-3">
			{entries.length === 0 ? (
				<p className="text-sm text-muted-foreground">{t("settingsLogsEmpty")}</p>
			) : (
				<LogsList entries={entries} />
			)}
			<div className="flex justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					onClick={() => {
						void refresh()
					}}
				>
					<RotateCwIcon />
					{t("settingsLogsRefresh")}
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={entries.length === 0}
					onClick={() => {
						void handleExport()
					}}
				>
					{t("settingsLogsExport")}
				</Button>
			</div>
		</SettingsBlock>
	)
}

export { LogsBlock }
