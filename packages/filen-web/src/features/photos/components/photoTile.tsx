import { useState, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, MoreHorizontalIcon, PlayIcon, StarIcon } from "lucide-react"
import { type ItemActionDialogKind } from "@/features/drive/components/itemMenu.logic"
import { showVideoBadge } from "@/features/drive/components/driveTile.logic"
import { useThumbnail } from "@/features/drive/hooks/useThumbnail"
import { invalidateThumbnail } from "@/features/drive/lib/thumbnails"
import { ItemIcon } from "@/features/drive/components/itemIcon"
import { PhotosContextMenuContent, PhotosDropdownMenuContent } from "@/features/photos/components/itemMenu"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { cn } from "@/lib/utils"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

export interface PhotoTileProps {
	rootUuid: string
	item: PhotoItem
	index: number
	selected: boolean
	size: number
	// Fires for every plain/modifier click on the tile's face — photoGrid.tsx's own handleTileClick
	// decides open-vs-select (photoGrid.logic.ts's resolveTileClickIntent) before this ever runs, so by
	// the time it's called the caller has already committed to one outcome; the tile itself stays a
	// dumb dispatcher with no click-intent logic of its own.
	onTileClick: (index: number, event: MouseEvent<HTMLDivElement>) => void
	onItemAction: (kind: ItemActionDialogKind, item: PhotoItem) => void
}

// Square media tile — mirrors driveTile.tsx's own face/badge composition (thumbnail-or-icon, a
// tinted backdrop, opaque-thumbnail-safe selection ring) but with the favorite badge moved to the
// BOTTOM-left corner (mobile parity — features/photos/components/photoItem.tsx puts favorite
// bottom-left, offline top-right (no web equivalent), video bottom-right) instead of driveTile's own
// top-left placement, and no offline badge at all (web has no make-offline concept — see the study's
// own honest enumeration).
export function PhotoTile({ rootUuid, item, index, selected, size, onTileClick, onItemAction }: PhotoTileProps) {
	const { t } = useTranslation(["drive", "photos"])
	const name = item.data.decryptedMeta?.name ?? item.data.uuid
	const thumbUrl = useThumbnail(item)
	const [thumbFailed, setThumbFailed] = useState(false)

	return (
		<ContextMenu>
			<ContextMenuTrigger
				render={
					<div
						role="option"
						aria-selected={selected}
						title={name}
						style={{ width: size }}
						className="group/tile relative flex shrink-0 flex-col gap-1 outline-none select-none"
						onClick={event => {
							onTileClick(index, event)
						}}
					>
						<div
							className={cn(
								"relative aspect-square w-full overflow-hidden rounded-xl bg-muted/40",
								selected && "ring-2 ring-ring"
							)}
						>
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
							{selected ? <div className="absolute inset-0 rounded-xl bg-background/30" /> : null}
							{item.data.favorited ? (
								<div className="absolute bottom-1 left-1 flex size-6 items-center justify-center rounded-full bg-background/80 shadow-sm">
									<StarIcon
										aria-hidden="true"
										className="size-3.5 fill-amber-500 text-amber-500"
									/>
									<span className="sr-only">{t("driveFavorited")}</span>
								</div>
							) : null}
							{showVideoBadge(item) ? (
								<div className="absolute right-1 bottom-1 flex size-6 items-center justify-center rounded-full bg-background/80 shadow-sm">
									<PlayIcon
										aria-hidden="true"
										className="size-3 fill-foreground text-foreground"
									/>
									<span className="sr-only">{t("driveVideoItem")}</span>
								</div>
							) : null}
							{selected ? (
								<div className="absolute top-1 left-1 flex size-6 items-center justify-center rounded-full bg-primary shadow-sm">
									<CheckIcon
										aria-hidden="true"
										className="size-3.5 text-primary-foreground"
									/>
									<span className="sr-only">{t("driveItemSelected")}</span>
								</div>
							) : null}
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											variant="ghost"
											size="icon-xs"
											aria-label={t("driveItemMenuTrigger")}
											className="absolute top-1 right-1 shrink-0 opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
											onClick={event => {
												event.stopPropagation()
											}}
										>
											<MoreHorizontalIcon />
										</Button>
									}
								/>
								<PhotosDropdownMenuContent
									rootUuid={rootUuid}
									item={item}
									onItemAction={onItemAction}
								/>
							</DropdownMenu>
						</div>
					</div>
				}
			/>
			<PhotosContextMenuContent
				rootUuid={rootUuid}
				item={item}
				onItemAction={onItemAction}
			/>
		</ContextMenu>
	)
}
