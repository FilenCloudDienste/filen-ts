import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { XIcon } from "lucide-react"
import { type BulkDialogActionKind } from "@/features/drive/components/bulkActionBar.logic"
import { aggregateDriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { startDownloads } from "@/features/drive/lib/download"
import { photosBulkActions, type BulkActionDescriptor } from "@/features/photos/lib/bulkActions"
import { setFavoritedPhotos } from "@/features/photos/lib/actions"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export interface PhotosBulkActionBarProps {
	rootUuid: string
	selectedItems: PhotoItem[]
	onDialogAction: (kind: BulkDialogActionKind) => void
}

// Floating selection bar for the photos grid — mirrors drive's own bulkActionBar.tsx layout/behavior
// against photosBulkActions' fixed descriptor set instead of driveBulkActions' variant dispatch, and
// against the photos-scoped selection store + cache-patching action wrappers instead of drive's own.
export function PhotosBulkActionBar({ rootUuid, selectedItems, onDialogAction }: PhotosBulkActionBarProps) {
	const { t } = useTranslation(["drive", "photos", "common"])
	const isOnline = useIsOnline()
	const flags = aggregateDriveSelectionFlags(selectedItems)
	const descriptors = photosBulkActions(flags)

	async function handleBulkFavorite(): Promise<void> {
		const outcome = await setFavoritedPhotos(rootUuid, selectedItems, !flags.includesFavorited)
		toastBulkOutcome(outcome)
		usePhotosStore.getState().removeFromSelection(outcome.succeeded.map(item => item.data.uuid))
	}

	// download is checked first — startDownloads' FSA save picker needs this click's own live user
	// gesture (mirrors drive's identical ordering rationale), so nothing here may yield ahead of it.
	function runDescriptor(descriptor: BulkActionDescriptor): void {
		if (descriptor.id === "download") {
			void startDownloads(selectedItems)
			return
		}

		if (descriptor.run === "direct") {
			void handleBulkFavorite()
			return
		}

		onDialogAction(descriptor.dialogKind)
	}

	return (
		<div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-popover px-3 py-2 text-popover-foreground shadow-lg">
			<div className="flex items-center gap-2">
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("driveCommandClearSelection")}
								onClick={() => {
									usePhotosStore.getState().clearSelectedItems()
								}}
							>
								<XIcon />
							</Button>
						}
					/>
					<TooltipContent>{t("driveCommandClearSelection")}</TooltipContent>
				</Tooltip>
				<p className="text-sm text-muted-foreground">{t("driveSelectionCount", { count: selectedItems.length })}</p>
			</div>
			<div className="flex items-center gap-2">
				{descriptors.map(descriptor => {
					const offlineDisabled = !isOnline && (descriptor.id === "trash" || descriptor.id === "download")
					const disabled = (descriptor.id === "download" && selectedItems.length === 0) || offlineDisabled

					return (
						<Tooltip key={descriptor.id}>
							<TooltipTrigger
								render={
									<Button
										variant={descriptor.destructive ? "destructive" : "outline"}
										size="icon-sm"
										disabled={disabled}
										aria-label={t(descriptor.labelKey)}
										onClick={() => {
											runDescriptor(descriptor)
										}}
									>
										{createElement(descriptor.icon, { "aria-hidden": true })}
									</Button>
								}
							/>
							<TooltipContent>{offlineDisabled ? t("common:offlineActionDisabled") : t(descriptor.labelKey)}</TooltipContent>
						</Tooltip>
					)
				})}
			</div>
		</div>
	)
}
