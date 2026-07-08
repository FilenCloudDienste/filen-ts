import { createElement, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { MoreHorizontalIcon } from "lucide-react"
import { type DriveItem } from "@/lib/drive/item"
import { type DriveVariant } from "@/lib/drive/preferences"
import { fileIconFor } from "@/lib/drive/icon"
import { sharedIdentityLabel } from "@/lib/drive/format"
import { type ItemActionDialogKind } from "@/components/drive/item-menu.logic"
import { DriveContextMenuContent, DriveDropdownMenuContent } from "@/components/drive/item-menu"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

export interface DriveTileProps {
	item: DriveItem
	index: number
	selected: boolean
	active: boolean
	variant: DriveVariant
	onPointerSelect: (index: number, event: MouseEvent<HTMLDivElement>) => void
	onOpen: (index: number) => void
	onItemAction: (kind: ItemActionDialogKind, item: DriveItem) => void
	registerRef: (index: number, el: HTMLDivElement | null) => void
}

// Grid tiles are plain CSS-grid children of an already-positioned virtual row (see
// directory-listing.tsx) — unlike DriveRow, no per-tile absolute-positioning style is needed.
export function DriveTile({ item, index, selected, active, variant, onPointerSelect, onOpen, onItemAction, registerRef }: DriveTileProps) {
	const { t } = useTranslation("drive")
	const name = item.data.decryptedMeta?.name ?? item.data.uuid
	// Only the two shared variants resolve a counterparty; every other variant gets null (no badge).
	const shared = sharedIdentityLabel(item, variant)

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
						className="group/tile relative flex flex-col items-center gap-2 rounded-2xl p-3 text-center text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-selected:bg-accent aria-selected:text-accent-foreground"
						onClick={event => {
							onPointerSelect(index, event)
						}}
						onDoubleClick={() => {
							onOpen(index)
						}}
					>
						{createElement(fileIconFor(item), { "aria-hidden": true, className: "size-10 shrink-0 text-muted-foreground" })}
						<span className="line-clamp-2 w-full text-xs break-words">{name}</span>
						{shared ? (
							<span className="w-full truncate text-[0.7rem] text-muted-foreground">
								{t(shared.labelKey, { name: shared.name })}
							</span>
						) : null}
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
											// Must not select the tile — see item-menu.tsx's own onClick for why a click
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
