import { useState, type CSSProperties, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { StarIcon, MoreHorizontalIcon } from "lucide-react"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { ItemIcon } from "@/features/drive/components/itemIcon"
import { formatItemSize, formatModifiedDate, sharedIdentityLabel } from "@/features/drive/lib/format"
import { invalidateThumbnail } from "@/features/drive/lib/thumbnails"
import { splatToUuids } from "@/features/drive/lib/navigate"
import { canDragVariant } from "@/features/drive/lib/dnd.logic"
import { buildDragSourceProps } from "@/features/drive/lib/dnd"
import { type ItemActionDialogKind } from "@/features/drive/components/itemMenu.logic"
import { DriveContextMenuContent, DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { useThumbnail } from "@/features/drive/hooks/useThumbnail"
import { useDriveDropTarget } from "@/features/drive/hooks/useDriveDropTarget"
import { cn } from "@/lib/utils"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

export interface DriveRowProps {
	item: DriveItem
	index: number
	selected: boolean
	active: boolean
	variant: DriveVariant
	// Absolute-positioning style computed by the virtualizer (position/top/left/width/transform) —
	// the row owns none of that itself, only its own visual/layout concerns.
	style: CSSProperties
	// The current listing's "/drive/$" splat — the row's own ancestry (for the drag-move self/descendant
	// guard) is this chain plus the row's uuid. A primitive so a memoized row keeps its identity.
	splat: string
	// Search results only: the item's ancestor-name chain from the search root (empty for a direct
	// child of it) — undefined outside an active search, where a row has nothing to show here.
	searchParentPath?: string
	// uuid -> resolved directory bytes, threaded down from the listing's ONE useDriveDirectorySizes call
	// (never mounted per-row — see directoryListing.tsx) — passed straight through to formatItemSize.
	directorySizes: ReadonlyMap<string, number>
	onPointerSelect: (index: number, event: MouseEvent<HTMLDivElement>) => void
	onOpen: (index: number) => void
	onItemAction: (kind: ItemActionDialogKind, item: DriveItem) => void
	registerRef: (index: number, el: HTMLDivElement | null) => void
}

export function DriveRow({
	item,
	index,
	selected,
	active,
	variant,
	style,
	splat,
	searchParentPath,
	directorySizes,
	onPointerSelect,
	onOpen,
	onItemAction,
	registerRef
}: DriveRowProps) {
	const { t } = useTranslation("drive")
	const name = item.data.decryptedMeta?.name ?? item.data.uuid
	// Drag-to-move: a move-capable row is a drag source; a directory row is also a drop target for a
	// move (self/descendant/same-parent guarded via its own ancestry). The accessible move route stays
	// the item menu's "Move" action — this is a pointer-only enhancement.
	const dragSource = buildDragSourceProps(item, variant)
	const drop = useDriveDropTarget({
		targetUuid: item.data.uuid,
		targetAncestry: [...splatToUuids(splat), item.data.uuid],
		disabled: item.type !== "directory" || !canDragVariant(variant)
	})
	// Only the two shared variants' ROOT listing resolve a counterparty; every other variant/nested
	// item gets null (no badge) — see sharedIdentityLabel's own doc comment.
	const shared = sharedIdentityLabel(item, variant)
	const thumbUrl = useThumbnail(item)
	// Downgrades a torn/corrupt cache entry back to the icon without waiting for a remount — see the
	// img's own onError below. Never reset back to false: this mount already gave up on this uuid.
	const [thumbFailed, setThumbFailed] = useState(false)

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
						tabIndex={active ? 0 : -1}
						style={style}
						className={cn(
							"group/row flex h-10 items-center gap-3 rounded-xl px-3 text-sm outline-none select-none not-aria-selected:hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 aria-selected:bg-accent aria-selected:text-accent-foreground",
							drop.isOver && "bg-primary/10 ring-2 ring-primary/60 ring-inset"
						)}
						{...dragSource}
						onClick={event => {
							onPointerSelect(index, event)
						}}
						onDoubleClick={() => {
							onOpen(index)
						}}
						onDragEnter={drop.onDragEnter}
						onDragOver={drop.onDragOver}
						onDragLeave={drop.onDragLeave}
						onDrop={drop.onDrop}
					>
						{thumbUrl !== null && !thumbFailed ? (
							<img
								src={thumbUrl}
								alt=""
								draggable={false}
								decoding="async"
								className="size-4 shrink-0 rounded-sm object-cover"
								onError={() => {
									invalidateThumbnail(item.data.uuid)
									setThumbFailed(true)
								}}
							/>
						) : (
							<ItemIcon
								item={item}
								className="size-4 shrink-0"
							/>
						)}
						<span className="min-w-0 flex-1 truncate">{name}</span>
						{searchParentPath !== undefined && searchParentPath.length > 0 ? (
							<span className="max-w-48 min-w-0 shrink truncate text-xs text-muted-foreground">{searchParentPath}</span>
						) : null}
						{shared ? (
							<span className="max-w-48 min-w-0 shrink truncate text-xs text-muted-foreground">
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
						<span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
							{formatItemSize(item, directorySizes)}
						</span>
						<span className="w-28 shrink-0 text-right text-xs text-muted-foreground">{formatModifiedDate(item)}</span>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label={t("driveItemMenuTrigger")}
										// Roving-tabindex-friendly: only the active row's trigger joins the normal Tab
										// sequence, matching the row's own tabIndex — otherwise every visible row would
										// add its own Tab stop, defeating the listbox's one-stop roving pattern.
										tabIndex={active ? 0 : -1}
										className="shrink-0 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
										onClick={event => {
											// Must not select the row — see itemMenu.tsx's own onClick for why a click
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
