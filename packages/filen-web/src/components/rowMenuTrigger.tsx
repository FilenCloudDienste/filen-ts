import { MoreHorizontalIcon } from "lucide-react"
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { stopRowPropagation } from "@/lib/domEvents"

// A coarse pointer cannot hover, so the reveal never fires there — show the trigger unconditionally and
// grow it (glyph included, or icon-xs would pin a 12px mark inside a 32px box). 32px is the ceiling: a
// drive row is ROW_HEIGHT tall.
const BASE_CLASS =
	"shrink-0 opacity-0 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:size-8 pointer-coarse:opacity-100 pointer-coarse:[&_svg:not([class*='size-'])]:size-4"

// Keyed by the hover group of the surrounding row or tile; a tile also pins the trigger to its corner.
const REVEAL_CLASS = {
	row: `${BASE_CLASS} group-hover/row:opacity-100`,
	tile: `${BASE_CLASS} absolute top-1 right-1 group-hover/tile:opacity-100`,
	plain: `${BASE_CLASS} group-hover:opacity-100`
} as const

export interface RowMenuTriggerProps {
	label: string
	reveal: keyof typeof REVEAL_CLASS
	tabIndex?: number
}

// Hover-revealed ⋯ trigger for a list row or grid tile; render inside the row's <DropdownMenu>.
export function RowMenuTrigger({ label, reveal, tabIndex }: RowMenuTriggerProps) {
	return (
		<DropdownMenuTrigger
			render={
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={label}
					tabIndex={tabIndex}
					className={REVEAL_CLASS[reveal]}
					onClick={stopRowPropagation}
					onDoubleClick={stopRowPropagation}
				>
					<MoreHorizontalIcon />
				</Button>
			}
		/>
	)
}
