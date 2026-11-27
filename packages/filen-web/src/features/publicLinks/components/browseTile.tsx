import { useTranslation } from "react-i18next"
import { PlayIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { ItemThumbnail } from "@/features/drive/components/itemThumbnail"
import { showVideoBadge } from "@/features/drive/components/driveTile.logic"
import { useFileKindVerdict } from "@/features/drive/hooks/useFileKindVerdict"
import { TILE_CLASS, TILE_FACE_CLASS, TILE_NAME_CLASS, TILE_SUBLINE_CLASS } from "@/features/drive/lib/listingCells"
import { CONTEXT_TREE_MENU_FAMILY, DROPDOWN_TREE_MENU_FAMILY } from "@/features/drive/components/directoryTreeSubmenu"
import { BrowseEntryMenuItems, SelectionBox, type BrowseCellProps } from "@/features/publicLinks/components/browseRow"
import { entryName, entryPath } from "@/features/publicLinks/lib/browse.logic"
import { useTouchLongPress } from "@/lib/useTouchLongPress"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu"
import { RowMenuTrigger } from "@/components/rowMenuTrigger"

// One entry of a public directory's grid: drive's tile (driveTile.tsx), a plain grid child of its positioned virtual row,
// with BrowseRow's selection and menus. Its selection box sits in the face's top-left corner, shown while the tile is
// selected, hovered or focused; the thumbnail is the listing's ThumbnailSourceContext's (the public-link client).
export function BrowseTile({
	entry,
	index,
	total,
	selected,
	active,
	onPointerSelect,
	onOpen,
	onToggle,
	onRetarget,
	menuFor,
	onAction,
	registerRef
}: BrowseCellProps) {
	const { t } = useTranslation("drive")
	const verdict = useFileKindVerdict(entry.kind === "file" ? entry.item.data.uuid : undefined)
	// A held touch selects, as in drive; the context menu stays mouse-only.
	const press = useTouchLongPress<HTMLDivElement>({
		onLongPress: () => {
			onToggle(index)
		},
		onContextMenu: () => {
			if (!selected) {
				onRetarget(index)
			}
		}
	})
	const path = entryPath(entry)

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
						className={cn(
							TILE_CLASS,
							"group/tile focus-ring-row outline-none select-none not-aria-selected:hover:bg-accent/50 aria-selected:bg-accent aria-selected:text-accent-foreground"
						)}
						{...press.handlers}
						onClick={event => {
							onPointerSelect(index, event, press.pointerType(event))
						}}
						// A touch tap already opened it.
						onDoubleClick={event => {
							if (press.pointerType(event) !== "touch") {
								onOpen(index)
							}
						}}
					>
						{/* An opaque thumbnail paints over the tile's selected background, so the face rings too. */}
						<div className={cn(TILE_FACE_CLASS, "group-aria-selected/tile:ring-2 group-aria-selected/tile:ring-ring")}>
							<ItemThumbnail
								item={entry.item}
								index={index}
								imgClassName="size-full object-cover"
								iconClassName="size-14"
							/>
							{showVideoBadge(entry.item, verdict) ? (
								<div className="absolute right-1 bottom-1 flex size-6 items-center justify-center rounded-full bg-background/80 shadow-sm">
									<PlayIcon
										aria-hidden="true"
										className="size-3 fill-foreground text-foreground"
									/>
									<span className="sr-only">{t("driveVideoItem")}</span>
								</div>
							) : null}
							<span
								aria-hidden="true"
								className={cn(
									"absolute top-1.5 left-1.5 flex rounded-[4px] bg-background/80 shadow-sm",
									!selected && "opacity-0 group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100"
								)}
								onClick={event => {
									event.stopPropagation()
									onToggle(index)
								}}
								// A quick second click toggles again; it never opens the tile.
								onDoubleClick={event => {
									event.stopPropagation()
								}}
							>
								<SelectionBox check={selected ? "on" : "off"} />
							</span>
							<DropdownMenu>
								<RowMenuTrigger
									label={t("driveItemMenuTrigger")}
									reveal="tile"
									tabIndex={active ? 0 : -1}
								/>
								<DropdownMenuContent align="end">
									<BrowseEntryMenuItems
										family={DROPDOWN_TREE_MENU_FAMILY}
										entry={entry}
										menuFor={menuFor}
										onAction={onAction}
									/>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
						<span className={TILE_NAME_CLASS}>{entryName(entry)}</span>
						{/* A search result's directory path, its second line. */}
						{path !== null ? (
							<span
								className={cn(TILE_SUBLINE_CLASS, "text-muted-foreground")}
								title={path}
							>
								{path}
							</span>
						) : null}
					</div>
				}
			/>
			<ContextMenuContent>
				<BrowseEntryMenuItems
					family={CONTEXT_TREE_MENU_FAMILY}
					entry={entry}
					menuFor={menuFor}
					onAction={onAction}
				/>
			</ContextMenuContent>
		</ContextMenu>
	)
}
