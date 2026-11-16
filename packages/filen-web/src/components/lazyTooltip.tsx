import { useState, type ReactElement } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { stopRowPropagation } from "@/lib/domEvents"

// A styled tooltip that costs nothing until the pointer reaches its element: the tooltip is created on
// pointer enter and dropped on leave, for marks repeated in every row of a long list. The stable wrapper owns
// the hover, since the element under the pointer is swapped for the tooltip's trigger. The element should
// carry its own accessible text; the tooltip is a visual aid only.
//
// The popup is portaled out of the element's DOM, not out of its React tree: a click, right-click, press or
// touch on it would still reach a row's link, selection, long-press and context-menu handlers, so it stops
// them at its root.
export function LazyTooltip({ label, className, children }: { label: string; className?: string; children: ReactElement }) {
	const [open, setOpen] = useState(false)

	return (
		<span
			className={className}
			onPointerEnter={() => {
				setOpen(true)
			}}
			onPointerLeave={() => {
				setOpen(false)
			}}
		>
			{open ? (
				<Tooltip open>
					<TooltipTrigger render={children} />
					<TooltipContent
						className="whitespace-pre-line"
						onClick={stopRowPropagation}
						onDoubleClick={stopRowPropagation}
						onContextMenu={stopRowPropagation}
						onPointerDown={stopRowPropagation}
						onTouchStart={stopRowPropagation}
					>
						{label}
					</TooltipContent>
				</Tooltip>
			) : (
				children
			)}
		</span>
	)
}
