import { createElement, type MouseEvent } from "react"
import { type DriveItem } from "@/lib/drive/item"
import { fileIconFor } from "@/lib/drive/icon"

export interface DriveTileProps {
	item: DriveItem
	index: number
	selected: boolean
	active: boolean
	onPointerSelect: (index: number, event: MouseEvent<HTMLDivElement>) => void
	onOpen: (index: number) => void
	registerRef: (index: number, el: HTMLDivElement | null) => void
}

// Grid tiles are plain CSS-grid children of an already-positioned virtual row (see
// directory-listing.tsx) — unlike DriveRow, no per-tile absolute-positioning style is needed.
export function DriveTile({ item, index, selected, active, onPointerSelect, onOpen, registerRef }: DriveTileProps) {
	const name = item.data.decryptedMeta?.name ?? item.data.uuid

	return (
		<div
			ref={el => {
				registerRef(index, el)
			}}
			role="option"
			aria-selected={selected}
			tabIndex={active ? 0 : -1}
			className="flex flex-col items-center gap-2 rounded-2xl p-3 text-center text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-selected:bg-accent aria-selected:text-accent-foreground"
			onClick={event => {
				onPointerSelect(index, event)
			}}
			onDoubleClick={() => {
				onOpen(index)
			}}
		>
			{createElement(fileIconFor(item), { "aria-hidden": true, className: "size-10 shrink-0 text-muted-foreground" })}
			<span className="line-clamp-2 w-full text-xs break-words">{name}</span>
		</div>
	)
}
