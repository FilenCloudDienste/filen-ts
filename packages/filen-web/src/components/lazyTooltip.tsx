import { useState, type ReactElement } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

// A styled tooltip that costs nothing until the pointer reaches its element: the tooltip is created on
// pointer enter and dropped on leave, for marks repeated in every row of a long list. The stable wrapper owns
// the hover, since the element under the pointer is swapped for the tooltip's trigger. The element should
// carry its own accessible text; the tooltip is a visual aid only.
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
					<TooltipContent className="whitespace-pre-line">{label}</TooltipContent>
				</Tooltip>
			) : (
				children
			)}
		</span>
	)
}
