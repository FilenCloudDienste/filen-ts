import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { ArrowDownIcon, ArrowUpIcon, CircleAlertIcon, CircleCheckIcon, HistoryIcon, TriangleAlertIcon } from "lucide-react"
import type { DesktopSyncActivity } from "@filen/shared/desktop"
import { cn, formatBytes } from "@filen/shared"
import { log } from "@/lib/log"
import { formatRelativeTime } from "@/lib/relativeTime"
import { useNowMinute } from "@/lib/useNowMinute"
import { EmptyMessage } from "@/components/emptyMessage"
import { MiddleEllipsis } from "@/components/middleEllipsis"
import { SettingsGroup, SettingsPanel } from "@/features/settings/components/settingsLayout"
import { syncApi, useSyncStore } from "@/features/sync/lib/syncStore"
import { ACTIVITY_KIND_KEY, ACTIVITY_KIND_TONE, ACTIVITY_LIMIT, mergeActivity, type ActivityTone } from "@/features/sync/lib/activity.logic"
import { EntryRow } from "@/features/sync/components/syncEntryRows"

const TONE_ICON: Record<ActivityTone, { icon: typeof HistoryIcon; className: string }> = {
	normal: { icon: CircleCheckIcon, className: "text-muted-foreground" },
	warning: { icon: TriangleAlertIcon, className: "text-warning-foreground" },
	error: { icon: CircleAlertIcon, className: "text-destructive" }
}

// The transfers the running pass is on (the shell keeps the latest three), with their progress.
function NowSyncing({ pairId }: { pairId: string }) {
	const { t } = useTranslation("sync")
	const transfers = useSyncStore(useShallow(state => state.overview?.pairs.find(pair => pair.id === pairId)?.transfers ?? []))

	if (transfers.length === 0) {
		return null
	}

	return (
		<SettingsGroup title={t("activityNowSyncing")}>
			{transfers.map(transfer => {
				const Icon = transfer.direction === "upload" ? ArrowUpIcon : ArrowDownIcon

				return (
					<EntryRow
						key={transfer.relPath}
						path={transfer.relPath}
						detail={`${formatBytes(transfer.bytes)} / ${formatBytes(transfer.total)}`}
					>
						<Icon
							aria-hidden="true"
							className="size-4 text-muted-foreground"
						/>
					</EntryRow>
				)
			})}
		</SettingsGroup>
	)
}

function ActivityRow({ entry, now }: { entry: DesktopSyncActivity; now: number }) {
	const { t } = useTranslation("sync")
	const { t: tCommon } = useTranslation("common")
	const tone = TONE_ICON[ACTIVITY_KIND_TONE[entry.kind]]
	const Icon = tone.icon
	const label = t(ACTIVITY_KIND_KEY[entry.kind])
	const detail: string[] = [formatRelativeTime(entry.at, tCommon, now)]

	if (entry.to !== undefined) {
		detail.unshift(t("activityMovedTo", { path: entry.to }))
	}

	if (entry.detail !== undefined) {
		detail.unshift(entry.detail)
	}

	return (
		<li
			data-slot="settings-row"
			className="flex items-start gap-3 px-5 py-2.5"
		>
			<Icon
				aria-hidden="true"
				className={cn("mt-0.5 size-4 shrink-0", tone.className)}
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				{entry.relPath === undefined ? (
					<p className="text-sm font-medium">{label}</p>
				) : (
					<>
						<MiddleEllipsis
							value={entry.relPath}
							className="text-sm font-medium"
						/>
						<p className="text-xs text-muted-foreground">{label}</p>
					</>
				)}
				<p className="truncate text-xs text-muted-foreground">{detail.join(" · ")}</p>
			</div>
		</li>
	)
}

// What the pair did this run, newest first: the shell's ring of the latest entries, read once and then followed
// live. Only this pair's entries are kept, so another pair's activity re-renders nothing here.
export function ActivityTab({ pairId }: { pairId: string }) {
	const { t } = useTranslation("sync")
	const now = useNowMinute()
	const [entries, setEntries] = useState<readonly DesktopSyncActivity[]>([])
	const [read, setRead] = useState(false)

	useEffect(() => {
		const sync = syncApi()
		let cancelled = false
		// Subscribed before the read, so nothing between the two is missed; mergeActivity drops the overlap.
		const unsubscribe = sync.onActivity(batch => {
			setEntries(current => mergeActivity(current, batch, pairId))
		})

		sync.activity(pairId, ACTIVITY_LIMIT).then(
			initial => {
				if (!cancelled) {
					setEntries(current => mergeActivity(current, initial, pairId))
					setRead(true)
				}
			},
			(error: unknown) => {
				log.warn("sync", "activity could not be read", error)

				if (!cancelled) {
					setRead(true)
				}
			}
		)

		return () => {
			cancelled = true
			unsubscribe()
		}
	}, [pairId])

	return (
		<div className="flex flex-col gap-6">
			<NowSyncing pairId={pairId} />
			{entries.length === 0 ? (
				read ? (
					<EmptyMessage
						icon={HistoryIcon}
						title={t("activityEmptyTitle")}
						description={t("activityEmptyDescription")}
					/>
				) : null
			) : (
				<SettingsPanel>
					<ul
						aria-label={t("activityListLabel")}
						className="flex flex-col divide-y divide-border/60"
					>
						{entries.map(entry => (
							<ActivityRow
								key={entry.seq}
								entry={entry}
								now={now}
							/>
						))}
					</ul>
				</SettingsPanel>
			)}
		</div>
	)
}
