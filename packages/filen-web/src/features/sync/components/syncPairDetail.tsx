import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { PauseIcon, PlayIcon, RefreshCwIcon } from "lucide-react"
import type { DesktopSyncPair, DesktopSyncPlan, DesktopSyncReview } from "@filen/shared/desktop"
import { log } from "@/lib/log"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { syncApi } from "@/features/sync/lib/syncStore"
import { runSyncAction } from "@/features/sync/lib/syncActions"
import { issueTotal } from "@/features/sync/lib/syncStatus.logic"
import type { SyncTab } from "@/features/sync/lib/syncTabs"
import { PairHero } from "@/features/sync/components/pairHero"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"
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

const TAB_CLASS =
	"flex h-11 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-1 text-sm whitespace-nowrap text-muted-foreground focus-ring transition-colors outline-none hover:text-foreground focus-visible:rounded-md aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground"

// The four sections as an underline tab bar across the card, pinned while the page scrolls under it.
function PairTabs({ pairId, tab, issues }: { pairId: string; tab: SyncTab; issues: number }) {
	const { t } = useTranslation("sync")

	return (
		<nav
			aria-label={t("detailTabsLabel")}
			className="sticky top-0 z-10 flex shrink-0 gap-5 overflow-x-auto bg-card px-4 shadow-[inset_0_-1px_0_0_color-mix(in_oklab,var(--color-border)_50%,transparent)] sm:px-6"
		>
			{TABS.map(entry => (
				<Link
					key={entry.tab}
					to="/sync/$pairId"
					params={{ pairId }}
					search={{ tab: entry.tab }}
					replace
					aria-current={entry.tab === tab ? "page" : undefined}
					className={TAB_CLASS}
				>
					{t(entry.key)}
					{entry.tab === "issues" && issues > 0 ? (
						<span className="rounded-full bg-destructive/10 px-1.5 text-xs font-medium text-destructive tabular-nums">
							{issues}
						</span>
					) : null}
				</Link>
			))}
		</nav>
	)
}

// One pair: a title bar with pause and sync now, its overview (directories, mode, live state), what the shell wants it
// to say (review, notices, missing directory, degraded watchers), and the four tabs. Each tab takes only the pair id
// and selects what it shows, so a progress push re-renders the overview and none of the tab bodies.
export function SyncPairDetail({ pair, tab }: { pair: DesktopSyncPair; tab: SyncTab }) {
	const { t } = useTranslation("sync")
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

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/50 px-4">
				<h1 className="min-w-0 flex-1 truncate font-heading text-base font-medium tracking-tight">{pair.name}</h1>
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
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div className="flex flex-col gap-3 px-4 pt-4 pb-5 sm:px-6">
					<PairHero pair={pair} />
					{pair.review === null ? null : (
						<ReviewPanel
							key={pair.id}
							pair={pair}
							review={pair.review}
						/>
					)}
					{pair.phase === "waitingForRoot" ? <DesktopCallout tone="warning">{t("detailWaitingForRoot")}</DesktopCallout> : null}
					{pair.degraded.local ? <DesktopCallout tone="info">{t("detailDegradedLocal")}</DesktopCallout> : null}
					{pair.degraded.remote ? <DesktopCallout tone="info">{t("detailDegradedRemote")}</DesktopCallout> : null}
					<NoticeBanner
						pairId={pair.id}
						notices={pair.notices}
					/>
				</div>
				<PairTabs
					pairId={pair.id}
					tab={tab}
					issues={issues}
				/>
				{tab === "activity" ? (
					<ActivityTab pairId={pair.id} />
				) : (
					<div className="mx-auto flex w-full max-w-3xl flex-col px-4 pt-6 pb-12 sm:px-6">
						{tab === "issues" ? (
							<IssuesTab pairId={pair.id} />
						) : tab === "ignored" ? (
							<IgnoredTab pairId={pair.id} />
						) : (
							<SettingsTab pairId={pair.id} />
						)}
					</div>
				)}
			</div>
		</>
	)
}
