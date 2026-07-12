import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { RotateCwIcon } from "lucide-react"
import { log } from "@/lib/log"
import { formatLogEntry, formatLogEntries, logsExportFilename } from "@/features/settings/lib/logs"
import { downloadTextFile } from "@/features/settings/lib/downloadTextFile"
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

const LEVEL_CLASS: Record<string, string> = {
	debug: "text-muted-foreground",
	info: "text-foreground",
	warn: "text-yellow-500",
	error: "text-destructive"
}

// Renders this browser TAB's own in-memory ring buffer (log.dump(), see src/lib/log.ts) — not a
// merge with the SDK worker's own separate ring buffer instance (different JS realm); see logs.ts's
// own comment on that scope limit. No live subscription: the ring buffer is a plain array, not an
// event source, so "Refresh" just re-reads it into local state — cheap (capped at 500 entries).
function LogsCard() {
	const { t } = useTranslation("settings")
	const [entries, setEntries] = useState(() => log.dump())

	function refresh(): void {
		setEntries(log.dump())
	}

	function handleExport(): void {
		downloadTextFile(logsExportFilename(), formatLogEntries(entries))
		toast.success(t("settingsLogsExportSuccess"))
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsLogsTitle")}</CardTitle>
				<CardDescription>{t("settingsLogsDescription", { count: 500 })}</CardDescription>
				<CardAction>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={refresh}
					>
						<RotateCwIcon />
						{t("settingsLogsRefresh")}
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent>
				{entries.length === 0 ? (
					<p className="text-sm text-muted-foreground">{t("settingsLogsEmpty")}</p>
				) : (
					<div className="max-h-72 overflow-y-auto rounded-2xl bg-muted/40 p-3 font-mono text-xs">
						{entries.map((entry, index) => (
							<p
								key={index}
								className={`truncate ${LEVEL_CLASS[entry.level] ?? "text-foreground"}`}
							>
								{formatLogEntry(entry)}
							</p>
						))}
					</div>
				)}
			</CardContent>
			<CardFooter>
				<Button
					type="button"
					variant="outline"
					disabled={entries.length === 0}
					onClick={handleExport}
				>
					{t("settingsLogsExport")}
				</Button>
			</CardFooter>
		</Card>
	)
}

export { LogsCard }
