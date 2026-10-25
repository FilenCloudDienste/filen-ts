import type { ReactNode } from "react"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { keepFocus } from "@/features/office/lib/officeControls"

// The ribbon's own controls beside the icon buttons (TooltipIconButton): a command with its name shown, and the
// trigger of a dropdown (its icon, its name when shown, a chevron). Pressing either keeps focus in the document.

export function RibbonButton({
	label,
	icon,
	text,
	disabled,
	pressed,
	shortcut,
	onClick
}: {
	label: string
	icon: ReactNode
	// The name shown beside the icon (the label when absent: icon only).
	text?: string | undefined
	disabled?: boolean | undefined
	pressed?: boolean | undefined
	shortcut?: ReactNode
	onClick: () => void
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size={text === undefined ? "icon-sm" : "sm"}
						aria-label={label}
						aria-pressed={pressed}
						disabled={disabled}
						className={cn("shrink-0", text !== undefined && "gap-1 px-2", pressed === true && "bg-accent text-foreground")}
						onMouseDown={keepFocus}
						onClick={onClick}
					>
						{icon}
						{text === undefined ? null : <span className="text-xs">{text}</span>}
					</Button>
				}
			/>
			<TooltipContent>
				{label}
				{shortcut}
			</TooltipContent>
		</Tooltip>
	)
}

// Inside a DropdownMenu, before its content.
export function RibbonMenuTrigger({
	label,
	icon,
	text,
	disabled,
	shortcut,
	children
}: {
	label: string
	icon: ReactNode
	text?: string | undefined
	disabled?: boolean | undefined
	shortcut?: ReactNode
	// Shown on the button itself (a dot while track changes is on).
	children?: ReactNode
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="sm"
								aria-label={label}
								disabled={disabled}
								className="relative shrink-0 gap-0.5 px-1.5"
								onMouseDown={keepFocus}
							>
								{icon}
								{text === undefined ? null : <span className="ml-0.5 text-xs">{text}</span>}
								<ChevronDownIcon className="size-3" />
								{children}
							</Button>
						}
					/>
				}
			/>
			<TooltipContent>
				{label}
				{shortcut}
			</TooltipContent>
		</Tooltip>
	)
}
