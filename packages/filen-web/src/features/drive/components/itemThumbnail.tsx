import { useState } from "react"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { dirColorHex } from "@/features/drive/lib/dirColor"
import { invalidateThumbnail } from "@/features/drive/lib/thumbnails"
import { useThumbnail } from "@/features/drive/hooks/useThumbnail"
import { ItemIcon } from "@/features/drive/components/itemIcon"
import { cn } from "@filen/shared"

// The item's thumbnail when the service has one, else its icon. A leaf of its own so a late thumbnail
// resolve re-renders only this, never the row/tile around it. useThumbnail already yields null for a
// directory, so callers need no gating.
export function ItemThumbnail({ item, imgClassName, iconClassName }: { item: DriveItem; imgClassName: string; iconClassName: string }) {
	const thumbUrl = useThumbnail(item)
	// Downgrades a torn/corrupt cache entry back to the icon without waiting for a remount. Never reset
	// back to false: this mount already gave up on this uuid.
	const [thumbFailed, setThumbFailed] = useState(false)

	if (thumbUrl === null || thumbFailed) {
		return (
			<ItemIcon
				item={item}
				className={iconClassName}
			/>
		)
	}

	return (
		<img
			src={thumbUrl}
			alt=""
			draggable={false}
			decoding="async"
			className={imgClassName}
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
			<ItemThumbnail
				item={item}
				imgClassName="size-full object-cover"
				iconClassName={iconClassName}
			/>
		</div>
	)
}
