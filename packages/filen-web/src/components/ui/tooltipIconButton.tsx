import { useId, type ComponentProps, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@filen/shared"

type ButtonProps = ComponentProps<typeof Button>

// A disabled button with a reason stays focusable and hoverable (aria-disabled, which still blocks activation) so
// its tooltip and accessible description can say why; without one it stays natively disabled and out of the tab order.
export const EXPLAINED_DISABLED_CLASS = "aria-disabled:cursor-default aria-disabled:opacity-50"

// The sr-only accessible description carrying a disabled button's reason, referenced by its aria-describedby.
export function DisabledReason(props: { id: string; reason: string | undefined }) {
	if (props.reason === undefined) {
		return null
	}

	return (
		<span
			id={props.id}
			className="sr-only"
		>
			{props.reason}
		</span>
	)
}

// An icon-only button whose label is both its accessible name and its tooltip; `shortcut` (a Kbd chip)
// follows the label in the tooltip. `pressed` stays undefined for a button that is not a toggle.
export function TooltipIconButton(props: {
	id?: string | undefined
	label: string
	onClick?: ButtonProps["onClick"]
	onMouseDown?: ButtonProps["onMouseDown"]
	disabled?: boolean | undefined
	pressed?: boolean | undefined
	variant?: ButtonProps["variant"]
	size?: ButtonProps["size"]
	className?: string | undefined
	tabIndex?: number | undefined
	// Why a disabled button is: it replaces the label in the tooltip and becomes the accessible description.
	title?: string | undefined
	shortcut?: ReactNode
	children: ReactNode
}) {
	const reasonId = useId()
	const reason = props.disabled === true ? props.title : undefined
	const explained = reason !== undefined

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						id={props.id}
						variant={props.variant ?? "ghost"}
						size={props.size ?? "icon-sm"}
						aria-label={props.label}
						aria-pressed={props.pressed}
						aria-describedby={explained ? reasonId : undefined}
						disabled={props.disabled}
						focusableWhenDisabled={explained}
						tabIndex={props.tabIndex}
						className={explained ? cn(EXPLAINED_DISABLED_CLASS, props.className) : props.className}
						onMouseDown={props.onMouseDown}
						onClick={props.onClick}
					>
						{props.children}
						<DisabledReason
							id={reasonId}
							reason={reason}
						/>
					</Button>
				}
			/>
			<TooltipContent>
				{reason ?? props.label}
				{props.shortcut}
			</TooltipContent>
		</Tooltip>
	)
}
