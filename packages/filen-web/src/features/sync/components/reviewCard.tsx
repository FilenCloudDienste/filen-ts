import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import type {
	DesktopSyncEntries,
	DesktopSyncPlanAction,
	DesktopSyncConflict,
	DesktopSyncIgnored,
	DesktopSyncPlanList,
	DesktopSyncPlanSummary,
	DesktopSyncResult,
	DesktopSyncReviewFinding,
	DesktopSyncUnsyncable
} from "@filen/shared/desktop"
import { cn, formatBytes } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { CARD_SURFACE_CLASS, SURFACE_RING } from "@/components/ui/surface"
import { usePagedEntries } from "@/features/sync/hooks/usePagedEntries"
import { syncApi } from "@/features/sync/lib/syncStore"
import {
	conflictDetailKey,
	FINDING_KEY,
	HELD_REASON_KEY,
	isLargePlan,
	PLAN_LIST_KEY,
	planListsWithEntries,
	planListTotal,
	REFUSAL_KEY
} from "@/features/sync/lib/syncStatus.logic"
import { SyncCallout } from "@/features/sync/components/syncCallout"
import { ActionEntry, EntryRow, IgnoredEntry, PagedFooter, UnsyncableEntry } from "@/features/sync/components/syncEntryRows"

type PlanRow =
	| { list: "actions" | "held"; entry: DesktopSyncPlanAction }
	| { list: "conflicts"; entry: DesktopSyncConflict }
	| { list: "unsyncable"; entry: DesktopSyncUnsyncable }
	| { list: "ignored"; entry: DesktopSyncIgnored }

async function readPlanPage(
	planId: string,
	list: DesktopSyncPlanList,
	offset: number,
	limit: number
): Promise<DesktopSyncResult<DesktopSyncEntries<PlanRow>>> {
	const result = await syncApi().planPage(planId, list, offset, limit)

	if (!result.ok) {
		return result
	}

	const page = result.value
	let entries: PlanRow[]

	switch (page.list) {
		case "actions":
		case "held": {
			const pageList = page.list

			entries = page.entries.map(entry => ({ list: pageList, entry }))
			break
		}
		case "conflicts":
			entries = page.entries.map(entry => ({ list: "conflicts", entry }))
			break
		case "unsyncable":
			entries = page.entries.map(entry => ({ list: "unsyncable", entry }))
			break
		case "ignored":
			entries = page.entries.map(entry => ({ list: "ignored", entry }))
			break
	}

	return { ok: true, value: { total: page.total, entries } }
}

function PlanRowView({ row }: { row: PlanRow }) {
	const { t } = useTranslation("sync")

	switch (row.list) {
		case "actions":
		case "held":
			return <ActionEntry action={row.entry} />
		case "conflicts":
			return (
				<EntryRow
					path={row.entry.relPath}
					detail={t(conflictDetailKey(row.entry))}
				/>
			)
		case "unsyncable":
			return <UnsyncableEntry entry={row.entry} />
		case "ignored":
			return <IgnoredEntry entry={row.entry} />
	}
}

function segmentClass(active: boolean): string {
	return cn(
		"rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap focus-ring transition-colors outline-none",
		active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
	)
}

// A dry run's lists, a page at a time, behind a segmented switch over the lists that hold anything.
function PlanLists({ planId, summary }: { planId: string; summary: DesktopSyncPlanSummary }) {
	const { t } = useTranslation("sync")
	const lists = planListsWithEntries(summary)
	const [chosen, setChosen] = useState<DesktopSyncPlanList | null>(null)
	const list = chosen !== null && lists.includes(chosen) ? chosen : (lists[0] ?? null)
	const paged = usePagedEntries(list === null ? null : `${planId}:${list}`, (offset, limit) =>
		list === null ? Promise.resolve({ ok: true, value: { total: 0, entries: [] } }) : readPlanPage(planId, list, offset, limit)
	)

	if (list === null) {
		return null
	}

	return (
		<div className="flex min-h-0 flex-col gap-2">
			<div
				role="group"
				aria-label={t("reviewListsLabel")}
				className="flex gap-0.5 self-start overflow-x-auto rounded-lg bg-muted p-0.5"
			>
				{lists.map(candidate => (
					<button
						key={candidate}
						type="button"
						aria-pressed={candidate === list}
						className={segmentClass(candidate === list)}
						onClick={() => {
							setChosen(candidate)
						}}
					>
						{t(PLAN_LIST_KEY[candidate])}
						<span className="ml-1 text-muted-foreground tabular-nums">{planListTotal(summary, candidate)}</span>
					</button>
				))}
			</div>
			<div className={cn("max-h-80 divide-y divide-border/60 overflow-y-auto rounded-xl", SURFACE_RING)}>
				{paged.entries.map(row => (
					<PlanRowView
						key={row.entry.relPath}
						row={row}
					/>
				))}
				<PagedFooter paged={paged} />
			</div>
		</div>
	)
}

function summaryLines(summary: DesktopSyncPlanSummary, t: TFunction<"sync">): string[] {
	const lines: string[] = [t("reviewActions", { count: summary.actions })]

	if (summary.uploadBytes > 0) {
		lines.push(t("reviewUpload", { size: formatBytes(summary.uploadBytes) }))
	}

	if (summary.downloadBytes > 0) {
		lines.push(t("reviewDownload", { size: formatBytes(summary.downloadBytes) }))
	}

	if (summary.heldDeletions > 0) {
		lines.push(t("reviewHeld", { count: summary.heldDeletions }))
	}

	if (summary.conflicts > 0) {
		lines.push(t("reviewConflicts", { count: summary.conflicts }))
	}

	if (summary.unsyncable > 0) {
		lines.push(t("reviewUnsyncable", { count: summary.unsyncable }))
	}

	if (summary.ignored > 0) {
		lines.push(t("reviewIgnored", { count: summary.ignored }))
	}

	return lines
}

export interface ReviewSummaryProps {
	summary: DesktopSyncPlanSummary | null
	findings: readonly DesktopSyncReviewFinding[]
	// The dry run to page; null when there is none to page (unconverged, expired, or not read yet).
	planId: string | null
}

// What a pair's first run would do: why it was held (findings), the dry run's totals and its lists. Used by the
// review card and by the add-pair dialog's last step.
export function ReviewSummary({ summary, findings, planId }: ReviewSummaryProps) {
	const { t, i18n } = useTranslation("sync")
	const [showLists, setShowLists] = useState(false)

	return (
		<div className="flex min-h-0 flex-col gap-3">
			{findings.length > 0 ? (
				<ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
					{findings.map(finding => (
						<li key={finding}>{t(FINDING_KEY[finding])}</li>
					))}
				</ul>
			) : null}
			{summary === null ? (
				<SyncCallout tone="info">{t("reviewUnconverged")}</SyncCallout>
			) : (
				<>
					<p className="text-sm text-muted-foreground">{summaryLines(summary, t).join(" · ")}</p>
					{summary.heldReason !== null && summary.heldDeletions > 0 ? (
						<SyncCallout tone="warning">{t(HELD_REASON_KEY[summary.heldReason])}</SyncCallout>
					) : null}
					{summary.refused !== null ? <SyncCallout tone="error">{t(REFUSAL_KEY[summary.refused])}</SyncCallout> : null}
					{isLargePlan(summary) ? (
						<SyncCallout tone="warning">
							{t("reviewLarge", { formatted: new Intl.NumberFormat(i18n.language).format(summary.actions) })}
						</SyncCallout>
					) : null}
					{planId !== null && planListsWithEntries(summary).length > 0 ? (
						showLists ? (
							<PlanLists
								planId={planId}
								summary={summary}
							/>
						) : (
							<Button
								variant="outline"
								size="sm"
								className="self-start"
								onClick={() => {
									setShowLists(true)
								}}
							>
								{t("reviewShowDetails")}
							</Button>
						)
					) : null}
				</>
			)}
		</div>
	)
}

// A pair held paused until the user checks its first run, in the pair's detail. `actions` are its buttons.
export function ReviewCard({
	title,
	description,
	actions,
	...summary
}: ReviewSummaryProps & { title: string; description: string; actions: ReactNode }) {
	return (
		<section className={cn(CARD_SURFACE_CLASS, "flex flex-col gap-4 p-5")}>
			<div className="flex flex-col gap-1">
				<h2 className="font-heading text-base font-medium">{title}</h2>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
			<ReviewSummary {...summary} />
			<div className="flex flex-wrap justify-end gap-2">{actions}</div>
		</section>
	)
}
