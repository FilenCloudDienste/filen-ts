import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { MinusIcon, PlusIcon } from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { registerAction } from "@/lib/keymap/registry"
import { useAction } from "@/lib/keymap/useAction"
import { selectableForSelectAll } from "@/features/drive/lib/selectionFlags"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { usePhotosSelection } from "@/features/photos/hooks/usePhotosSelection"
import { usePhotosDialogHost } from "@/features/photos/hooks/usePhotosDialogHost"
import { usePhotosGridDensityQuery } from "@/features/photos/queries/preferences"
import { setPhotosGridDensity } from "@/features/photos/lib/gridDensity"
import {
	DENSITY_STEPS,
	DEFAULT_DENSITY_INDEX,
	clampDensityIndex,
	tileSizeForDensity,
	columnsForWidth
} from "@/features/photos/lib/gridDensity"
import { PhotoTile } from "@/features/photos/components/photoTile"
import { PhotosBulkActionBar } from "@/features/photos/components/bulkActionBar"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const GRID_GAP = 8
const GRID_OVERSCAN = 3
// Bulk bar only earns its own floating UI at 2+ selected — a single selection is already fully
// covered by that one tile's own context menu (photosItemActions), unlike drive's listing which
// shows its bar from 1 (a deliberate photos-only threshold, not a drive gating drift).
const BULK_BAR_MIN_SELECTION = 2

// Module scope, not inside the component — registerAction is idempotent-by-id across remounts/HMR
// (mirrors directoryListing.tsx's own identical module-scope registration).
registerAction({ id: "photos.selectAll", defaultCombo: "mod+a", scope: "photos", descriptionKey: "driveCommandSelectAll" })
registerAction({ id: "photos.clearSelection", defaultCombo: "escape", scope: "photos", descriptionKey: "driveCommandClearSelection" })

export interface PhotoGridProps {
	rootUuid: string
	items: PhotoItem[]
}

export function PhotoGrid({ rootUuid, items }: PhotoGridProps) {
	const { t } = useTranslation(["drive", "photos"])
	const densityQuery = usePhotosGridDensityQuery()
	const densityIndex = densityQuery.data ?? DEFAULT_DENSITY_INDEX
	const tileSize = tileSizeForDensity(densityIndex)

	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const [containerWidth, setContainerWidth] = useState(0)
	const [anchorUuid, setAnchorUuid] = useState<string | null>(null)

	const selectedItems = usePhotosStore(useShallow(state => state.selectedItems))
	const { handlePointerSelect } = usePhotosSelection(items, anchorUuid, setAnchorUuid)
	const { isDialogOpen, handleItemAction, handleBulkDialogAction, renderActiveDialog } = usePhotosDialogHost({ rootUuid, selectedItems })

	// A fresh root must never inherit a previous root's selection/anchor — mirrors drive's own
	// [variant, splat]-keyed reset effect (useDriveListboxNav.ts), keyed here on rootUuid alone since
	// photos has no nested navigation to reset against.
	useEffect(() => {
		usePhotosStore.getState().clearSelectedItems()
		setAnchorUuid(null)
	}, [rootUuid])

	useEffect(() => {
		if (!scrollElement) {
			return
		}

		const observer = new ResizeObserver(entries => {
			const entry = entries[0]

			if (entry) {
				setContainerWidth(entry.contentRect.width)
			}
		})

		observer.observe(scrollElement)

		return () => {
			observer.disconnect()
		}
	}, [scrollElement])

	const columns = columnsForWidth(containerWidth, tileSize)
	const rowCount = Math.ceil(items.length / columns)

	const virtualizer = useVirtualizer({
		count: rowCount,
		getScrollElement: () => scrollElement,
		estimateSize: () => tileSize + GRID_GAP,
		overscan: GRID_OVERSCAN,
		getItemKey: index => index
	})

	useAction(
		"photos.selectAll",
		keyboardEvent => {
			if (isDialogOpen) {
				return
			}

			keyboardEvent.preventDefault()
			// selectableForSelectAll's undecryptable filter is a no-op here (isPhotoItem's own
			// precondition already excludes undecryptable rows) — reused for the same defense-in-depth
			// reason the drive listing keeps it rather than assuming the invariant holds forever.
			usePhotosStore.getState().setSelectedItems(selectableForSelectAll(items) as PhotoItem[])
		},
		undefined,
		[isDialogOpen, items]
	)

	useAction(
		"photos.clearSelection",
		() => {
			if (isDialogOpen) {
				return
			}

			usePhotosStore.getState().clearSelectedItems()
		},
		undefined,
		[isDialogOpen]
	)

	async function handleDensityChange(nextIndex: number): Promise<void> {
		const clamped = clampDensityIndex(nextIndex)

		await setPhotosGridDensity(clamped)
		void densityQuery.refetch()
	}

	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
			<div className="flex shrink-0 items-center justify-end gap-1 px-4 py-2">
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("photos:photosDensityDecrease")}
								disabled={densityIndex <= 0}
								onClick={() => {
									void handleDensityChange(densityIndex - 1)
								}}
							>
								<MinusIcon />
							</Button>
						}
					/>
					<TooltipContent>{t("photos:photosDensityDecrease")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("photos:photosDensityIncrease")}
								disabled={densityIndex >= DENSITY_STEPS.length - 1}
								onClick={() => {
									void handleDensityChange(densityIndex + 1)
								}}
							>
								<PlusIcon />
							</Button>
						}
					/>
					<TooltipContent>{t("photos:photosDensityIncrease")}</TooltipContent>
				</Tooltip>
			</div>
			<div
				ref={setScrollElement}
				role="listbox"
				aria-multiselectable="true"
				aria-label={t("photos:photosGridLabel")}
				tabIndex={-1}
				className="min-h-0 flex-1 overflow-y-auto px-4"
			>
				<div style={{ position: "relative", width: "100%", height: virtualizer.getTotalSize() }}>
					{virtualizer.getVirtualItems().map(virtualRow => (
						<div
							key={virtualRow.key}
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								width: "100%",
								transform: `translateY(${String(virtualRow.start)}px)`,
								display: "grid",
								gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
								gap: GRID_GAP
							}}
						>
							{Array.from({ length: columns }, (_, column) => {
								const itemIndex = virtualRow.index * columns + column
								const item = items[itemIndex]

								if (!item) {
									return null
								}

								return (
									<PhotoTile
										key={item.data.uuid}
										rootUuid={rootUuid}
										item={item}
										index={itemIndex}
										selected={selectedItems.some(selected => selected.data.uuid === item.data.uuid)}
										size={tileSize}
										onPointerSelect={handlePointerSelect}
										onItemAction={handleItemAction}
									/>
								)
							})}
						</div>
					))}
				</div>
			</div>
			{selectedItems.length >= BULK_BAR_MIN_SELECTION ? (
				<div className="pointer-events-none absolute inset-x-6 bottom-6 z-10 flex justify-center">
					<PhotosBulkActionBar
						rootUuid={rootUuid}
						selectedItems={selectedItems}
						onDialogAction={handleBulkDialogAction}
					/>
				</div>
			) : null}
			{renderActiveDialog()}
		</div>
	)
}
