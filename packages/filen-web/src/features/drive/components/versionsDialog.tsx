import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { formatBytes } from "@filen/utils"
import { HistoryIcon, RotateCcwIcon, Trash2Icon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import type { FileVersion } from "@filen/sdk-rs"
import { type FileItem, restoreVersion, deleteVersion } from "@/features/drive/lib/actions"
import { formatVersionTimestamp } from "@/features/drive/lib/format"
import { fileVersionsQueryKey, useFileVersionsQuery } from "@/features/drive/queries/drive"
import { queryClient } from "@/queries/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { hasNoPreviousVersions, isCurrentVersion } from "@/features/drive/components/versionsDialog.logic"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export interface VersionsDialogProps {
	file: FileItem
	onClose: () => void
}

// A row's pending confirmation — restore and delete share one nested ConfirmDialog (below) rather
// than two near-duplicate instances, so the in-flight action is tracked as a single discriminated
// slot instead of two independent version-or-null states that could (even if only in principle)
// both be set at once.
interface PendingConfirm {
	kind: "restore" | "delete"
	version: FileVersion
}

// File-version history panel — mounted-when-active by the listing's dialog host. Restoring rotates
// the file's own uuid (actions.ts's restoreVersion already patches the drive-listing cache for that),
// so a successful restore closes the whole panel: the file this panel is about no longer exists under
// its old identity. Deleting a version is scoped to just that row — the panel stays open so several
// old versions can be cleared out in one sitting, matching filen-mobile's version-history screen.
// Both restore and delete confirm first (mobile parity — restoring is a consequential content change,
// not merely a metadata edit).
export function VersionsDialog({ file, onClose }: VersionsDialogProps) {
	const { t } = useTranslation(["drive", "common"])
	const versionsQuery = useFileVersionsQuery(file.data)
	const [pending, setPending] = useState(false)
	const [confirming, setConfirming] = useState<PendingConfirm | null>(null)

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pending)) {
			details.cancel()
			return
		}

		if (!next) {
			onClose()
		}
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

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent closeButtonDisabled={pending}>
				<DialogHeader>
					<DialogTitle>{t("driveVersionsPanelTitle")}</DialogTitle>
				</DialogHeader>
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

							return (
								<li
									key={version.uuid}
									className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm"
								>
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
								</li>
							)
						})}
					</ul>
				)}
			</DialogContent>
			{/* Nested confirmation dialog — Base UI supports nesting a dialog inside another normally (see
			its own "Nested dialogs" docs); this must stay a child of the outer Dialog, not a sibling
			rendered outside it, for the stacked focus-trap/backdrop behavior to apply. Shared by both
			restore and delete (see PendingConfirm) rather than one instance per action — both read as
			destructive (restore overwrites the file's current content; delete is permanent). */}
			<ConfirmDialog
				open={confirming !== null}
				pending={pending}
				title={confirming?.kind === "restore" ? t("driveVersionsRestoreConfirmTitle") : t("driveVersionsDeleteConfirmTitle")}
				body={confirming?.kind === "restore" ? t("driveVersionsRestoreConfirmBody") : t("driveVersionsDeleteConfirmBody")}
				confirmLabel={confirming?.kind === "restore" ? t("driveVersionsRestoreAction") : t("driveVersionsDeleteAction")}
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
					void handleDeleteConfirmed(confirming.version)
				}}
			/>
		</Dialog>
	)
}
