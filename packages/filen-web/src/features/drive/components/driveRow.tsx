import { useTranslation } from "react-i18next"
import { StarIcon } from "lucide-react"
import { ItemThumbnail } from "@/features/drive/components/itemThumbnail"
import { formatItemSize, formatModifiedDate } from "@/features/drive/lib/format"
import { DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { DriveCellContextMenuContent } from "@/features/drive/components/bulkMenu"
import { useDriveItemCell, type DriveItemCellProps } from "@/features/drive/hooks/useDriveItemCell"
import { dropHighlightClass } from "@/features/drive/hooks/useDriveDropTarget"
import { cn } from "@filen/shared"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu } from "@/components/ui/dropdown-menu"
import { RowMenuTrigger } from "@/components/rowMenuTrigger"

export interface DriveRowProps extends DriveItemCellProps {
	// The virtualizer's offset for this row. A number, not a style object, so the compiled row keeps its
	// memoized menu subtree across listing re-renders that leave the offset alone.
	start: number
	// This directory's resolved bytes from the listing's ONE useDriveDirectorySizes call (never mounted
	// per-row — see directoryListing.tsx), undefined while pending — passed straight through to formatItemSize.
	directorySize: number | undefined
}

export function DriveRow({
	item,
	index,
	total,
	selected,
	active,
	variant,
	start,
	splat,
	searchParentPath,
	directorySize,
	selectedItems,
	onPointerSelect,
	onCursorMove,
	onOpen,
	onItemAction,
	destinationActions,
	onBulkAction,
	registerRef
}: DriveRowProps) {
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
			{/* render-prop merge onto the SAME role="option" div (see ui/badge.tsx's idiom) rather than a
			new wrapper — ContextMenuTrigger's own onContextMenu/touch handlers merge in alongside the
			row's existing onClick/onDoubleClick/ref (Base UI's mergeProps chains same-name handlers
			instead of overwriting, and merges the ref array), so select/open/roving-tabindex are
			unaffected. */}
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
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							width: "100%",
							transform: `translateY(${String(start)}px)`
						}}
						className={cn(
							"group/row flex h-10 items-center gap-3 px-3 text-sm focus-ring-row outline-none select-none not-aria-selected:hover:bg-accent/50 aria-selected:bg-accent aria-selected:text-accent-foreground",
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
						<ItemThumbnail
							item={item}
							imgClassName="size-6 shrink-0 rounded-md object-cover"
							iconClassName="size-6 shrink-0"
						/>
						<span className="min-w-0 flex-1 truncate">{name}</span>
						{/* These two ride with the Modified column (see directoryListing.tsx's header): their flex
						    base size is their own content width while the name's is 0, so every pixel the card is
						    short comes out of the name first. Non-monotonic on purpose — the card is widest just
						    below md and narrowest just above it, because that is where the shell puts the sidebar
						    back into the row. What they carry stays reachable in the item info dialog. */}
						{searchHit ? (
							<span className="hidden max-w-48 min-w-0 shrink truncate text-xs text-muted-foreground sm:block md:hidden lg:block">
								{searchParentPath}
							</span>
						) : null}
						{shared ? (
							<span className="hidden max-w-48 min-w-0 shrink truncate text-xs text-muted-foreground sm:block md:hidden lg:block">
								{t(shared.labelKey, { name: shared.name })}
							</span>
						) : null}
						{item.data.favorited ? (
							<>
								<StarIcon
									aria-hidden="true"
									className="size-3.5 shrink-0 fill-amber-500 text-amber-500"
								/>
								<span className="sr-only">{t("driveFavorited")}</span>
							</>
						) : null}
						<span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
							{formatItemSize(item, directorySize)}
						</span>
						<span className="hidden w-28 shrink-0 text-right text-xs text-muted-foreground lg:block">
							{formatModifiedDate(item)}
						</span>
						<DropdownMenu>
							<RowMenuTrigger
								label={t("driveItemMenuTrigger")}
								reveal="row"
								// Roving-tabindex-friendly: only the active row's trigger joins the normal Tab
								// sequence, matching the row's own tabIndex — otherwise every visible row would
								// add its own Tab stop, defeating the listbox's one-stop roving pattern.
								tabIndex={active ? 0 : -1}
							/>
							{/* The ⋯ dropdown stays single-item — it is a per-row affordance, and the bulk
							    surface already has its own bar plus the context menu below. */}
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
