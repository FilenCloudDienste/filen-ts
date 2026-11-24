import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronRightIcon, InfoIcon } from "lucide-react"
import type { DesktopSyncSkippedSymlink } from "@filen/shared/desktop"
import { cn } from "@filen/shared"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { SettingsPanel } from "@/features/settings/components/settingsLayout"
import { usePagedEntries } from "@/features/sync/hooks/usePagedEntries"
import { syncApi } from "@/features/sync/lib/syncStore"
import { PlannedEntries } from "@/features/sync/components/plannedEntries"
import { PagedFooter, SkippedSymlinkEntry } from "@/features/sync/components/syncEntryRows"

// Read only while open, from the last pass's report; without one, from a dry run.
function SkippedSymlinkRows({ pairId, count, lastSyncedAt }: { pairId: string; count: number; lastSyncedAt: number | null }) {
	const key = `${pairId}:${String(count)}`
	const pass = String(lastSyncedAt)
	// The pass a report was missing for.
	const [unreported, setUnreported] = useState<string | null>(null)
	const missing = unreported === `${key}:${pass}`
	const paged = usePagedEntries<DesktopSyncSkippedSymlink>(
		missing ? null : key,
		async (offset, limit) => {
			const result = await syncApi().skippedSymlinks(pairId, offset, limit)

			if (!result.ok) {
				return result
			}

			if (result.value === null) {
				setUnreported(`${key}:${pass}`)

				return { ok: true, value: { total: 0, entries: [] } }
			}

			return { ok: true, value: result.value }
		},
		pass
	)

	if (missing) {
		return (
			<PlannedEntries
				pairId={pairId}
				readKey={key}
				list="skippedSymlinks"
				pick={page => (page.list === "skippedSymlinks" ? page.entries : [])}
			>
				{planned => (
					<>
						{planned.entries.map(entry => (
							<SkippedSymlinkEntry
								key={entry.relPath}
								entry={entry}
							/>
						))}
						<PagedFooter paged={planned} />
					</>
				)}
			</PlannedEntries>
		)
	}

	return (
		<>
			{paged.entries.map(entry => (
				<SkippedSymlinkEntry
					key={entry.relPath}
					entry={entry}
				/>
			))}
			<PagedFooter paged={paged} />
		</>
	)
}

// Local symlinks to a directory inside the pair's root: that directory syncs once under its real path and the links
// are left alone, so they are no issue. A muted section under the issues, collapsed until asked for.
export function SkippedSymlinksSection({ pairId, count, lastSyncedAt }: { pairId: string; count: number; lastSyncedAt: number | null }) {
	const { t } = useTranslation("sync")
	const [open, setOpen] = useState(false)

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="flex flex-col gap-2"
		>
			<CollapsibleTrigger className="flex items-start gap-2.5 rounded-md px-5 text-left text-muted-foreground focus-ring transition-colors outline-none hover:text-foreground">
				<InfoIcon
					aria-hidden="true"
					className="mt-0.5 size-4 shrink-0"
				/>
				<span className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="text-xs font-medium">{t("skippedSymlinksTitle", { count })}</span>
					<span className="text-sm">{t("skippedSymlinksDescription")}</span>
				</span>
				<ChevronRightIcon
					aria-hidden="true"
					className={cn("mt-0.5 size-4 shrink-0 transition-transform", open && "rotate-90")}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<SettingsPanel className="divide-y divide-border/60">
					<SkippedSymlinkRows
						pairId={pairId}
						count={count}
						lastSyncedAt={lastSyncedAt}
					/>
				</SettingsPanel>
			</CollapsibleContent>
		</Collapsible>
	)
}
