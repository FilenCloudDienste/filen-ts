import type { ComponentType, ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeftIcon, ArrowLeftRightIcon, ArrowRightIcon, CloudIcon, MonitorIcon } from "lucide-react"
import type { DesktopSyncPair } from "@filen/shared/desktop"
import { formatRelativeTime } from "@/lib/relativeTime"
import { useNowMinute } from "@/lib/useNowMinute"
import { Spinner } from "@/components/ui/spinner"
import { useAccountQuery } from "@/queries/account"
import { SettingsPanel } from "@/features/settings/components/settingsLayout"
import { useEventItemActions } from "@/features/settings/hooks/useEventItemActions"
import { syncApi } from "@/features/sync/lib/syncStore"
import { runSyncAction } from "@/features/sync/lib/syncActions"
import {
	issueTotal,
	MODE_DIRECTION,
	MODE_KEY,
	MODE_SHORT_KEY,
	pathBasename,
	pathParent,
	PHASE_KEY,
	type SyncDirection
} from "@/features/sync/lib/syncStatus.logic"
import { useRemoteDirectoryName } from "@/features/sync/hooks/useRemoteDirectoryName"
import { SyncPhaseIcon } from "@/features/sync/components/syncPhaseIcon"

const DIRECTION_ICON: Record<SyncDirection, ComponentType<{ className?: string }>> = {
	both: ArrowLeftRightIcon,
	toRemote: ArrowRightIcon,
	toLocal: ArrowLeftIcon
}

// One end of the pair: what it is (icon), the directory's name and where it lives. Clicking opens it there.
function EndTile({
	icon: Icon,
	name,
	location,
	title,
	label,
	pending,
	onOpen
}: {
	icon: ComponentType<{ className?: string }>
	name: string
	location: ReactNode
	title: string
	label: string
	pending: boolean
	onOpen: () => void
}) {
	return (
		<button
			type="button"
			title={title}
			aria-label={label}
			disabled={pending}
			className="group flex min-w-0 items-center gap-3 rounded-2xl bg-muted/50 p-3 text-left focus-ring transition-colors outline-none hover:bg-muted disabled:opacity-70"
			onClick={onOpen}
		>
			<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background text-muted-foreground shadow-xs ring-1 ring-border/60 transition-colors group-hover:text-foreground">
				{pending ? <Spinner className="size-4" /> : <Icon className="size-5" />}
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-sm font-medium">{name}</span>
				<span className="truncate text-xs text-muted-foreground">{location}</span>
			</span>
		</button>
	)
}

function LocalEnd({ pairId, localRoot }: { pairId: string; localRoot: string }) {
	const { t } = useTranslation("sync")
	const name = pathBasename(localRoot)

	return (
		<EndTile
			icon={MonitorIcon}
			name={name}
			location={pathParent(localRoot)}
			title={localRoot}
			label={t("detailOpenLocal", { name })}
			pending={false}
			onOpen={() => {
				void runSyncAction(() => syncApi().reveal(pairId, "root"))
			}}
		/>
	)
}

// Opened through the same lookup the event dialog's "Open location" uses: the directory's chain, read on click.
function RemoteEnd({ remoteRoot }: { remoteRoot: string }) {
	const { t } = useTranslation(["sync", "drive"])
	const remoteName = useRemoteDirectoryName(remoteRoot)
	const rootUuid = useAccountQuery().data?.rootDirUuid
	const { locationPending, openLocation } = useEventItemActions({ item: undefined, rootUuid })
	const name = remoteName ?? "…"

	return (
		<EndTile
			icon={CloudIcon}
			name={name}
			location={t("drive:driveMyDrive")}
			title={name}
			label={t("sync:detailOpenRemote", { name })}
			pending={locationPending}
			onOpen={() => {
				void openLocation(remoteRoot)
			}}
		/>
	)
}

// The pair at a glance, in the Settings account card's shape: its two directories with the way changes flow between
// them, then its live state. All of it is the overview the page already holds.
export function PairHero({ pair }: { pair: DesktopSyncPair }) {
	const { t } = useTranslation("sync")
	const { t: tCommon } = useTranslation("common")
	const now = useNowMinute()
	const issues = issueTotal(pair.issues)
	const DirectionIcon = DIRECTION_ICON[MODE_DIRECTION[pair.mode]]
	const progress = pair.phase === "syncing" && pair.progress !== null && pair.progress.total > 0 ? pair.progress : null
	const status: string[] = [t(PHASE_KEY[pair.phase])]

	if (progress !== null) {
		status.push(t("detailProgress", { done: progress.done, total: progress.total }))
	} else if (pair.lastSyncedAt !== null) {
		status.push(t("detailLastSynced", { time: formatRelativeTime(pair.lastSyncedAt, tCommon, now) }))
	}

	return (
		<SettingsPanel className="flex flex-col">
			<div className="grid grid-cols-1 items-center gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
				<LocalEnd
					pairId={pair.id}
					localRoot={pair.localRoot}
				/>
				<div
					title={t(MODE_KEY[pair.mode])}
					className="flex items-center justify-center gap-2 sm:flex-col sm:gap-1 sm:px-2"
				>
					<span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
						<DirectionIcon className="size-4 rotate-90 sm:rotate-0" />
					</span>
					<span className="text-xs font-medium text-muted-foreground">
						{t(MODE_SHORT_KEY[pair.mode])}
						<span className="sr-only">, {t(MODE_KEY[pair.mode])}</span>
					</span>
				</div>
				<RemoteEnd remoteRoot={pair.remoteRoot} />
			</div>
			<div className="flex flex-col gap-2.5 border-t border-border/60 px-5 py-3.5">
				<div className="flex min-w-0 items-center gap-2 text-sm">
					<SyncPhaseIcon
						phase={pair.phase}
						hasIssues={issues > 0}
					/>
					<p className="min-w-0 truncate tabular-nums">
						<span className="font-medium">{status[0]}</span>
						{status.length > 1 ? <span className="text-muted-foreground"> · {status[1]}</span> : null}
					</p>
					{issues > 0 ? (
						<span className="ml-auto shrink-0 text-xs font-medium text-warning-foreground tabular-nums">
							{t("detailIssues", { count: issues })}
						</span>
					) : null}
				</div>
				{progress === null ? null : (
					<div
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={progress.total}
						aria-valuenow={progress.done}
						aria-label={t("phaseSyncing")}
						className="h-1 overflow-hidden rounded-full bg-muted"
					>
						<div
							className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
							style={{ width: `${String(Math.min(100, (progress.done / progress.total) * 100))}%` }}
						/>
					</div>
				)}
			</div>
		</SettingsPanel>
	)
}
