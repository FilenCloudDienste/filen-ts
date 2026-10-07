import { useState } from "react"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { invalidateThumbnail } from "@/features/drive/lib/thumbnails"
import { useThumbnail } from "@/features/drive/hooks/useThumbnail"
import { ItemIcon } from "@/features/drive/components/itemIcon"
import { cn, dirColorHex } from "@filen/shared"

// The item's thumbnail when the service has one, else its icon. A leaf of its own so a late thumbnail
// resolve re-renders only this, never the row/tile around it. useThumbnail already yields null for a
// directory, so callers need no gating.
//
// While the service is still answering, the icon waits a beat before fading in: a thumbnail read back
// from disk lands within a frame or two and then replaces an empty tile instead of flashing the icon,
// while one that has to be generated still shows the icon in the meantime. A thumbnail that arrives
// late fades in; one already cached paints on the first frame with no animation. Both are CSS only, so
// neither costs a render.
export function ItemThumbnail({
	item,
	index,
	imgClassName,
	iconClassName
}: {
	item: DriveItem
	// The cell's place in a virtualized listing (see useThumbnail).
	index?: number
	imgClassName: string
	iconClassName: string
}) {
	const thumbUrl = useThumbnail(item, index)
	// Whether this mount had to wait for its thumbnail.
	const [waited] = useState(thumbUrl === undefined)
	// Downgrades a torn/corrupt cache entry back to the icon without waiting for a remount. Never reset
	// back to false: this mount already gave up on this uuid.
	const [thumbFailed, setThumbFailed] = useState(false)

	if (typeof thumbUrl !== "string" || thumbFailed) {
		return (
			<ItemIcon
				item={item}
				className={cn(iconClassName, thumbUrl === undefined && !thumbFailed && "animate-in delay-150 fill-mode-backwards fade-in")}
			/>
		)
	}

	return (
		<img
			src={thumbUrl}
			alt=""
			draggable={false}
			decoding="async"
			className={cn(imgClassName, waited && "animate-in fade-in")}
			onError={() => {
				invalidateThumbnail(item.data.uuid)
				setThumbFailed(true)
			}}
		/>
	)
}

// The info and link dialogs' hero tile: the thumbnail or icon on a soft tonal tile. Only an owned
// directory tints by its own color; a shared directory's arm carries the owner's color but reads as the
// neutral default, mirroring filen-mobile's hero.
export function ItemHeroTile({ item, className, iconClassName }: { item: DriveItem; className: string; iconClassName: string }) {
	const isDirectory = asDirectoryOrFile(item).type === "directory"
	const dirHex = dirColorHex(item.type === "directory" ? item.data.color : "default")

	return (
		<div
			className={cn(
				"relative flex shrink-0 items-center justify-center overflow-hidden ring-1 ring-foreground/5",
				!isDirectory && "bg-muted",
				className
			)}
			style={isDirectory ? { backgroundColor: `color-mix(in srgb, ${dirHex} 16%, transparent)` } : undefined}
		>
			{/* Keyed: the dialog's item can rotate its uuid while open, and the per-mount state must not carry over. */}
			<ItemThumbnail
				key={item.data.uuid}
				item={item}
				imgClassName="size-full object-cover"
				iconClassName={iconClassName}
			/>
		</div>
	)
}
