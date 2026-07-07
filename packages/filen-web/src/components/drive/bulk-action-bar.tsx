import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { XIcon } from "lucide-react"
import { type DriveItem } from "@/lib/drive/item"
import { type DriveVariant } from "@/lib/drive/preferences"
import { aggregateDriveSelectionFlags } from "@/lib/drive/selection-flags"
import { setFavoritedItems } from "@/lib/drive/actions"
import { toastBulkOutcome } from "@/lib/drive/bulk-toast"
import { useDriveStore } from "@/stores/drive"
import { driveBulkActions, type BulkActionDescriptor, type BulkDialogActionKind } from "@/components/drive/bulk-action-bar.logic"
import { Kbd } from "@/lib/keymap/Kbd"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export type { BulkDialogActionKind }

export interface BulkActionBarProps {
	variant: DriveVariant
	selectedItems: DriveItem[]
	onDialogAction: (kind: BulkDialogActionKind) => void
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

	function runDescriptor(descriptor: BulkActionDescriptor): void {
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
					const buttonProps = {
						variant: descriptor.destructive ? ("destructive" as const) : ("outline" as const),
						size: "sm" as const,
						onClick: () => {
							runDescriptor(descriptor)
						}
					}

					// Trash duplicates the drive.trash keyboard command exactly (same selection, same
					// dialog) — surfaced here so the shortcut stays discoverable from the bar too, matching
					// every other toolbar trigger's own Tooltip+Kbd pairing (NewDirectory/ViewModeToggle).
					// None of the other bulk actions have a registered shortcut yet.
					if (descriptor.id !== "trash") {
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
								<Kbd action="drive.trash" />
							</TooltipContent>
						</Tooltip>
					)
				})}
			</div>
		</>
	)
}
