import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { ArrowLeftRightIcon, PauseIcon, PlayIcon, RefreshCwIcon } from "lucide-react"
import type { DesktopSyncPair, DesktopSyncPlan, DesktopSyncReview } from "@filen/shared/desktop"
import { cn } from "@filen/shared"
import { log } from "@/lib/log"
import { formatRelativeTime } from "@/lib/relativeTime"
import { useNowMinute } from "@/lib/useNowMinute"
import { Button, buttonVariants } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { syncApi } from "@/features/sync/lib/syncStore"
import { runSyncAction } from "@/features/sync/lib/syncActions"
import { issueTotal, PHASE_KEY } from "@/features/sync/lib/syncStatus.logic"
import type { SyncTab } from "@/features/sync/lib/syncTabs"
import { useRemoteDirectoryName } from "@/features/sync/hooks/useRemoteDirectoryName"
import { SyncPhaseIcon } from "@/features/sync/components/syncPhaseIcon"
import { SyncCallout } from "@/features/sync/components/syncCallout"
import { NoticeBanner } from "@/features/sync/components/noticeBanner"
import { ReviewCard } from "@/features/sync/components/reviewCard"
import { RemovePairDialog } from "@/features/sync/components/removePairDialog"
import { ActivityTab } from "@/features/sync/components/activityTab"
import { IssuesTab } from "@/features/sync/components/issuesTab"
import { IgnoredTab } from "@/features/sync/components/ignoredTab"
import { SettingsTab } from "@/features/sync/components/settingsTab"

const TABS: readonly { tab: SyncTab; key: "tabActivity" | "tabIssues" | "tabIgnored" | "tabSettings" }[] = [
	{ tab: "activity", key: "tabActivity" },
	{ tab: "issues", key: "tabIssues" },
	{ tab: "ignored", key: "tabIgnored" },
	{ tab: "settings", key: "tabSettings" }
]

const REVIEW_COPY: Record<
	DesktopSyncReview["reason"],
	{
		title: "reviewTitleMigrated" | "reviewTitleBaselineReset"
		description: "reviewDescriptionMigrated" | "reviewDescriptionBaselineReset"
	}
> = {
	migrated: { title: "reviewTitleMigrated", description: "reviewDescriptionMigrated" },
	baselineReset: { title: "reviewTitleBaselineReset", description: "reviewDescriptionBaselineReset" }
}

// A pair the shell kept paused for review: the totals it recorded, and on request a fresh dry run to page through.
// Keep paused only hides the card for this visit; the pair stays paused and in review until it is started.
function ReviewPanel({ pair, review }: { pair: Pick<DesktopSyncPair, "id" | "name">; review: DesktopSyncReview }) {
	const { t } = useTranslation("sync")
	const [plan, setPlan] = useState<DesktopSyncPlan | null>(null)
	const [busy, setBusy] = useState<"plan" | "start" | null>(null)
	const [hidden, setHidden] = useState(false)
	const [removing, setRemoving] = useState(false)
	// The dry run to release when the card goes away.
	const planRef = useRef<string | null>(null)

	useEffect(() => {
		return () => {
			const planId = planRef.current

			if (planId !== null) {
				planRef.current = null
				syncApi()
					.releasePlan(planId)
					.catch((error: unknown) => {
						log.warn("sync", "plan could not be released", error)
					})
			}
		}
	}, [])

	if (hidden) {
		return null
	}

	async function loadPlan(): Promise<void> {
		setBusy("plan")

		const done = await runSyncAction(() => syncApi().plan(pair.id))

		setBusy(null)

		if (done !== null && done.value !== null) {
			planRef.current = done.value.planId
			setPlan(done.value)
		}
	}

	async function start(): Promise<void> {
		setBusy("start")
		await runSyncAction(() => syncApi().startPair(pair.id))
		setBusy(null)
	}

	const copy = REVIEW_COPY[review.reason]

	return (
		<>
			<ReviewCard
				title={t(copy.title)}
				description={t(copy.description)}
				summary={plan?.summary ?? review.summary}
				findings={review.findings}
				planId={plan?.planId ?? null}
				actions={
					<>
						{plan === null && review.summary !== null ? (
							<Button
								variant="ghost"
								className="mr-auto"
								disabled={busy !== null}
								onClick={() => {
									void loadPlan()
								}}
							>
								{busy === "plan" ? <Spinner data-icon="inline-start" /> : null}
								{t("reviewShowDetails")}
							</Button>
						) : null}
						<Button
							variant="outline"
							disabled={busy !== null}
							onClick={() => {
								setRemoving(true)
							}}
						>
							{t("reviewRemove")}
						</Button>
						<Button
							variant="outline"
							disabled={busy !== null}
							onClick={() => {
								setHidden(true)
							}}
						>
							{t("reviewKeepPaused")}
						</Button>
						<Button
							disabled={busy !== null}
							onClick={() => {
								void start()
							}}
						>
							{busy === "start" ? <Spinner data-icon="inline-start" /> : null}
							{t("reviewStart")}
						</Button>
					</>
				}
			/>
			{removing ? (
				<RemovePairDialog
					pairId={pair.id}
					name={pair.name}
					onClose={() => {
						setRemoving(false)
					}}
				/>
			) : null}
		</>
	)
}

function tabClass(active: boolean): string {
	return cn(buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" }), "rounded-full")
}

// One pair: its header (phase, directories, progress, pause and sync now), what the shell wants it to say
// (review, notices, missing directory, degraded watchers), and the four tabs. Each tab takes only the pair id
// and selects what it shows, so a progress push re-renders the header and none of the tab bodies.
export function SyncPairDetail({ pair, tab }: { pair: DesktopSyncPair; tab: SyncTab }) {
	const { t } = useTranslation("sync")
	const { t: tCommon } = useTranslation("common")
	const now = useNowMinute()
	const remoteName = useRemoteDirectoryName(pair.remoteRoot)
	const issues = issueTotal(pair.issues)
	const [toggling, setToggling] = useState(false)
	const [refreshing, setRefreshing] = useState(false)

	async function togglePause(): Promise<void> {
		setToggling(true)
		await runSyncAction(() => (pair.paused ? syncApi().resumePair(pair.id) : syncApi().pausePair(pair.id)))
		setToggling(false)
	}

	async function syncNow(): Promise<void> {
		setRefreshing(true)
		await runSyncAction(() => syncApi().syncNow(pair.id))
		setRefreshing(false)
	}

	const status =
		pair.phase === "syncing" && pair.progress !== null && pair.progress.total > 0
			? t("detailProgress", { done: pair.progress.done, total: pair.progress.total })
			: pair.lastSyncedAt !== null
				? t("detailLastSynced", { time: formatRelativeTime(pair.lastSyncedAt, tCommon, now) })
				: null

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-3 px-4">
				<SyncPhaseIcon
					phase={pair.phase}
					hasIssues={issues > 0}
				/>
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<h1 className="truncate font-heading text-base font-medium tracking-tight">{pair.name}</h1>
					<p className="hidden shrink-0 truncate text-xs text-muted-foreground tabular-nums sm:block">
						{status === null ? t(PHASE_KEY[pair.phase]) : `${t(PHASE_KEY[pair.phase])} · ${status}`}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<TooltipIconButton
						label={pair.paused ? t("detailResume") : t("detailPause")}
						disabled={toggling || pair.phase === "waitingForRoot" || pair.phase === "unsupported"}
						onClick={() => {
							void togglePause()
						}}
					>
						{pair.paused ? <PlayIcon /> : <PauseIcon />}
					</TooltipIconButton>
					<TooltipIconButton
						label={t("detailSyncNow")}
						disabled={refreshing || pair.paused || pair.phase === "syncing"}
						onClick={() => {
							void syncNow()
						}}
					>
						<RefreshCwIcon />
					</TooltipIconButton>
				</div>
			</header>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-2 pb-12 sm:px-6">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
					<div className="flex min-w-0 flex-col gap-2">
						<p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
							<span
								className="min-w-0 truncate"
								title={pair.localRoot}
							>
								<span className="sr-only">{t("detailLocal")}: </span>
								{pair.localRoot}
							</span>
							<ArrowLeftRightIcon
								aria-hidden="true"
								className="size-3.5 shrink-0"
							/>
							<span className="min-w-0 truncate">
								<span className="sr-only">{t("detailRemote")}: </span>
								{remoteName ?? "…"}
							</span>
						</p>
						{pair.phase === "syncing" && pair.progress !== null && pair.progress.total > 0 ? (
							<div
								role="progressbar"
								aria-valuemin={0}
								aria-valuemax={pair.progress.total}
								aria-valuenow={pair.progress.done}
								aria-label={t("phaseSyncing")}
								className="h-1 overflow-hidden rounded-full bg-muted"
							>
								<div
									className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
									style={{ width: `${String(Math.min(100, (pair.progress.done / pair.progress.total) * 100))}%` }}
								/>
							</div>
						) : null}
					</div>
					{pair.review === null ? null : (
						<ReviewPanel
							key={pair.id}
							pair={pair}
							review={pair.review}
						/>
					)}
					{pair.phase === "waitingForRoot" ? <SyncCallout tone="warning">{t("detailWaitingForRoot")}</SyncCallout> : null}
					{pair.phase === "unsupported" && !pair.notices.includes("accountRootUnsupported") ? (
						<SyncCallout tone="info">{t("detailUnsupported")}</SyncCallout>
					) : null}
					{pair.degraded.local ? <SyncCallout tone="info">{t("detailDegradedLocal")}</SyncCallout> : null}
					{pair.degraded.remote ? <SyncCallout tone="info">{t("detailDegradedRemote")}</SyncCallout> : null}
					<NoticeBanner
						pairId={pair.id}
						notices={pair.notices}
					/>
					<nav
						aria-label={t("detailTabsLabel")}
						className="-mx-1 flex gap-1 overflow-x-auto px-1 py-0.5"
					>
						{TABS.map(entry => (
							<Link
								key={entry.tab}
								to="/sync/$pairId"
								params={{ pairId: pair.id }}
								search={{ tab: entry.tab }}
								replace
								aria-current={entry.tab === tab ? "page" : undefined}
								className={tabClass(entry.tab === tab)}
							>
								{t(entry.key)}
								{entry.tab === "issues" && issues > 0 ? (
									<span className="ml-0.5 rounded-full bg-destructive/10 px-1.5 text-xs text-destructive tabular-nums">
										{issues}
									</span>
								) : null}
							</Link>
						))}
					</nav>
					{tab === "activity" ? (
						<ActivityTab pairId={pair.id} />
					) : tab === "issues" ? (
						<IssuesTab pairId={pair.id} />
					) : tab === "ignored" ? (
						<IgnoredTab pairId={pair.id} />
					) : (
						<SettingsTab pairId={pair.id} />
					)}
				</div>
			</div>
		</>
	)
}
