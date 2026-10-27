import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { ArrowDownIcon, ArrowUpIcon, CircleAlertIcon, CircleCheckIcon, HistoryIcon, TriangleAlertIcon } from "lucide-react"
import type { DesktopSyncActivity, DesktopSyncActivityKind } from "@filen/shared/desktop"
import { cn, formatBytes } from "@filen/shared"
import { log } from "@/lib/log"
import { formatRelativeTime } from "@/lib/relativeTime"
import { useNowMinute } from "@/lib/useNowMinute"
import { EmptyMessage } from "@/components/emptyMessage"
import { DirectoryGlyph, FileTypeIcon } from "@/features/drive/components/itemIcon"
import { fileIconKey } from "@/features/drive/lib/icon.logic"
import { syncApi, useSyncStore } from "@/features/sync/lib/syncStore"
import { ACTIVITY_KIND_KEY, ACTIVITY_KIND_TONE, ACTIVITY_LIMIT, mergeActivity, type ActivityTone } from "@/features/sync/lib/activity.logic"
import { pathBasename, pathParent } from "@/features/sync/lib/syncStatus.logic"

const TONE_ICON: Record<ActivityTone, { icon: typeof HistoryIcon; className: string }> = {
	normal: { icon: CircleCheckIcon, className: "text-muted-foreground" },
	warning: { icon: TriangleAlertIcon, className: "text-warning-foreground" },
	error: { icon: CircleAlertIcon, className: "text-destructive" }
}

const TONE_LABEL_CLASS: Record<ActivityTone, string> = {
	normal: "text-muted-foreground",
	warning: "text-warning-foreground",
	error: "text-destructive"
}

const DIRECTORY_KINDS: ReadonlySet<DesktopSyncActivityKind> = new Set(["createdRemoteDirectory", "createdLocalDirectory"])

const ROW_CLASS = "flex min-h-11 items-center gap-3 px-4 py-1.5 text-sm transition-colors hover:bg-accent/50 sm:px-6"
const PARENT_COLUMN_CLASS = "hidden w-48 shrink-0 truncate text-xs text-muted-foreground lg:block"
const TRAILING_COLUMN_CLASS = "w-24 shrink-0 truncate text-right text-xs text-muted-foreground tabular-nums"

// A path row's leading glyph: the drive's own directory or file-type icon, so the list reads like a listing.
function PathIcon({ relPath, directory }: { relPath: string; directory: boolean }) {
	return directory ? (
		<DirectoryGlyph
			color="default"
			className="size-6 shrink-0"
		/>
	) : (
		<FileTypeIcon
			iconKey={fileIconKey(pathBasename(relPath))}
			className="size-6 shrink-0"
		/>
	)
}

function SectionLabel({ children }: { children: string }) {
	return <h2 className="px-4 pt-4 pb-1.5 text-xs font-medium tracking-wider text-muted-foreground uppercase sm:px-6">{children}</h2>
}

// The latest of the transfers the running pass is on (the transfers screen lists them all), with their progress.
const NOW_SYNCING_SHOWN = 3

function NowSyncing({ pairId }: { pairId: string }) {
	const { t } = useTranslation("sync")
	const transfers = useSyncStore(
		useShallow(state => state.overview?.pairs.find(pair => pair.id === pairId)?.transfers.slice(0, NOW_SYNCING_SHOWN) ?? [])
	)

	if (transfers.length === 0) {
		return null
	}

	return (
		<section>
			<SectionLabel>{t("activityNowSyncing")}</SectionLabel>
			<ul className="flex flex-col">
				{transfers.map(transfer => {
					const Icon = transfer.direction === "upload" ? ArrowUpIcon : ArrowDownIcon

					return (
						<li
							key={transfer.relPath}
							className={ROW_CLASS}
						>
							<PathIcon
								relPath={transfer.relPath}
								directory={false}
							/>
							<span
								title={transfer.relPath}
								className="min-w-0 flex-1 truncate"
							>
								{pathBasename(transfer.relPath)}
							</span>
							<span className={PARENT_COLUMN_CLASS}>{pathParent(transfer.relPath)}</span>
							<Icon
								aria-hidden="true"
								className="size-3.5 shrink-0 text-primary"
							/>
							<span
								className={TRAILING_COLUMN_CLASS}
							>{`${formatBytes(transfer.bytes)} / ${formatBytes(transfer.total)}`}</span>
						</li>
					)
				})}
			</ul>
		</section>
	)
}

// One entry as a listing row: the item's icon and name (a pass-level entry shows its tone instead), what happened and
// why, the directory it is in, and when.
function ActivityRow({ entry, now }: { entry: DesktopSyncActivity; now: number }) {
	const { t } = useTranslation("sync")
	const { t: tCommon } = useTranslation("common")
	const toneKey = ACTIVITY_KIND_TONE[entry.kind]
	const tone = TONE_ICON[toneKey]
	const ToneIcon = tone.icon
	const label = t(ACTIVITY_KIND_KEY[entry.kind])
	const detail: string[] = []

	if (entry.detail !== undefined) {
		detail.push(entry.detail)
	}

	if (entry.to !== undefined) {
		detail.push(t("activityMovedTo", { path: entry.to }))
	}

	return (
		<li className={ROW_CLASS}>
			{entry.relPath === undefined ? (
				<span className="flex size-6 shrink-0 items-center justify-center">
					<ToneIcon
						aria-hidden="true"
						className={cn("size-4", tone.className)}
					/>
				</span>
			) : (
				<PathIcon
					relPath={entry.relPath}
					directory={DIRECTORY_KINDS.has(entry.kind)}
				/>
			)}
			<div className="flex min-w-0 flex-1 flex-col">
				{entry.relPath === undefined ? (
					<span className="truncate font-medium">{label}</span>
				) : (
					<span
						title={entry.relPath}
						className="truncate"
					>
						{pathBasename(entry.relPath)}
					</span>
				)}
				{detail.length > 0 ? <span className="truncate text-xs text-muted-foreground">{detail.join(" · ")}</span> : null}
			</div>
			{entry.relPath === undefined ? null : (
				<>
					<span className={PARENT_COLUMN_CLASS}>{pathParent(entry.relPath)}</span>
					<span className={cn("hidden w-40 shrink-0 truncate text-xs sm:block", TONE_LABEL_CLASS[toneKey])}>{label}</span>
				</>
			)}
			<span className={TRAILING_COLUMN_CLASS}>{formatRelativeTime(entry.at, tCommon, now)}</span>
		</li>
	)
}

// What the pair did this run, newest first, as full-width listing rows: the shell's ring of the latest entries, read
// once and then followed live. Only this pair's entries are kept, so another pair's activity re-renders nothing here.
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
		<div className="flex flex-col pb-12">
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
				<section>
					<SectionLabel>{t("activityListLabel")}</SectionLabel>
					<ul
						aria-label={t("activityListLabel")}
						className="flex flex-col"
					>
						{entries.map(entry => (
							<ActivityRow
								key={entry.seq}
								entry={entry}
								now={now}
							/>
						))}
					</ul>
				</section>
			)}
		</div>
	)
}
