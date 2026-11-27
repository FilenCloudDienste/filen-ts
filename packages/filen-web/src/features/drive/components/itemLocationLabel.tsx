import { use, useState } from "react"
import type { DriveItem } from "@/features/drive/lib/item"
import { ItemLocationContext } from "@/features/drive/lib/itemLocation"

export interface ItemLocationLabelProps {
	item: DriveItem
	// The listing's cursor cell: keyboard focus reads its full path too.
	active: boolean
	className: string
}

// The muted parent name of a Recents, Favorites or Trash cell (where Restore puts a trashed one), with the
// full path as its tooltip once hovered or focused. Renders nothing outside those listings or while the
// parent is not cached.
export function ItemLocationLabel({ item, active, className }: ItemLocationLabelProps) {
	const locations = use(ItemLocationContext)
	const [hovered, setHovered] = useState(false)
	const name = locations?.name(item)

	if (locations === null || name === undefined) {
		return null
	}

	return (
		<span
			className={className}
			title={hovered || active ? (locations.path(item) ?? name) : undefined}
			onPointerEnter={() => {
				setHovered(true)
			}}
		>
			{name}
		</span>
	)
}
