import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { XIcon } from "lucide-react"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { aggregateDriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { setFavoritedItems } from "@/features/drive/lib/actions"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import {
	driveBulkActions,
	isBulkDownloadEnabled,
	startBulkDownload,
	type BulkActionDescriptor,
	type BulkDialogActionKind
} from "@/features/drive/components/bulkActionBar.logic"
import { Kbd } from "@/lib/keymap/Kbd"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export type { BulkDialogActionKind }

export interface BulkActionBarProps {
	variant: DriveVariant
	selectedItems: DriveItem[]
	onDialogAction: (kind: BulkDialogActionKind) => void
}

// Descriptors with a registered keyboard shortcut get the toolbar's Tooltip+Kbd pairing (mirrors
// NewDirectory/ViewModeToggle); every other descriptor renders as a plain button.
const KEYMAP_ACTION_FOR: Partial<Record<BulkActionDescriptor["id"], string>> = {
	trash: "drive.trash",
	download: "drive.download"
}

// Replaces the toolbar's item-count/New-View-Sort region while a selection exists (mounted by
// directory-listing.tsx). Two flex children so the surrounding `justify-between` row keeps the same
// left-cluster/right-cluster split the non-selected toolbar already has.
export function BulkActionBar({ variant, selectedItems, onDialogAction }: BulkActionBarProps) {
	const { t } = useTranslation("drive")
	const flags = aggregateDriveSelectionFlags(selectedItems)
	const descriptors = driveBulkActions(variant, flags)

	async function handleBulkFavorite(): Promise<void> {
		const outcome = await setFavoritedItems(selectedItems, !flags.includesFavorited)
		toastBulkOutcome(outcome)
		// Mirrors the dialog-routed actions' own cleanup (trash/delete/move confirms) — a succeeded
		// item is pruned from the selection, a failed one stays selected so the user can retry.
		useDriveStore.getState().removeFromSelection(outcome.succeeded.map(item => item.data.uuid))
	}

	// download is checked FIRST, before dialog/favorite — startBulkDownload's FSA save picker needs
	// this click's own live user gesture (see lib/drive/download.ts), so nothing here may yield to the
	// event loop ahead of it. A disabled Button's onClick never fires at all (see the disabled prop
	// below), which today only guards the empty-selection edge case — every dir/multi selection is
	// downloadable too now (the sw zip route).
	function runDescriptor(descriptor: BulkActionDescriptor): void {
		if (descriptor.id === "download") {
			startBulkDownload(selectedItems)
			return
		}

		if (descriptor.run === "direct") {
			void handleBulkFavorite()
			return
		}

		onDialogAction(descriptor.dialogKind)
	}

	return (
		<>
			<div className="flex items-center gap-2">
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("driveCommandClearSelection")}
								onClick={() => {
									useDriveStore.getState().clearSelectedItems()
								}}
							>
								<XIcon />
							</Button>
						}
					/>
					<TooltipContent>
						{t("driveCommandClearSelection")}
						<Kbd action="drive.clearSelection" />
					</TooltipContent>
				</Tooltip>
				<p className="text-sm text-muted-foreground">{t("driveSelectionCount", { count: selectedItems.length })}</p>
			</div>
			<div className="flex items-center gap-2">
				{descriptors.map(descriptor => {
					// isBulkDownloadEnabled is effectively always true here (the bar only mounts once a
					// selection exists) — kept as a defensive check mirroring item-menu.logic.ts's own
					// downloadDescriptor rather than assuming the caller never renders an empty selection.
					// Every other descriptor stays always-enabled.
					const disabled = descriptor.id === "download" && !isBulkDownloadEnabled(selectedItems)
					const buttonProps = {
						variant: descriptor.destructive ? ("destructive" as const) : ("outline" as const),
						size: "sm" as const,
						disabled,
						onClick: () => {
							runDescriptor(descriptor)
						}
					}

					// Trash/Download duplicate their registered keyboard command exactly (same selection,
					// same target) — surfaced here so the shortcut stays discoverable from the bar too,
					// matching every other toolbar trigger's own Tooltip+Kbd pairing (NewDirectory/
					// ViewModeToggle). None of the other bulk actions have a registered shortcut yet.
					const keymapAction = KEYMAP_ACTION_FOR[descriptor.id]

					if (keymapAction === undefined) {
						return (
							<Button
								key={descriptor.id}
								{...buttonProps}
							>
								{createElement(descriptor.icon, { "aria-hidden": true })}
								{t(descriptor.labelKey)}
							</Button>
						)
					}

					return (
						<Tooltip key={descriptor.id}>
							<TooltipTrigger
								render={
									<Button {...buttonProps}>
										{createElement(descriptor.icon, { "aria-hidden": true })}
										{t(descriptor.labelKey)}
									</Button>
								}
							/>
							<TooltipContent>
								{t(descriptor.labelKey)}
								<Kbd action={keymapAction} />
							</TooltipContent>
						</Tooltip>
					)
				})}
			</div>
		</>
	)
}
