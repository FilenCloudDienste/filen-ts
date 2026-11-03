import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useShallow } from "zustand/shallow"
import { CircleCheckIcon } from "lucide-react"
import type {
	DesktopSyncConflict,
	DesktopSyncHalt,
	DesktopSyncHeldDeletions,
	DesktopSyncRefusal,
	DesktopSyncResolution,
	DesktopSyncUnsyncable
} from "@filen/shared/desktop"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { EmptyMessage } from "@/components/emptyMessage"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { log } from "@/lib/log"
import { SettingsBlock, SettingsGroup } from "@/features/settings/components/settingsLayout"
import { type PagedEntries, usePagedEntries } from "@/features/sync/hooks/usePagedEntries"
import { useSyncRead } from "@/features/sync/hooks/useSyncRead"
import { syncApi, useSyncStore } from "@/features/sync/lib/syncStore"
import { runSyncAction, syncErrorLabel } from "@/features/sync/lib/syncActions"
import {
	canRestoreHeld,
	CONFLICTS_BULK,
	conflictDetailKey,
	conflictResolvedToast,
	conflictsResolvedTone,
	HALT_KEY,
	HELD_REASON_KEY,
	isRootRuleFile,
	REFUSAL_KEY,
	SCAN_GAP_KEY
} from "@/features/sync/lib/syncStatus.logic"
import { EntryRow } from "@/features/desktop/components/entryRow"
import { ActionEntry, PagedFooter, UnsyncableEntry } from "@/features/sync/components/syncEntryRows"

const RESOLUTIONS: readonly { value: DesktopSyncResolution; key: "conflictKeepLocal" | "conflictKeepRemote" | "conflictKeepBoth" }[] = [
	{ value: "keepLocal", key: "conflictKeepLocal" },
	{ value: "keepRemote", key: "conflictKeepRemote" },
	{ value: "keepBoth", key: "conflictKeepBoth" }
]

const NONE: ReadonlySet<string> = new Set()

// Paths acted on since the list named `key` was read. A new read lists what the shell still holds, so a path that
// comes back shows again.
interface Hidden {
	key: string
	paths: ReadonlySet<string>
}

function useHidden(key: string): { hidden: ReadonlySet<string>; hide: (readKey: string, relPath: string) => void } {
	const [state, setState] = useState<Hidden>(() => ({ key, paths: NONE }))

	return {
		hidden: state.key === key ? state.paths : NONE,
		hide: (readKey, relPath) => {
			setState(previous =>
				previous.key === readKey
					? { key: readKey, paths: new Set(previous.paths).add(relPath) }
					: { key: readKey, paths: new Set([relPath]) }
			)
		}
	}
}

// Every conflict resolved the same way, after a confirmation, in one shell call. The toast counts down from the
// overview's count, which drops as the batches go. `busy` while a single row resolves, which the run would list too.
function ResolveAll({
	pairId,
	count,
	busy,
	onRunning
}: {
	pairId: string
	count: number
	busy: boolean
	onRunning: (running: boolean) => void
}) {
	const { t } = useTranslation(["sync", "common"])
	const [confirming, setConfirming] = useState(false)
	// Kept while the dialog closes, so its text stays.
	const [choice, setChoice] = useState<DesktopSyncResolution>("keepLocal")
	const [toastId, setToastId] = useState<string | number | null>(null)

	useEffect(() => {
		if (toastId !== null) {
			toast.loading(t("conflictsResolvingAll", { count }), { id: toastId })
		}
	}, [toastId, count, t])

	async function resolveAll(resolution: DesktopSyncResolution): Promise<void> {
		const id = toast.loading(t("conflictsResolvingAll", { count }))

		setConfirming(false)
		setToastId(id)
		onRunning(true)

		const done = await runSyncAction(() => syncApi().resolveConflicts(pairId, resolution, count))

		setToastId(null)
		onRunning(false)

		if (done === null) {
			toast.dismiss(id)

			return
		}

		const kept = t(CONFLICTS_BULK[resolution].kept, { count: done.value.resolved })
		const failed = t("conflictsResolveAllFailed", { count: done.value.failed })

		switch (conflictsResolvedTone(done.value)) {
			case "success": {
				toast.success(kept, { id })

				break
			}

			case "warning": {
				toast.warning(kept, { id, description: failed })

				break
			}

			case "error": {
				toast.error(failed, { id })

				break
			}
		}
	}

	return (
		<>
			<SettingsBlock className="flex flex-wrap justify-end gap-2">
				{RESOLUTIONS.map(resolution => (
					<Button
						key={resolution.value}
						variant="outline"
						size="sm"
						disabled={toastId !== null || busy}
						onClick={() => {
							setChoice(resolution.value)
							setConfirming(true)
						}}
					>
						{toastId === null ? null : <Spinner data-icon="inline-start" />}
						{t(CONFLICTS_BULK[resolution.value].label)}
					</Button>
				))}
			</SettingsBlock>
			<ConfirmDialog
				open={confirming}
				pending={false}
				title={t("conflictsResolveAllTitle")}
				body={t(CONFLICTS_BULK[choice].body, { count })}
				confirmLabel={t(CONFLICTS_BULK[choice].label)}
				cancelLabel={t("common:cancel")}
				destructive={CONFLICTS_BULK[choice].destructive}
				onOpenChange={setConfirming}
				onConfirm={() => {
					void resolveAll(choice)
				}}
			/>
		</>
	)
}

// Conflicts a page at a time, each with its three resolutions, and all of them at once. The list reads again when
// the count changes; a resolved row hides at once, before the overview catches up.
function ConflictsSection({ pairId, count }: { pairId: string; count: number }) {
	const { t } = useTranslation("sync")
	const key = `${pairId}:${String(count)}`
	const paged = usePagedEntries<DesktopSyncConflict>(key, (offset, limit) => syncApi().conflicts(pairId, offset, limit))
	const resolved = useHidden(key)
	const [resolving, setResolving] = useState<string | null>(null)
	const [resolvingAll, setResolvingAll] = useState(false)

	async function resolve(relPath: string, resolution: DesktopSyncResolution): Promise<void> {
		const readKey = key

		setResolving(relPath)

		const done = await runSyncAction(() => syncApi().resolveConflict(pairId, relPath, resolution))

		setResolving(null)

		if (done !== null) {
			resolved.hide(readKey, relPath)

			const message = conflictResolvedToast(resolution, done.value)

			toast.success(message.path === null ? t(message.key) : t(message.key, { path: message.path }))
		}
	}

	return (
		<SettingsGroup
			title={t("issuesConflictsTitle")}
			description={t("issuesConflictsDescription")}
		>
			{paged.entries
				.filter(conflict => !resolved.hidden.has(conflict.relPath))
				.map(conflict => (
					<EntryRow
						key={conflict.relPath}
						path={conflict.relPath}
						detail={
							isRootRuleFile(conflict)
								? `${t(conflictDetailKey(conflict))}. ${t("conflictRuleFileHint")}`
								: t(conflictDetailKey(conflict))
						}
					>
						{RESOLUTIONS.map(resolution => (
							<Button
								key={resolution.value}
								variant="outline"
								size="sm"
								disabled={resolving !== null || resolvingAll}
								onClick={() => {
									void resolve(conflict.relPath, resolution.value)
								}}
							>
								{t(resolution.key)}
							</Button>
						))}
					</EntryRow>
				))}
			<PagedFooter paged={paged} />
			{count > 1 || resolvingAll ? (
				<ResolveAll
					pairId={pairId}
					count={count}
					busy={resolving !== null}
					onRunning={setResolvingAll}
				/>
			) : null}
		</SettingsGroup>
	)
}

// The paths whose read did not finish: every deletion of the pass waits for them.
function ScanGaps({ held }: { held: DesktopSyncHeldDeletions }) {
	const { t } = useTranslation("sync")
	const more = held.gapsTotal - held.gaps.length

	if (held.gapsTotal === 0) {
		return null
	}

	return (
		<>
			<SettingsBlock className="text-sm font-medium">{t("scanGapsTitle")}</SettingsBlock>
			{held.gaps.map(gap => (
				<EntryRow
					key={gap.relPath}
					path={gap.relPath}
					detail={gap.cause === "unreadable" ? t("scanGapUnreadable", { kind: gap.kind ?? "" }) : t(SCAN_GAP_KEY[gap.cause])}
				/>
			))}
			{more > 0 ? (
				<SettingsBlock className="text-sm text-muted-foreground">{t("scanGapsMore", { count: more })}</SettingsBlock>
			) : null}
		</>
	)
}

function HeldList({ held }: { held: DesktopSyncHeldDeletions }) {
	const { t } = useTranslation("sync")
	const more = held.total - held.entries.length

	return (
		<>
			{held.reason === null ? null : (
				<SettingsBlock className="text-sm text-muted-foreground">{t(HELD_REASON_KEY[held.reason])}</SettingsBlock>
			)}
			{held.entries.map(entry => (
				<ActionEntry
					key={entry.relPath}
					action={entry}
				/>
			))}
			{more > 0 ? <SettingsBlock className="text-sm text-muted-foreground">{t("heldMore", { count: more })}</SettingsBlock> : null}
			<ScanGaps held={held} />
		</>
	)
}

// What the held deletions can be told to do, each with its button, confirmation and the notes it ends with.
const HELD_DECISIONS = {
	approve: {
		label: "heldApprove",
		title: "heldApproveTitle",
		body: "heldApproveBody",
		done: null,
		paused: "heldApprovedPaused",
		destructive: true
	},
	restore: {
		label: "heldRestore",
		title: "heldRestoreTitle",
		body: "heldRestoreBody",
		done: "heldRestored",
		paused: "heldRestoredPaused",
		destructive: false
	}
} as const

type HeldDecision = keyof typeof HELD_DECISIONS

// The deletions the last pass held back, and the approval or restoration of exactly those (the shell's pass token).
// A paused pair runs no pass, so the decision waits for the resume and the same list stays.
function HeldSection({ pairId, count, paused }: { pairId: string; count: number; paused: boolean }) {
	const { t } = useTranslation(["sync", "common"])
	const read = useSyncRead(`${pairId}:${String(count)}`, () => syncApi().heldDeletions(pairId))
	const [confirming, setConfirming] = useState(false)
	// Kept while the dialog closes, so its text stays.
	const [choice, setChoice] = useState<HeldDecision>("approve")
	const [deciding, setDeciding] = useState(false)
	// The decision taken while paused, and the token it covers.
	const [decided, setDecided] = useState<{ token: string; decision: HeldDecision } | null>(null)
	const held = read.data
	const token = held?.passToken ?? null
	const waiting = token !== null && decided?.token === token ? decided.decision : null
	const empty = token === null || held === undefined || held.total === 0 || waiting !== null

	async function decide(decision: HeldDecision): Promise<void> {
		if (token === null) {
			return
		}

		setDeciding(true)

		const done = await runSyncAction(() =>
			decision === "approve" ? syncApi().approveDeletions(pairId, token) : syncApi().restoreDeletions(pairId, token)
		)

		setDeciding(false)

		if (done === null) {
			return
		}

		setConfirming(false)

		const notes = HELD_DECISIONS[decision]

		if (paused) {
			setDecided({ token, decision })
			toast.info(t(notes.paused))

			return
		}

		if (notes.done !== null) {
			toast.success(t(notes.done))
		}

		read.reload()
	}

	return (
		<>
			<SettingsGroup title={t("heldTitle")}>
				{held === undefined ? (
					<SettingsBlock className="flex justify-center">
						{read.error === null ? (
							<Spinner className="size-5 text-muted-foreground" />
						) : (
							<p
								role="alert"
								className="text-sm text-destructive"
							>
								{syncErrorLabel(read.error)}
							</p>
						)}
					</SettingsBlock>
				) : (
					<HeldList held={held} />
				)}
				<SettingsBlock className="flex flex-wrap items-center justify-end gap-3">
					{waiting === null ? null : <span className="text-sm text-muted-foreground">{t(HELD_DECISIONS[waiting].paused)}</span>}
					<Button
						variant="outline"
						disabled={empty || !canRestoreHeld(held.reason)}
						onClick={() => {
							setChoice("restore")
							setConfirming(true)
						}}
					>
						{t("heldRestore")}
					</Button>
					<Button
						variant="destructive"
						disabled={empty}
						onClick={() => {
							setChoice("approve")
							setConfirming(true)
						}}
					>
						{t("heldApprove")}
					</Button>
				</SettingsBlock>
			</SettingsGroup>
			<ConfirmDialog
				open={confirming}
				pending={deciding}
				title={t(HELD_DECISIONS[choice].title)}
				body={t(HELD_DECISIONS[choice].body, { count: held?.total ?? 0 })}
				confirmLabel={t(HELD_DECISIONS[choice].label)}
				cancelLabel={t("common:cancel")}
				destructive={HELD_DECISIONS[choice].destructive}
				onOpenChange={setConfirming}
				onConfirm={() => {
					void decide(choice)
				}}
			/>
		</>
	)
}

// Clears every path's failure record; the shell asks for a pass, which tries them all again.
function RetryAllButton({ pairId }: { pairId: string }) {
	const { t } = useTranslation("sync")
	const [pending, setPending] = useState(false)

	return (
		<Button
			variant="outline"
			size="sm"
			disabled={pending}
			onClick={() => {
				setPending(true)
				void runSyncAction(() => syncApi().retryAll(pairId)).finally(() => {
					setPending(false)
				})
			}}
		>
			{pending ? <Spinner data-icon="inline-start" /> : null}
			{t("issuesRetryAll")}
		</Button>
	)
}

// One page after another of unsyncable items; Retry clears an item's failure record so the next pass tries it again.
// `readKey` names the list read; a retried item hides until the next one.
function UnsyncableRows({ pairId, readKey, paged }: { pairId: string; readKey: string; paged: PagedEntries<DesktopSyncUnsyncable> }) {
	const { t } = useTranslation("sync")
	const retried = useHidden(readKey)

	async function retry(relPath: string): Promise<void> {
		const key = readKey

		if ((await runSyncAction(() => syncApi().retryPath(pairId, relPath))) !== null) {
			retried.hide(key, relPath)
		}
	}

	return (
		<>
			{paged.entries
				.filter(entry => !retried.hidden.has(entry.relPath))
				.map(entry => (
					<UnsyncableEntry
						key={entry.relPath}
						entry={entry}
					>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								void retry(entry.relPath)
							}}
						>
							{t("unsyncableRetry")}
						</Button>
					</UnsyncableEntry>
				))}
			<PagedFooter paged={paged} />
			<SettingsBlock className="flex justify-end">
				<RetryAllButton pairId={pairId} />
			</SettingsBlock>
		</>
	)
}

// Before this run saw a pass of the pair, only a dry run lists them: planned once while the section shows, and
// released again.
function PlannedUnsyncable({ pairId, readKey }: { pairId: string; readKey: string }) {
	const { t } = useTranslation("sync")
	const planRead = useSyncRead(readKey, () => syncApi().plan(pairId))
	const planId = planRead.data?.planId ?? null
	const paged = usePagedEntries<DesktopSyncUnsyncable>(planId, async (offset, limit) => {
		const result = await syncApi().planPage(planId ?? "", "unsyncable", offset, limit)

		if (!result.ok) {
			return result
		}

		return { ok: true, value: { total: result.value.total, entries: result.value.list === "unsyncable" ? result.value.entries : [] } }
	})

	useEffect(() => {
		if (planId === null) {
			return
		}

		return () => {
			syncApi()
				.releasePlan(planId)
				.catch((error: unknown) => {
					log.warn("sync", "plan could not be released", error)
				})
		}
	}, [planId])

	if (planRead.error !== null) {
		return (
			<SettingsBlock>
				<p
					role="alert"
					className="text-sm text-destructive"
				>
					{syncErrorLabel(planRead.error)}
				</p>
			</SettingsBlock>
		)
	}

	if (planRead.data === null) {
		// The cloud side has not caught up, so there is no dry run to list them from yet.
		return <SettingsBlock className="text-sm text-muted-foreground">{t("reviewUnconverged")}</SettingsBlock>
	}

	if (planRead.data === undefined) {
		return (
			<SettingsBlock className="flex justify-center">
				<Spinner className="size-5 text-muted-foreground" />
			</SettingsBlock>
		)
	}

	return (
		<UnsyncableRows
			pairId={pairId}
			readKey={planRead.data.planId}
			paged={paged}
		/>
	)
}

// Unsyncable items as the last pass this run saw reported them; without one, from a dry run. Read again in place
// after each pass, whose report replaces the last.
function UnsyncableSection({ pairId, count, lastSyncedAt }: { pairId: string; count: number; lastSyncedAt: number | null }) {
	const { t } = useTranslation("sync")
	const key = `${pairId}:${String(count)}`
	const pass = String(lastSyncedAt)
	// The pass a report was missing for.
	const [unreported, setUnreported] = useState<string | null>(null)
	const missing = unreported === `${key}:${pass}`
	const paged = usePagedEntries<DesktopSyncUnsyncable>(
		missing ? null : key,
		async (offset, limit) => {
			const result = await syncApi().unsyncablePaths(pairId, offset, limit)

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

	return (
		<SettingsGroup title={t("unsyncableTitle")}>
			{missing ? (
				<PlannedUnsyncable
					pairId={pairId}
					readKey={key}
				/>
			) : (
				<UnsyncableRows
					pairId={pairId}
					readKey={`${key}:${paged.version}`}
					paged={paged}
				/>
			)}
		</SettingsGroup>
	)
}

function LastError({
	lastError,
	failed,
	halted,
	refused,
	pairId
}: {
	lastError: string | null
	failed: number
	halted: DesktopSyncHalt | null
	refused: DesktopSyncRefusal | null
	pairId: string
}) {
	const { t } = useTranslation("sync")

	return (
		<SettingsGroup title={t("issuesLastError")}>
			{halted === null ? null : <SettingsBlock className="text-sm">{t(HALT_KEY[halted])}</SettingsBlock>}
			{refused === null ? null : (
				<SettingsBlock className="text-sm">
					{t("issuesRefused")} {t(REFUSAL_KEY[refused])}
				</SettingsBlock>
			)}
			{lastError === null ? null : (
				<SettingsBlock className="font-mono text-xs break-words whitespace-pre-wrap">{lastError}</SettingsBlock>
			)}
			{failed === 0 ? null : (
				<SettingsBlock className="flex flex-col gap-2 text-sm text-muted-foreground @md:flex-row @md:items-center">
					<span className="flex-1">{t("issuesFailed", { count: failed })}</span>
					<RetryAllButton pairId={pairId} />
				</SettingsBlock>
			)}
		</SettingsGroup>
	)
}

// What the pair needs the user for: the last error (and why a pass held back or was refused), conflicts, held
// deletions with what held them, unsyncable items. Each section
// reads its list only while its count says there is something to list.
export function IssuesTab({ pairId }: { pairId: string }) {
	const { t } = useTranslation("sync")
	const issues = useSyncStore(
		useShallow(state => {
			const pair = state.overview?.pairs.find(candidate => candidate.id === pairId)

			return {
				conflicts: pair?.issues.conflicts ?? 0,
				heldDeletions: pair?.issues.heldDeletions ?? 0,
				unsyncable: pair?.issues.unsyncable ?? 0,
				failed: pair?.issues.failed ?? 0,
				lastError: pair?.lastError ?? null,
				halted: pair?.halted ?? null,
				refused: pair?.refused ?? null,
				paused: pair?.paused ?? false,
				lastSyncedAt: pair?.lastSyncedAt ?? null
			}
		})
	)

	if (
		issues.conflicts + issues.heldDeletions + issues.unsyncable + issues.failed === 0 &&
		issues.lastError === null &&
		issues.halted === null &&
		issues.refused === null
	) {
		return (
			<EmptyMessage
				icon={CircleCheckIcon}
				title={t("issuesEmptyTitle")}
				description={t("issuesEmptyDescription")}
			/>
		)
	}

	return (
		<div className="flex flex-col gap-8">
			{issues.lastError === null && issues.failed === 0 && issues.halted === null && issues.refused === null ? null : (
				<LastError
					pairId={pairId}
					lastError={issues.lastError}
					failed={issues.failed}
					halted={issues.halted}
					refused={issues.refused}
				/>
			)}
			{issues.conflicts > 0 ? (
				<ConflictsSection
					pairId={pairId}
					count={issues.conflicts}
				/>
			) : null}
			{issues.heldDeletions > 0 ? (
				<HeldSection
					pairId={pairId}
					count={issues.heldDeletions}
					paused={issues.paused}
				/>
			) : null}
			{issues.unsyncable > 0 ? (
				<UnsyncableSection
					pairId={pairId}
					count={issues.unsyncable}
					lastSyncedAt={issues.lastSyncedAt}
				/>
			) : null}
		</div>
	)
}
