import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useShallow } from "zustand/shallow"
import { CircleCheckIcon } from "lucide-react"
import type { DesktopSyncConflict, DesktopSyncHeldDeletions, DesktopSyncResolution, DesktopSyncUnsyncable } from "@filen/shared/desktop"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { EmptyMessage } from "@/components/emptyMessage"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { log } from "@/lib/log"
import { SettingsBlock, SettingsGroup } from "@/features/settings/components/settingsLayout"
import { usePagedEntries } from "@/features/sync/hooks/usePagedEntries"
import { useSyncRead } from "@/features/sync/hooks/useSyncRead"
import { syncApi, useSyncStore } from "@/features/sync/lib/syncStore"
import { runSyncAction, syncErrorLabel } from "@/features/sync/lib/syncActions"
import { conflictDetailKey, HELD_REASON_KEY } from "@/features/sync/lib/syncStatus.logic"
import { ActionEntry, EntryRow, PagedFooter, UnsyncableEntry } from "@/features/sync/components/syncEntryRows"

const RESOLUTIONS: readonly { value: DesktopSyncResolution; key: "conflictKeepLocal" | "conflictKeepRemote" | "conflictKeepBoth" }[] = [
	{ value: "keepLocal", key: "conflictKeepLocal" },
	{ value: "keepRemote", key: "conflictKeepRemote" },
	{ value: "keepBoth", key: "conflictKeepBoth" }
]

// Conflicts a page at a time, each with its three resolutions. The list reads again when the count changes; a
// resolved row hides at once, before the overview catches up.
function ConflictsSection({ pairId, count }: { pairId: string; count: number }) {
	const { t } = useTranslation("sync")
	const paged = usePagedEntries<DesktopSyncConflict>(`${pairId}:${String(count)}`, (offset, limit) =>
		syncApi().conflicts(pairId, offset, limit)
	)
	const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set())
	const [resolving, setResolving] = useState<string | null>(null)

	async function resolve(relPath: string, resolution: DesktopSyncResolution): Promise<void> {
		setResolving(relPath)

		const done = await runSyncAction(() => syncApi().resolveConflict(pairId, relPath, resolution))

		setResolving(null)

		if (done !== null) {
			setResolved(previous => new Set(previous).add(relPath))

			if (done.value !== null) {
				toast.success(t("conflictKeptBoth", { path: done.value }))
			}
		}
	}

	return (
		<SettingsGroup
			title={t("issuesConflictsTitle")}
			description={t("issuesConflictsDescription")}
		>
			{paged.entries
				.filter(conflict => !resolved.has(conflict.relPath))
				.map(conflict => (
					<EntryRow
						key={conflict.relPath}
						path={conflict.relPath}
						detail={t(conflictDetailKey(conflict))}
					>
						{RESOLUTIONS.map(resolution => (
							<Button
								key={resolution.value}
								variant="outline"
								size="sm"
								disabled={resolving !== null}
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
		</SettingsGroup>
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
		</>
	)
}

// The deletions the last pass held back, and the approval of exactly those (the shell's pass token).
function HeldSection({ pairId, count }: { pairId: string; count: number }) {
	const { t } = useTranslation(["sync", "common"])
	const read = useSyncRead(`${pairId}:${String(count)}`, () => syncApi().heldDeletions(pairId))
	const [confirming, setConfirming] = useState(false)
	const [approving, setApproving] = useState(false)
	const held = read.data
	const token = held?.passToken ?? null

	async function approve(): Promise<void> {
		if (token === null) {
			return
		}

		setApproving(true)

		const done = await runSyncAction(() => syncApi().approveDeletions(pairId, token))

		setApproving(false)

		if (done !== null) {
			setConfirming(false)
			read.reload()
		}
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
				<SettingsBlock className="flex justify-end">
					<Button
						variant="destructive"
						disabled={token === null || held === undefined || held.total === 0}
						onClick={() => {
							setConfirming(true)
						}}
					>
						{t("heldApprove")}
					</Button>
				</SettingsBlock>
			</SettingsGroup>
			<ConfirmDialog
				open={confirming}
				pending={approving}
				title={t("heldApproveTitle")}
				body={t("heldApproveBody", { count: held?.total ?? 0 })}
				confirmLabel={t("heldApprove")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={setConfirming}
				onConfirm={() => {
					void approve()
				}}
			/>
		</>
	)
}

// Unsyncable items are only listed in a dry run, so the section plans the pair once while it shows (and releases
// the plan again); Retry clears an item's failure record so the next pass tries it again.
function UnsyncableSection({ pairId, count }: { pairId: string; count: number }) {
	const { t } = useTranslation("sync")
	const planRead = useSyncRead(`${pairId}:${String(count)}`, () => syncApi().plan(pairId))
	const planId = planRead.data?.planId ?? null
	const paged = usePagedEntries<DesktopSyncUnsyncable>(planId, async (offset, limit) => {
		const result = await syncApi().planPage(planId ?? "", "unsyncable", offset, limit)

		if (!result.ok) {
			return result
		}

		return { ok: true, value: { total: result.value.total, entries: result.value.list === "unsyncable" ? result.value.entries : [] } }
	})
	const [retried, setRetried] = useState<ReadonlySet<string>>(() => new Set())

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

	async function retry(relPath: string): Promise<void> {
		if ((await runSyncAction(() => syncApi().retryPath(pairId, relPath))) !== null) {
			setRetried(previous => new Set(previous).add(relPath))
		}
	}

	return (
		<SettingsGroup title={t("unsyncableTitle")}>
			{planRead.error !== null ? (
				<SettingsBlock>
					<p
						role="alert"
						className="text-sm text-destructive"
					>
						{syncErrorLabel(planRead.error)}
					</p>
				</SettingsBlock>
			) : planRead.data === null ? (
				// The cloud side has not caught up, so there is no dry run to list them from yet.
				<SettingsBlock className="text-sm text-muted-foreground">{t("reviewUnconverged")}</SettingsBlock>
			) : planRead.data === undefined ? (
				<SettingsBlock className="flex justify-center">
					<Spinner className="size-5 text-muted-foreground" />
				</SettingsBlock>
			) : (
				<>
					{paged.entries
						.filter(entry => !retried.has(entry.relPath))
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
				</>
			)}
		</SettingsGroup>
	)
}

// What the pair needs the user for: the last error, conflicts, held deletions, unsyncable items. Each section
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
				lastError: pair?.lastError ?? null
			}
		})
	)

	if (issues.conflicts + issues.heldDeletions + issues.unsyncable + issues.failed === 0 && issues.lastError === null) {
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
			{issues.lastError === null && issues.failed === 0 ? null : (
				<SettingsGroup title={t("issuesLastError")}>
					{issues.lastError === null ? null : (
						<SettingsBlock className="font-mono text-xs break-words whitespace-pre-wrap">{issues.lastError}</SettingsBlock>
					)}
					{issues.failed === 0 ? null : (
						<SettingsBlock className="text-sm text-muted-foreground">
							{t("issuesFailed", { count: issues.failed })}
						</SettingsBlock>
					)}
				</SettingsGroup>
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
				/>
			) : null}
			{issues.unsyncable > 0 ? (
				<UnsyncableSection
					pairId={pairId}
					count={issues.unsyncable}
				/>
			) : null}
		</div>
	)
}
