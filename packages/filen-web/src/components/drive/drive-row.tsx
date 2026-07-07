import { createElement, type CSSProperties, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { StarIcon, MoreHorizontalIcon } from "lucide-react"
import { type DriveItem } from "@/lib/drive/item"
import { type DriveVariant } from "@/lib/drive/preferences"
import { fileIconFor } from "@/lib/drive/icon"
import { formatItemSize, formatModifiedDate } from "@/lib/drive/format"
import { type ItemActionDialogKind } from "@/components/drive/item-menu.logic"
import { DriveContextMenuContent, DriveDropdownMenuContent } from "@/components/drive/item-menu"
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
	onPointerSelect,
	onOpen,
	onItemAction,
	registerRef
}: DriveRowProps) {
	const { t } = useTranslation("drive")
	const name = item.data.decryptedMeta?.name ?? item.data.uuid

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
						className="group/row flex h-10 items-center gap-3 rounded-xl px-3 text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-selected:bg-accent aria-selected:text-accent-foreground"
						onClick={event => {
							onPointerSelect(index, event)
						}}
						onDoubleClick={() => {
							onOpen(index)
						}}
					>
						{createElement(fileIconFor(item), { "aria-hidden": true, className: "size-4 shrink-0 text-muted-foreground" })}
						<span className="min-w-0 flex-1 truncate">{name}</span>
						{item.data.favorited ? (
							<>
								<StarIcon
									aria-hidden="true"
									className="size-3.5 shrink-0 fill-amber-500 text-amber-500"
								/>
								<span className="sr-only">{t("driveFavorited")}</span>
							</>
						) : null}
						<span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{formatItemSize(item)}</span>
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
											// Must not select the row — see item-menu.tsx's own onClick for why a click
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
