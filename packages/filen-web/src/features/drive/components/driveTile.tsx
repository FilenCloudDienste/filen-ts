import { useState, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { MoreHorizontalIcon } from "lucide-react"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { ItemIcon } from "@/features/drive/components/itemIcon"
import { sharedIdentityLabel } from "@/features/drive/lib/format"
import { invalidateThumbnail } from "@/features/drive/lib/thumbnails"
import { type ItemActionDialogKind } from "@/features/drive/components/itemMenu.logic"
import { DriveContextMenuContent, DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { useThumbnail } from "@/features/drive/hooks/useThumbnail"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

export interface DriveTileProps {
	item: DriveItem
	index: number
	selected: boolean
	active: boolean
	variant: DriveVariant
	// Search results only: the item's ancestor-name chain from the search root — undefined outside an
	// active search. Shown as a native hover tooltip (title attr), not inline text — a tile has far
	// less room than a row for a second line.
	searchParentPath?: string
	onPointerSelect: (index: number, event: MouseEvent<HTMLDivElement>) => void
	onOpen: (index: number) => void
	onItemAction: (kind: ItemActionDialogKind, item: DriveItem) => void
	registerRef: (index: number, el: HTMLDivElement | null) => void
}

// Grid tiles are plain CSS-grid children of an already-positioned virtual row (see
// directoryListing.tsx) — unlike DriveRow, no per-tile absolute-positioning style is needed.
export function DriveTile({
	item,
	index,
	selected,
	active,
	variant,
	searchParentPath,
	onPointerSelect,
	onOpen,
	onItemAction,
	registerRef
}: DriveTileProps) {
	const { t } = useTranslation("drive")
	const name = item.data.decryptedMeta?.name ?? item.data.uuid
	// Only the two shared variants resolve a counterparty; every other variant gets null (no badge).
	const shared = sharedIdentityLabel(item, variant)
	const thumbUrl = useThumbnail(item)
	// Downgrades a torn/corrupt cache entry back to the icon without waiting for a remount — see the
	// img's own onError below. Never reset back to false: this mount already gave up on this uuid.
	const [thumbFailed, setThumbFailed] = useState(false)

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
						tabIndex={active ? 0 : -1}
						title={searchParentPath !== undefined && searchParentPath.length > 0 ? searchParentPath : undefined}
						// Fixed width (not full-bleed 1fr) + justify-self-center: the tile stays pinned to
						// TILE_WIDTH regardless of how much extra space its grid column gets, so the face
						// below stays the deterministic square useDriveVirtualizer's row-height estimate
						// assumes — see gridLayout.ts's own comment on the shared constants.
						className="group/tile relative flex w-44 shrink-0 flex-col gap-2 justify-self-center rounded-2xl p-2 text-center text-sm outline-none select-none not-aria-selected:hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 aria-selected:bg-accent aria-selected:text-accent-foreground"
						onClick={event => {
							onPointerSelect(index, event)
						}}
						onDoubleClick={() => {
							onOpen(index)
						}}
					>
						{/* The tile's face: a square that fills the tile's width, thumbnail or icon alike —
						the icon case keeps a tinted backdrop so it reads as the same card shape rather than
						a bare glyph floating on the canvas. An opaque thumbnail paints over the tile's own
						aria-selected background, so selection needs its own ring here too — see
						colorDialog.tsx's identical ring-on-a-filled-swatch idiom. */}
						<div className="relative aspect-square w-full overflow-hidden rounded-xl bg-muted/40 group-aria-selected/tile:ring-2 group-aria-selected/tile:ring-ring">
							{thumbUrl !== null && !thumbFailed ? (
								<img
									src={thumbUrl}
									alt=""
									draggable={false}
									decoding="async"
									className="size-full object-cover"
									onError={() => {
										invalidateThumbnail(item.data.uuid)
										setThumbFailed(true)
									}}
								/>
							) : (
								<div className="flex size-full items-center justify-center">
									<ItemIcon
										item={item}
										className="size-14"
									/>
								</div>
							)}
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											variant="ghost"
											size="icon-xs"
											aria-label={t("driveItemMenuTrigger")}
											// Roving-tabindex-friendly — see DriveRow's identical comment.
											tabIndex={active ? 0 : -1}
											className="absolute top-1 right-1 shrink-0 opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
											onClick={event => {
												// Must not select the tile — see itemMenu.tsx's own onClick for why a click
												// inside the (portaled) menu content needs the same guard.
												event.stopPropagation()
											}}
											onDoubleClick={event => {
												event.stopPropagation()
											}}
										>
											<MoreHorizontalIcon />
										</Button>
									}
								/>
								<DriveDropdownMenuContent
									item={item}
									variant={variant}
									onItemAction={onItemAction}
								/>
							</DropdownMenu>
						</div>
						<span className="line-clamp-2 w-full text-xs break-words">{name}</span>
						{shared ? (
							<span className="w-full truncate text-[0.7rem] text-muted-foreground">
								{t(shared.labelKey, { name: shared.name })}
							</span>
						) : null}
					</div>
				}
			/>
			<DriveContextMenuContent
				item={item}
				variant={variant}
				onItemAction={onItemAction}
			/>
		</ContextMenu>
	)
}
