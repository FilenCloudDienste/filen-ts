import { createElement, type CSSProperties, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { StarIcon } from "lucide-react"
import { type DriveItem } from "@/lib/drive/item"
import { fileIconFor } from "@/lib/drive/icon"
import { formatItemSize, formatModifiedDate } from "@/lib/drive/format"

export interface DriveRowProps {
	item: DriveItem
	index: number
	selected: boolean
	active: boolean
	// Absolute-positioning style computed by the virtualizer (position/top/left/width/transform) —
	// the row owns none of that itself, only its own visual/layout concerns.
	style: CSSProperties
	onPointerSelect: (index: number, event: MouseEvent<HTMLDivElement>) => void
	onOpen: (index: number) => void
	registerRef: (index: number, el: HTMLDivElement | null) => void
}

export function DriveRow({ item, index, selected, active, style, onPointerSelect, onOpen, registerRef }: DriveRowProps) {
	const { t } = useTranslation("drive")
	const name = item.data.decryptedMeta?.name ?? item.data.uuid

	return (
		<div
			ref={el => {
				registerRef(index, el)
			}}
			role="option"
			aria-selected={selected}
			tabIndex={active ? 0 : -1}
			style={style}
			className="flex h-10 items-center gap-3 rounded-xl px-3 text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-selected:bg-accent aria-selected:text-accent-foreground"
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
		</div>
	)
}
