import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { formatBytes } from "@filen/utils"
import { CheckIcon, HistoryIcon, RotateCcwIcon, Trash2Icon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import type { FileVersion } from "@filen/sdk-rs"
import { i18n } from "@/lib/i18n"
import { type FileItem, restoreVersion, deleteVersion, deleteVersions } from "@/features/drive/lib/actions"
import { type BulkOutcome } from "@/features/drive/lib/bulk"
import { formatVersionTimestamp } from "@/features/drive/lib/format"
import { fileVersionsQueryKey, useFileVersionsQuery } from "@/features/drive/queries/drive"
import { queryClient } from "@/queries/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import {
	hasNoPreviousVersions,
	isCurrentVersion,
	isEverySelected,
	nonCurrentVersions
} from "@/features/drive/components/versionsDialog.logic"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export interface VersionsDialogProps {
	file: FileItem
	onClose: () => void
}

// A row's pending confirmation — restore/delete (single version) and the two multi-version bulk
// actions (delete-selected, delete-all) all share this one nested ConfirmDialog (below) rather than
// four near-duplicate instances, so at most one in-flight confirmation can ever exist at a time.
type PendingConfirm = { kind: "restore" | "delete"; version: FileVersion } | { kind: "bulkDelete"; versions: FileVersion[] }

// Same partial-success counting bulkToast.ts does for BulkOutcome<DriveItem> — kept local rather than
// widening that helper's DriveItem-specific typing (mirrors upload.ts's own precedent: a non-DriveItem
// bulk outcome counts itself instead of forcing a mismatched reuse).
function toastVersionsBulkOutcome(outcome: BulkOutcome<FileVersion>): void {
	if (outcome.succeeded.length === 0 && outcome.failed.length === 0) {
		return
	}

	if (outcome.failed.length === 0) {
		toast.success(i18n.t("drive:driveVersionsBulkDeleteComplete", { count: outcome.succeeded.length }))
		return
	}

	toast.error(
		i18n.t("drive:driveVersionsBulkDeleteCompleteWithFailures", { count: outcome.succeeded.length, failed: outcome.failed.length })
	)
}

// File-version history panel — mounted-when-active by the listing's dialog host. Restoring rotates
// the file's own uuid (actions.ts's restoreVersion already patches the drive-listing cache for that),
// so a successful restore closes the whole panel: the file this panel is about no longer exists under
// its old identity. Deleting a version (single, multi-select, or all-at-once) is scoped to just those
// rows — the panel stays open so several old versions can be cleared out in one sitting, matching
// filen-mobile's version-history screen. Every delete path confirms first (mobile parity — a permanent,
// irreversible action), and so does restore (a consequential content change, not merely a metadata
// edit). Selection has no checkboxes (matches drive/notes/chats' own no-checkbox convention): a selected row highlights instead, toggled by a plain click while in
// select mode.
export function VersionsDialog({ file, onClose }: VersionsDialogProps) {
	const { t } = useTranslation(["drive", "common"])
	const versionsQuery = useFileVersionsQuery(file.data)
	const [pending, setPending] = useState(false)
	const [confirming, setConfirming] = useState<PendingConfirm | null>(null)
	const [selectMode, setSelectMode] = useState(false)
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

	const versions = versionsQuery.status === "success" ? versionsQuery.data : []
	const candidates = nonCurrentVersions(versions, file)
	const selectedVersions = candidates.filter(version => selected.has(version.uuid))

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pending)) {
			details.cancel()
			return
		}

		if (!next) {
			onClose()
		}
	}

	function exitSelectMode(): void {
		setSelectMode(false)
		setSelected(new Set())
	}

	function toggleVersionSelected(uuid: string): void {
		setSelected(prev => {
			const next = new Set(prev)

			if (next.has(uuid)) {
				next.delete(uuid)
			} else {
				next.add(uuid)
			}

			return next
		})
	}

	function toggleSelectAll(): void {
		setSelected(isEverySelected(selected, versions, file) ? new Set() : new Set(candidates.map(version => version.uuid)))
	}

	async function handleRestoreConfirmed(version: FileVersion): Promise<void> {
		setPending(true)
		const outcome = await restoreVersion(file, version)
		setPending(false)
		setConfirming(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		onClose()
	}

	async function handleDeleteConfirmed(version: FileVersion): Promise<void> {
		setPending(true)
		const outcome = await deleteVersion(file, version)
		setPending(false)
		setConfirming(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		// deleteVersion has no listing-cache effect of its own (a historical version isn't part of any
		// drive listing) — this panel's own versions read is the only cache that needs to drop the row.
		queryClient.setQueryData<FileVersion[]>(fileVersionsQueryKey(file.data.uuid), prev =>
			prev?.filter(existing => existing.uuid !== version.uuid)
		)
	}

	async function handleBulkDeleteConfirmed(targets: FileVersion[]): Promise<void> {
		setPending(true)
		const outcome = await deleteVersions(file, targets)
		setPending(false)
		setConfirming(null)
		toastVersionsBulkOutcome(outcome)

		// Widened to plain `Set<string>` (not the branded UuidStr the FileVersion arm carries) — `selected`
		// below is a plain string set (no dependency on the SDK's own uuid brand), so both `.has` calls
		// need to compare against the same widened type.
		const succeededUuids = new Set<string>(outcome.succeeded.map(version => version.uuid))
		queryClient.setQueryData<FileVersion[]>(fileVersionsQueryKey(file.data.uuid), prev =>
			prev?.filter(existing => !succeededUuids.has(existing.uuid))
		)
		// A failed version stays selected so the user can retry just that one; a succeeded one is gone
		// from the list entirely, so it's dropped from the selection along with it.
		setSelected(prev => new Set([...prev].filter(uuid => !succeededUuids.has(uuid))))

		if (outcome.failed.length === 0) {
			exitSelectMode()
		}
	}

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent closeButtonDisabled={pending}>
				<DialogHeader>
					<DialogTitle>{t("driveVersionsPanelTitle")}</DialogTitle>
				</DialogHeader>
				{candidates.length > 0 ? (
					<div className="flex items-center justify-end gap-2">
						{selectMode ? (
							<>
								<Button
									variant="ghost"
									size="sm"
									disabled={pending}
									onClick={toggleSelectAll}
								>
									{t("driveVersionsSelectAllAction")}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									disabled={pending}
									onClick={exitSelectMode}
								>
									{t("common:cancel")}
								</Button>
							</>
						) : (
							<Button
								variant="ghost"
								size="sm"
								disabled={pending}
								onClick={() => {
									setSelectMode(true)
								}}
							>
								{t("driveVersionsSelectAction")}
							</Button>
						)}
					</div>
				) : null}
				{versionsQuery.status === "pending" ? (
					<div className="flex justify-center py-8">
						<Spinner />
					</div>
				) : versionsQuery.status === "error" ? (
					<p className="text-sm text-destructive">{errorLabel(asErrorDTO(versionsQuery.error))}</p>
				) : hasNoPreviousVersions(versionsQuery.data, file) ? (
					<Empty className="p-6">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HistoryIcon />
							</EmptyMedia>
							<EmptyTitle>{t("driveVersionsEmpty")}</EmptyTitle>
						</EmptyHeader>
					</Empty>
				) : (
					<ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
						{versionsQuery.data.map(version => {
							// The live version can't be usefully restored (it's already current) nor safely
							// deleted (its uuid IS the file's own current storage blob — deleting it would
							// destroy the file's live content, not just history).
							const current = isCurrentVersion(version, file)
							const isSelected = selected.has(version.uuid)

							return (
								<li key={version.uuid}>
									{selectMode ? (
										<button
											type="button"
											disabled={pending || current}
											aria-pressed={isSelected}
											onClick={() => {
												toggleVersionSelected(version.uuid)
											}}
											className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm outline-none not-aria-pressed:hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-accent aria-pressed:text-accent-foreground"
										>
											<span
												aria-hidden="true"
												className={cn(
													"flex size-5 shrink-0 items-center justify-center rounded-full ring-1 ring-foreground/25",
													isSelected && "bg-primary ring-primary"
												)}
											>
												{isSelected ? <CheckIcon className="size-3.5 text-primary-foreground" /> : null}
											</span>
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-2">
													<span>{formatVersionTimestamp(version.timestamp)}</span>
													{current ? <Badge variant="secondary">{t("driveVersionsCurrentBadge")}</Badge> : null}
												</div>
												<span className="text-xs text-muted-foreground">{formatBytes(Number(version.size))}</span>
											</div>
										</button>
									) : (
										<div className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm">
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-2">
													<span>{formatVersionTimestamp(version.timestamp)}</span>
													{current ? <Badge variant="secondary">{t("driveVersionsCurrentBadge")}</Badge> : null}
												</div>
												<span className="text-xs text-muted-foreground">{formatBytes(Number(version.size))}</span>
											</div>
											<Button
												variant="ghost"
												size="icon-sm"
												disabled={pending || current}
												aria-label={t("driveVersionsRestoreAction")}
												onClick={() => {
													setConfirming({ kind: "restore", version })
												}}
											>
												<RotateCcwIcon />
											</Button>
											<Button
												variant="ghost"
												size="icon-sm"
												disabled={pending || current}
												aria-label={t("driveVersionsDeleteAction")}
												onClick={() => {
													setConfirming({ kind: "delete", version })
												}}
											>
												<Trash2Icon />
											</Button>
										</div>
									)}
								</li>
							)
						})}
					</ul>
				)}
				{candidates.length > 0 ? (
					<DialogFooter>
						{selectMode ? (
							<>
								<span className="mr-auto self-center text-sm text-muted-foreground">
									{t("driveVersionsSelectedCount", { count: selectedVersions.length })}
								</span>
								<Button
									variant="destructive"
									disabled={pending || selectedVersions.length === 0}
									onClick={() => {
										setConfirming({ kind: "bulkDelete", versions: selectedVersions })
									}}
								>
									{pending && <Spinner data-icon="inline-start" />}
									{t("driveVersionsDeleteSelectedAction")}
								</Button>
							</>
						) : (
							<Button
								variant="destructive"
								disabled={pending}
								onClick={() => {
									setConfirming({ kind: "bulkDelete", versions: candidates })
								}}
							>
								{pending && <Spinner data-icon="inline-start" />}
								{t("driveVersionsDeleteAllAction")}
							</Button>
						)}
					</DialogFooter>
				) : null}
			</DialogContent>
			{/* Nested confirmation dialog — Base UI supports nesting a dialog inside another normally (see
			its own "Nested dialogs" docs); this must stay a child of the outer Dialog, not a sibling
			rendered outside it, for the stacked focus-trap/backdrop behavior to apply. Shared by restore,
			single delete, and both bulk-delete paths (see PendingConfirm) — every one of them reads as
			destructive (restore overwrites the file's current content; delete is permanent). */}
			<ConfirmDialog
				open={confirming !== null}
				pending={pending}
				title={
					confirming?.kind === "restore"
						? t("driveVersionsRestoreConfirmTitle")
						: confirming?.kind === "bulkDelete"
							? t("driveVersionsBulkDeleteConfirmTitle")
							: t("driveVersionsDeleteConfirmTitle")
				}
				body={
					confirming?.kind === "restore"
						? t("driveVersionsRestoreConfirmBody")
						: confirming?.kind === "bulkDelete"
							? t("driveVersionsBulkDeleteConfirmBody", { count: confirming.versions.length })
							: t("driveVersionsDeleteConfirmBody")
				}
				confirmLabel={
					confirming?.kind === "restore"
						? t("driveVersionsRestoreAction")
						: confirming?.kind === "bulkDelete"
							? t("driveVersionsDeleteSelectedAction")
							: t("driveVersionsDeleteAction")
				}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					if (!open) {
						setConfirming(null)
					}
				}}
				onConfirm={() => {
					if (!confirming) {
						return
					}
					if (confirming.kind === "restore") {
						void handleRestoreConfirmed(confirming.version)
						return
					}
					if (confirming.kind === "bulkDelete") {
						void handleBulkDeleteConfirmed(confirming.versions)
						return
					}
					void handleDeleteConfirmed(confirming.version)
				}}
			/>
		</Dialog>
	)
}
