import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ArrowRightIcon, ChevronRightIcon, FileIcon, FolderClosedIcon, FolderPlusIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import type { AssistantKey } from "@/lib/i18n"
import type { AssistantBatchPlan, AssistantBatchSkipReason } from "@/features/assistant/types"
import { batchChangeCount } from "@/features/assistant/components/assistant.logic"

const ROW_HEIGHT = 24
const OVERSCAN = 12
// Past this many files a sort card opens with its groups closed.
const OPEN_GROUPS_MAX_ITEMS = 50

const SKIP_KEYS: Record<AssistantBatchSkipReason, AssistantKey> = {
	"invalid-name": "assistantBatchSkipInvalidName",
	"destination-is-file": "assistantBatchSkipDestinationIsFile"
}

const DATE_KEYS: Readonly<Record<string, AssistantKey>> = {
	taken: "assistantBatchDateTaken",
	created: "assistantBatchDateCreated",
	modified: "assistantBatchDateModified",
	uploaded: "assistantBatchDateUploaded"
}

type Row =
	| { kind: "change"; from: string; to: string; suffixed: boolean }
	| { kind: "skip"; name: string; reason: AssistantBatchSkipReason }
	| { kind: "group"; directory: string; isNew: boolean; count: number; open: boolean }
	| { kind: "move"; from: string; to?: string }

function rows(plan: AssistantBatchPlan, open: ReadonlySet<string>): Row[] {
	const changes: Row[] = (plan.changes ?? []).map(change => ({ kind: "change", ...change }))
	const groups: Row[] = (plan.groups ?? []).flatMap(group => {
		const expanded = open.has(group.directory)

		return [
			{ kind: "group", directory: group.directory, isNew: group.isNew, count: group.items.length, open: expanded } satisfies Row,
			...(expanded ? group.items.map(item => ({ kind: "move", ...item }) satisfies Row) : [])
		]
	})

	return [...changes, ...groups, ...plan.skipped.map(skip => ({ kind: "skip", ...skip }) satisfies Row)]
}

// The rule in words; `date` is which date a date rule goes by.
function useRuleText(): (rule: string | undefined, date: string) => string | null {
	const { t } = useTranslation("assistant")

	return (rule, date) => {
		switch (rule) {
			case "date_prefix":
				return t("assistantBatchRuleDatePrefix", { date })
			case "date_name":
				return t("assistantBatchRuleDateName", { date })
			case "number":
				return t("assistantBatchRuleNumber")
			case "add_prefix":
				return t("assistantBatchRuleAddPrefix")
			case "add_suffix":
				return t("assistantBatchRuleAddSuffix")
			case "replace_text":
				return t("assistantBatchRuleReplaceText")
			case "lowercase":
				return t("assistantBatchRuleLowercase")
			case "year":
				return t("assistantBatchRuleByYear", { date })
			case "month":
				return t("assistantBatchRuleByMonth", { date })
			case "day":
				return t("assistantBatchRuleByDay", { date })
			default:
				return null
		}
	}
}

// The summary line: the rule, then how many files stay as they are and how many took a number to avoid a clash.
function BatchSummary({ plan }: { plan: AssistantBatchPlan }) {
	const { t } = useTranslation("assistant")
	const ruleText = useRuleText()
	const date = t(DATE_KEYS[plan.rule["date"] ?? "taken"] ?? "assistantBatchDateTaken")
	const suffixed = plan.changes?.filter(change => change.suffixed).length ?? 0
	const renamedOnMove = plan.groups?.reduce((sum, group) => sum + group.items.filter(item => item.to !== undefined).length, 0) ?? 0
	const parts = [
		ruleText(plan.rule["scheme"] ?? plan.rule["by"], date),
		plan.skipped.length > 0 ? t("assistantBatchSkipped", { count: plan.skipped.length }) : null,
		suffixed > 0 ? t("assistantBatchSuffixed", { count: suffixed }) : null
	].filter(part => part !== null)

	return (
		<>
			<p className="text-xs leading-5 text-muted-foreground">{parts.join(" · ")}</p>
			{renamedOnMove > 0 ? (
				<p className="text-xs leading-5 text-muted-foreground">{t("assistantBatchRenamedOnMove", { count: renamedOnMove })}</p>
			) : null}
		</>
	)
}

function Names({ from, to }: { from: string; to?: string | undefined }) {
	return (
		<span
			className="flex min-w-0 items-center gap-1.5"
			title={to === undefined ? from : `${from} → ${to}`}
		>
			<span className={cn("min-w-0 truncate", to === undefined ? "font-medium" : "text-muted-foreground")}>{from}</span>
			{to === undefined ? null : (
				<>
					<ArrowRightIcon
						aria-label="→"
						className="size-3 shrink-0 text-muted-foreground"
					/>
					<span className="min-w-0 truncate font-medium">{to}</span>
				</>
			)}
		</span>
	)
}

function RowContent({ row, onToggle }: { row: Row; onToggle: (directory: string) => void }) {
	const { t } = useTranslation("assistant")

	switch (row.kind) {
		case "change":
			return (
				<>
					<Names
						from={row.from}
						to={row.to}
					/>
					{row.suffixed ? <span className="shrink-0 text-muted-foreground">{t("assistantBatchSuffixedTag")}</span> : null}
				</>
			)
		case "move":
			return (
				<span className="flex min-w-0 items-center gap-2 pl-5">
					<FileIcon
						aria-hidden="true"
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
					<Names
						from={row.from}
						to={row.to}
					/>
				</span>
			)
		case "skip":
			return (
				<>
					<span
						className="min-w-0 truncate text-muted-foreground line-through"
						title={row.name}
					>
						{row.name}
					</span>
					<span className="shrink-0 text-muted-foreground">{t(SKIP_KEYS[row.reason])}</span>
				</>
			)
		case "group": {
			const GroupIcon = row.isNew ? FolderPlusIcon : FolderClosedIcon

			return (
				<button
					type="button"
					aria-expanded={row.open}
					className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					onClick={() => {
						onToggle(row.directory)
					}}
				>
					<ChevronRightIcon
						aria-hidden="true"
						className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", row.open && "rotate-90")}
					/>
					<GroupIcon
						aria-hidden="true"
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
					<span
						className="min-w-0 truncate font-medium"
						title={row.directory}
					>
						{row.directory}
					</span>
					<span className="shrink-0 text-muted-foreground">
						({t(row.isNew ? "assistantBatchGroupNew" : "assistantBatchGroupExists")}) ·{" "}
						{t("assistantBatchGroupCount", { count: row.count })}
					</span>
				</button>
			)
		}
	}
}

// A batch card's plan: the summary line, then every change as a window over fixed-height rows, so a plan of 500
// files draws what is in view. A sort's groups open and close. Its own file, as useVirtualizer opts it out of the
// React Compiler (the card stays compiled).
export function AssistantBatchPlanList({ plan }: { plan: AssistantBatchPlan }) {
	const { t } = useTranslation("assistant")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const [open, setOpen] = useState<ReadonlySet<string>>(
		() =>
			new Set(
				batchChangeCount(plan) <= OPEN_GROUPS_MAX_ITEMS || plan.groups?.length === 1
					? plan.groups?.map(group => group.directory)
					: []
			)
	)
	const list = useMemo(() => rows(plan, open), [plan, open])
	// Memoized by hand: the virtualizer re-lays every row when its key function changes, so it changes with the rows.
	const getItemKey = useCallback(
		(index: number) => {
			const row = list[index]

			return row === undefined
				? index
				: `${String(index)}:${row.kind === "group" ? row.directory : row.kind === "skip" ? row.name : row.from}`
		},
		[list]
	)
	const virtualizer = useVirtualizer({
		count: list.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN,
		getItemKey
	})

	function toggle(directory: string): void {
		setOpen(current => {
			const next = new Set(current)

			if (!next.delete(directory)) {
				next.add(directory)
			}

			return next
		})
	}

	return (
		<>
			<BatchSummary plan={plan} />
			<div
				ref={setScrollElement}
				className="max-h-60 overflow-y-auto rounded-xl bg-muted/60 px-2.5 py-1.5"
			>
				<ul
					aria-label={t("assistantProposalChanges")}
					className="relative w-full"
					style={{ height: virtualizer.getTotalSize() }}
				>
					{virtualizer.getVirtualItems().map(item => {
						const row = list[item.index]

						if (row === undefined) {
							return null
						}

						return (
							<li
								key={item.key}
								className="absolute top-0 left-0 flex w-full min-w-0 items-center justify-between gap-2 text-xs leading-5"
								style={{ height: ROW_HEIGHT, transform: `translateY(${String(item.start)}px)` }}
							>
								<RowContent
									row={row}
									onToggle={toggle}
								/>
							</li>
						)
					})}
				</ul>
			</div>
		</>
	)
}
