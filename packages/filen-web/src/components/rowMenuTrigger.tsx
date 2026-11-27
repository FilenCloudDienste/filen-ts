import { MoreHorizontalIcon } from "lucide-react"
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip"
import { RowTooltipContent } from "@/components/lazyTooltip"
import { stopRowPropagation } from "@/lib/domEvents"
import { REVEAL_CLASS } from "@/components/rowReveal"

export interface RowMenuTriggerProps {
	label: string
	reveal: keyof typeof REVEAL_CLASS
	tabIndex?: number
}

// Hover-revealed ⋯ trigger for a list row or grid tile; render inside the row's <DropdownMenu>.
export function RowMenuTrigger({ label, reveal, tabIndex }: RowMenuTriggerProps) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
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
				}
			/>
			<RowTooltipContent>{label}</RowTooltipContent>
		</Tooltip>
	)
}
