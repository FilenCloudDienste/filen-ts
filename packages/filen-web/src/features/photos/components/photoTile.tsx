import { type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, PlayIcon, StarIcon } from "lucide-react"
import { type ItemActionDialogKind } from "@/features/drive/components/itemMenu.logic"
import { showVideoBadge } from "@/features/drive/components/driveTile.logic"
import { ItemThumbnail } from "@/features/drive/components/itemThumbnail"
import { DriveContextMenuContent, DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { patchPhoto } from "@/features/photos/lib/actions"
import { PHOTOS_HIDDEN_ACTION_IDS } from "@/features/photos/lib/itemActions"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { driveItemName } from "@filen/shared"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu } from "@/components/ui/dropdown-menu"
import { RowMenuTrigger } from "@/components/rowMenuTrigger"
import { useTouchLongPress } from "@/lib/useTouchLongPress"

export interface PhotoTileProps {
	rootUuid: string
	item: PhotoItem
	index: number
	// The grid's full item count — see DriveTile's identical prop (virtualized set size).
	total: number
	selected: boolean
	// The roving-tabindex cursor: exactly one tile carries the grid's single tab stop (drive parity,
	// driveTile.tsx) — its face AND its ⋯ trigger, so tabbing into an unbounded virtualized grid costs
	// one stop, not one per tile.
	active: boolean
	registerRef: (index: number, el: HTMLDivElement | null) => void
	// Fires for every plain/modifier click on the tile's face — photoGrid.tsx's own handleTileClick
	// decides open-vs-select (photoGrid.logic.ts's resolveTileClickIntent) before this ever runs, so by
	// the time it's called the caller has already committed to one outcome; the tile itself stays a
	// dumb dispatcher with no click-intent logic of its own.
	onTileClick: (index: number, event: MouseEvent<HTMLDivElement>, pointerType: string) => void
	// A touch long-press: toggles the tile like a Ctrl/Cmd+click, where a mouse would right-click.
	onTileToggle: (index: number) => void
	onItemAction: (kind: ItemActionDialogKind, item: PhotoItem) => void
}

// Square media tile — mirrors driveTile.tsx's own face/badge composition (thumbnail-or-icon, a
// tinted backdrop, opaque-thumbnail-safe selection ring) but with the favorite badge moved to the
// BOTTOM-left corner (mobile parity — features/photos/components/photoItem.tsx puts favorite
// bottom-left, offline top-right (no web equivalent), video bottom-right) instead of driveTile's own
// top-left placement, and no offline badge at all (web has no make-offline concept — see the study's
// own honest enumeration).
export function PhotoTile({
	rootUuid,
	item,
	index,
	total,
	selected,
	active,
	registerRef,
	onTileClick,
	onTileToggle,
	onItemAction
}: PhotoTileProps) {
	const { t } = useTranslation(["drive", "photos"])
	const name = driveItemName(item)
	const press = useTouchLongPress<HTMLDivElement>({
		onLongPress: () => {
			onTileToggle(index)
		}
	})

	return (
		<ContextMenu>
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
						title={name}
						// Fills its grid cell: tiles sit flush, so the focused one is raised to keep its ring above
						// its neighbors.
						className="group/tile relative focus-ring-row outline-none select-none focus-visible:z-10"
						{...press.handlers}
						onClick={event => {
							onTileClick(index, event, press.pointerType(event))
						}}
					>
						<div className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-muted/40">
							<ItemThumbnail
								item={item}
								imgClassName="size-full object-cover"
								iconClassName="size-14"
							/>
							{/* Above the image, so the inset ring stays inside the tile instead of over its neighbors. */}
							{selected ? <div className="absolute inset-0 bg-background/30 ring-2 ring-ring ring-inset" /> : null}
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
								<RowMenuTrigger
									label={t("driveItemMenuTrigger")}
									reveal="tile"
									tabIndex={active ? 0 : -1}
								/>
								<DriveDropdownMenuContent
									item={item}
									variant="drive"
									hiddenActionIds={PHOTOS_HIDDEN_ACTION_IDS}
									onItemAction={kind => {
										onItemAction(kind, item)
									}}
									onFavoriteToggled={updated => {
										patchPhoto(rootUuid, updated)
									}}
								/>
							</DropdownMenu>
						</div>
					</div>
				}
			/>
			<DriveContextMenuContent
				item={item}
				variant="drive"
				hiddenActionIds={PHOTOS_HIDDEN_ACTION_IDS}
				onItemAction={kind => {
					onItemAction(kind, item)
				}}
				onFavoriteToggled={updated => {
					patchPhoto(rootUuid, updated)
				}}
			/>
		</ContextMenu>
	)
}
