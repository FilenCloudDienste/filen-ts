import type { ComponentProps, ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type ButtonProps = ComponentProps<typeof Button>

// An icon-only button whose label is both its accessible name and its tooltip; `shortcut` (a Kbd chip)
// follows the label in the tooltip. `pressed` stays undefined for a button that is not a toggle.
export function TooltipIconButton(props: {
	label: string
	onClick?: ButtonProps["onClick"]
	onMouseDown?: ButtonProps["onMouseDown"]
	disabled?: boolean | undefined
	pressed?: boolean | undefined
	variant?: ButtonProps["variant"]
	className?: string | undefined
	shortcut?: ReactNode
	children: ReactNode
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant={props.variant ?? "ghost"}
						size="icon-sm"
						aria-label={props.label}
						aria-pressed={props.pressed}
						disabled={props.disabled}
						className={props.className}
						onMouseDown={props.onMouseDown}
						onClick={props.onClick}
					>
						{props.children}
					</Button>
				}
			/>
			<TooltipContent>
				{props.label}
				{props.shortcut}
			</TooltipContent>
		</Tooltip>
	)
}
