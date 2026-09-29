import { useTranslation } from "react-i18next"
import { CheckIcon, PlayIcon, StarIcon } from "lucide-react"
import { ItemThumbnail } from "@/features/drive/components/itemThumbnail"
import { DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { DriveCellContextMenuContent } from "@/features/drive/components/bulkMenu"
import { showVideoBadge } from "@/features/drive/components/driveTile.logic"
import { useDriveItemCell, type DriveItemCellProps } from "@/features/drive/hooks/useDriveItemCell"
import { dropHighlightClass } from "@/features/drive/hooks/useDriveDropTarget"
import { cn } from "@filen/shared"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu } from "@/components/ui/dropdown-menu"
import { RowMenuTrigger } from "@/components/rowMenuTrigger"

// Grid tiles are plain CSS-grid children of an already-positioned virtual row (see
// directoryListing.tsx) — unlike DriveRow, no per-tile absolute-positioning style is needed.
export function DriveTile({
	item,
	index,
	total,
	selected,
	active,
	variant,
	splat,
	searchParentPath,
	selectedItems,
	onPointerSelect,
	onCursorMove,
	onOpen,
	onItemAction,
	destinationActions,
	onBulkAction,
	registerRef
}: DriveItemCellProps) {
	const { t } = useTranslation("drive")
	const { name, open, dragSource, searchHit, destination, drop, shared, bulkMenu, cut, onContextMenu } = useDriveItemCell({
		item,
		index,
		variant,
		splat,
		selected,
		selectedItems,
		searchParentPath,
		destinationActions,
		onOpen,
		onCursorMove
	})

	return (
		<ContextMenu>
			{/* render-prop merge onto the SAME role="option" div (see ui/badge.tsx's idiom / DriveRow's own
			identical comment) — select/open/roving-tabindex are unaffected. */}
			<ContextMenuTrigger
				render={
					<div
						ref={el => {
							registerRef(index, el)
						}}
						role="option"
						aria-selected={selected}
						aria-posinset={index + 1}
						aria-setsize={total}
						tabIndex={active ? 0 : -1}
						// The full, untruncated search path as a native hover tooltip.
						title={searchHit ? searchParentPath : undefined}
						// Fixed width (not full-bleed 1fr) + justify-self-center: the tile stays pinned to
						// TILE_WIDTH regardless of how much extra space its grid column gets, so the face
						// below stays the deterministic square useDriveVirtualizer's row-height estimate
						// assumes — see gridLayout.ts's own comment on the shared constants.
						className={cn(
							"group/tile relative flex w-44 shrink-0 flex-col gap-2 justify-self-center rounded-2xl p-2 text-center text-sm focus-ring-row outline-none select-none not-aria-selected:hover:bg-accent/50 aria-selected:bg-accent aria-selected:text-accent-foreground",
							dropHighlightClass(drop),
							cut && "*:not-data-[slot=dropdown-menu-trigger]:opacity-50"
						)}
						data-cut={cut ? "" : undefined}
						{...dragSource}
						onClick={event => {
							onPointerSelect(index, event)
						}}
						onDoubleClick={open}
						onContextMenu={onContextMenu}
						{...drop.handlers}
					>
						{/* The tile's face: a square that fills the tile's width, thumbnail or icon alike —
						the icon case keeps a tinted backdrop so it reads as the same card shape rather than
						a bare glyph floating on the canvas. An opaque thumbnail paints over the tile's own
						aria-selected background, so selection needs its own ring here too — see
						colorDialog.tsx's identical ring-on-a-filled-swatch idiom. */}
						<div className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl bg-muted/40 group-aria-selected/tile:ring-2 group-aria-selected/tile:ring-ring">
							<ItemThumbnail
								item={item}
								imgClassName="size-full object-cover"
								iconClassName="size-14"
							/>
							{selected ? (
								// Explicit selection badge (mobile parity: a filled checkmark over a
								// dimmed thumbnail) IN ADDITION to the aria-selected ring above, not instead of it —
								// same top-left corner the favorite star below uses, since a selected tile's own
								// dim overlay already covers that star visually; showing both at once would be
								// redundant clutter, not added information.
								<>
									<div className="absolute inset-0 rounded-xl bg-background/30" />
									<div className="absolute top-1 left-1 flex size-6 items-center justify-center rounded-full bg-primary shadow-sm">
										<CheckIcon
											aria-hidden="true"
											className="size-3.5 text-primary-foreground"
										/>
										<span className="sr-only">{t("driveItemSelected")}</span>
									</div>
								</>
							) : item.data.favorited ? (
								// Opposite corner from the menu trigger (top-right) so the two never overlap;
								// the ring in the aria-selected case sits at the face's own edge, outside this
								// inset badge. Tonal backdrop keeps it legible over busy thumbnails.
								<div className="absolute top-1 left-1 flex size-6 items-center justify-center rounded-full bg-background/80 shadow-sm">
									<StarIcon
										aria-hidden="true"
										className="size-3.5 fill-amber-500 text-amber-500"
									/>
									<span className="sr-only">{t("driveFavorited")}</span>
								</div>
							) : null}
							{showVideoBadge(item) ? (
								// Bottom-right, opposite the top corners both other badges (and the menu trigger)
								// occupy — mobile's own play-triangle badge marks a video tile the same way; a
								// duration label isn't available, so this deliberately scopes to the glyph only.
								<div className="absolute right-1 bottom-1 flex size-6 items-center justify-center rounded-full bg-background/80 shadow-sm">
									<PlayIcon
										aria-hidden="true"
										className="size-3 fill-foreground text-foreground"
									/>
									<span className="sr-only">{t("driveVideoItem")}</span>
								</div>
							) : null}
							<DropdownMenu>
								<RowMenuTrigger
									label={t("driveItemMenuTrigger")}
									reveal="tile"
									// Roving-tabindex-friendly — see DriveRow's identical comment.
									tabIndex={active ? 0 : -1}
								/>
								{/* The ⋯ dropdown stays single-item — see DriveRow's identical note. */}
								<DriveDropdownMenuContent
									item={item}
									variant={variant}
									onItemAction={onItemAction}
									searchHit={searchHit}
									onOpen={open}
									destination={destination}
								/>
							</DropdownMenu>
						</div>
						<span className="line-clamp-2 w-full text-xs break-words">{name}</span>
						{/* A cross-directory search hit gets the same visible sub-line list view already
						renders (driveRow.tsx), not just a hover tooltip (the title attr below stays too, for
						the full untruncated path on hover) — a tile has less room than a row, so this and the
						shared-identity badge below are mutually exclusive rather than stacked (search only ever
						runs in the "drive" variant, where `shared` is never set, so this never actually collides
						in practice). */}
						{searchHit ? (
							<span className="w-full truncate text-[0.7rem] text-muted-foreground">{searchParentPath}</span>
						) : shared ? (
							<span className="w-full truncate text-[0.7rem] text-muted-foreground">
								{t(shared.labelKey, { name: shared.name })}
							</span>
						) : null}
					</div>
				}
			/>
			<DriveCellContextMenuContent
				bulkMenu={bulkMenu}
				item={item}
				variant={variant}
				selectedItems={selectedItems}
				onBulkAction={onBulkAction}
				onItemAction={onItemAction}
				searchHit={searchHit}
				onOpen={open}
				destination={destination}
			/>
		</ContextMenu>
	)
}
