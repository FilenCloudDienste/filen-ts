import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { RotateCwIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { log, type LogEntry } from "@/lib/log"
import { collectLogs, formatLogEntry, formatLogEntries, logsExportFilename } from "@/features/settings/lib/logs"
import { sdkApi } from "@/lib/sdk/client"
import { storage } from "@/lib/storage/adapter"
import { downloadTextFile } from "@/features/settings/lib/downloadTextFile"
import { Button } from "@/components/ui/button"
import { SettingsBlock } from "@/features/settings/components/settingsLayout"

const LEVEL_CLASS: Record<string, string> = {
	debug: "text-muted-foreground",
	info: "text-foreground",
	warn: "text-yellow-500",
	error: "text-destructive"
}

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

		downloadTextFile(logsExportFilename(), formatLogEntries(merged))
		toast.success(t("settingsLogsExportSuccess"))
	}

	return (
		<SettingsBlock className="flex flex-col gap-3">
			{entries.length === 0 ? (
				<p className="text-sm text-muted-foreground">{t("settingsLogsEmpty")}</p>
			) : (
				<div className="max-h-72 overflow-y-auto rounded-2xl bg-muted/40 p-3 font-mono text-xs">
					{entries.map((entry, index) => (
						<p
							key={index}
							className={cn("truncate", LEVEL_CLASS[entry.level] ?? "text-foreground")}
						>
							{formatLogEntry(entry)}
						</p>
					))}
				</div>
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
