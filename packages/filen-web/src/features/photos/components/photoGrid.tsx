import { useEffect, useState, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { MinusIcon, PlusIcon } from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useAction } from "@/lib/keymap/useAction"
import { useIsOnline } from "@/lib/useIsOnline"
import { selectableForSelectAll } from "@/features/drive/lib/selectionFlags"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { usePhotosSelection } from "@/features/photos/hooks/usePhotosSelection"
import { usePhotosGridNav } from "@/features/photos/hooks/usePhotosGridNav"
import { useMarqueeSelection } from "@/features/drive/hooks/useMarqueeSelection"
import { usePhotosDialogHost } from "@/features/photos/hooks/usePhotosDialogHost"
import { resolveTileClickIntent, previewOpenTarget } from "@/features/photos/components/photoGrid.logic"
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

export interface PhotoGridProps {
	rootUuid: string
	items: PhotoItem[]
}

export function PhotoGrid({ rootUuid, items }: PhotoGridProps) {
	const { t } = useTranslation(["drive", "photos"])
	const isOnline = useIsOnline()
	const densityQuery = usePhotosGridDensityQuery()
	const densityIndex = densityQuery.data ?? DEFAULT_DENSITY_INDEX
	const tileSize = tileSizeForDensity(densityIndex)

	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const [containerWidth, setContainerWidth] = useState(0)
	const [anchorUuid, setAnchorUuid] = useState<string | null>(null)

	const selectedItems = usePhotosStore(useShallow(state => state.selectedItems))
	const { handlePointerSelect } = usePhotosSelection(items, anchorUuid, setAnchorUuid)
	const { isDialogOpen, handleItemAction, handleBulkDialogAction, openPreview, renderActiveDialog } = usePhotosDialogHost({
		rootUuid,
		selectedItems
	})

	// Plain click opens the viewer (browsing is the grid's whole point); once a selection is active a
	// plain click instead falls through to handlePointerSelect's own replace-with-just-this-item branch,
	// exactly matching drive's plain-click convention on an already-selected tile. A modifier click
	// always builds/extends the selection regardless of selection state — see photoGrid.logic.ts's own
	// doc comment on resolveTileClickIntent for the full decision table.
	function handleTileClick(index: number, event: MouseEvent<HTMLDivElement>): void {
		const intent = resolveTileClickIntent(event, selectedItems.length > 0)

		if (intent.kind === "open") {
			handleOpenAt(index)

			return
		}

		handlePointerSelect(index, event)
		// The cursor follows the click, exactly as drive's own handlePointerSelect moves activeUuid.
		setActive(index)
	}

	// One open path shared by a plain click and Enter.
	function handleOpenAt(index: number): void {
		const target = previewOpenTarget(items, index)

		if (target) {
			openPreview(target.sources, target.index)
		}
	}

	// A fresh root must never inherit a previous root's selection/anchor/cursor — mirrors drive's own
	// [variant, splat]-keyed reset effect (useDriveListboxNav.ts), keyed here on rootUuid alone since
	// photos has no nested navigation to reset against.
	useEffect(() => {
		usePhotosStore.getState().clearSelectedItems()
		setAnchorUuid(null)
		resetCursor()
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

	const columns = columnsForWidth(containerWidth, tileSize, GRID_GAP)
	const rowCount = Math.ceil(items.length / columns)

	const virtualizer = useVirtualizer({
		count: rowCount,
		getScrollElement: () => scrollElement,
		estimateSize: () => tileSize + GRID_GAP,
		overscan: GRID_OVERSCAN,
		getItemKey: index => index
	})

	const { safeActiveIndex, handleKeyDown, registerRef, setActive, setCursor, resetCursor } = usePhotosGridNav({
		items,
		columns,
		virtualizer,
		anchorUuid,
		setAnchorUuid,
		onOpen: handleOpenAt
	})

	// Rubber-band selection over blank grid space — the same hook the drive listing uses, with photos'
	// own tile geometry and selection store injected. The hook measures the container's px-4 padding
	// itself, so this call site passes no origin/width.
	const marquee = useMarqueeSelection({
		items,
		viewMode: "grid",
		columns,
		geometry: { rowHeight: tileSize + GRID_GAP, tileWidth: tileSize, gap: GRID_GAP },
		selection: {
			read: () => usePhotosStore.getState().selectedItems,
			write: next => {
				usePhotosStore.getState().setSelectedItems(next)
			}
		},
		scrollElement,
		setCursor
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

	// Gated on the same threshold that mounts the bulk bar and on the same offline rule its Trash button
	// uses (bulkActionBar.tsx) — a trash has nothing to reach without a connection. preventDefault:
	// Backspace still has a "go back" default in some engines.
	useAction(
		"photos.trash",
		keyboardEvent => {
			keyboardEvent.preventDefault()

			if (isDialogOpen || !isOnline || selectedItems.length < BULK_BAR_MIN_SELECTION) {
				return
			}

			handleBulkDialogAction("trash")
		},
		undefined,
		[isDialogOpen, isOnline, selectedItems]
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
				// Drive parity (directoryListing.tsx): the tab stop is the ACTIVE tile's own tabIndex={0},
				// never the container.
				tabIndex={-1}
				className="min-h-0 flex-1 overflow-y-auto px-4"
				onKeyDown={handleKeyDown}
				onPointerDown={marquee.onPointerDown}
			>
				<div style={{ position: "relative", width: "100%", height: virtualizer.getTotalSize() }}>
					{/* Marquee rectangle — content-space, so it stretches correctly as the grid auto-scrolls, and
					    the FIRST child of the sized wrapper so it shares the tiles' own content-space origin.
					    Non-interactive (pointer-events-none) so it never intercepts the ongoing drag. */}
					{marquee.rect ? (
						<div
							aria-hidden="true"
							data-testid="marquee-rect"
							className="pointer-events-none absolute z-20 rounded-xs border border-primary/60 bg-primary/15"
							style={{
								left: marquee.rect.left,
								top: marquee.rect.top,
								width: marquee.rect.right - marquee.rect.left,
								height: marquee.rect.bottom - marquee.rect.top
							}}
						/>
					) : null}
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
										active={itemIndex === safeActiveIndex}
										size={tileSize}
										registerRef={registerRef}
										onTileClick={handleTileClick}
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
