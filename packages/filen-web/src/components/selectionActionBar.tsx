import { createElement, useId, useState, type ReactNode } from "react"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import { useTranslation } from "react-i18next"
import { XIcon, type LucideIcon } from "lucide-react"
import { Kbd } from "@/lib/keymap/kbd"
import { toastObstructionRef } from "@/lib/toastClearance"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DisabledReason, EXPLAINED_DISABLED_CLASS, TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

// Surfaces whose rows carry their own actions mount the floating bar only from two selected up.
export const BULK_BAR_MIN_SELECTION = 2

// Bottom-anchored floating selection pill: clear + count on the left, the surface's actions on the right.
// `countLabel` replaces the plain count with a surface's own line (the count and what it adds up to).
export function SelectionActionBar(props: {
	count: number
	countLabel?: string | undefined
	onClear: () => void
	clearKbdAction: string
	children: ReactNode
}) {
	const { t } = useTranslation("common")

	return (
		<div
			ref={toastObstructionRef}
			role="toolbar"
			aria-label={t("selectionActionsLabel")}
			className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-popover px-3 py-2 text-popover-foreground shadow-lg"
		>
			<div className="flex items-center gap-2">
				<TooltipIconButton
					label={t("clearSelection")}
					shortcut={<Kbd action={props.clearKbdAction} />}
					onClick={props.onClear}
				>
					<XIcon />
				</TooltipIconButton>
				<p className="text-sm text-muted-foreground">{props.countLabel ?? t("selectedCount", { count: props.count })}</p>
			</div>
			<div className="flex items-center gap-2">{props.children}</div>
		</div>
	)
}

// Icon-only keeps the pill compact: the label is the stable accessible name, and a disabled button
// explains itself through the tooltip and its accessible description.
export function BulkActionButton(props: {
	icon: LucideIcon
	label: string
	destructive?: boolean | undefined
	disabled?: boolean | undefined
	disabledReason?: string | undefined
	kbdAction?: string | undefined
	onClick: () => void
}) {
	const reasonId = useId()
	const reason = props.disabled === true ? props.disabledReason : undefined
	const explained = reason !== undefined

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant={props.destructive === true ? "destructive" : "outline"}
						size="icon-sm"
						disabled={props.disabled}
						focusableWhenDisabled={explained}
						aria-label={props.label}
						aria-describedby={explained ? reasonId : undefined}
						className={explained ? EXPLAINED_DISABLED_CLASS : undefined}
						onClick={props.onClick}
					>
						{createElement(props.icon, { "aria-hidden": true })}
						<DisabledReason
							id={reasonId}
							reason={reason}
						/>
					</Button>
				}
			/>
			<TooltipContent>
				{reason ?? props.label}
				{props.kbdAction === undefined ? null : <Kbd action={props.kbdAction} />}
			</TooltipContent>
		</Tooltip>
	)
}

// A key that opens a bar menu, mounted only while that menu is offered and enabled.
export function MenuShortcut(props: { action: string; onPress: () => void }) {
	useAction(
		props.action,
		keyboardEvent => {
			keyboardEvent.preventDefault()
			props.onPress()
		},
		OUTSIDE_OVERLAYS
	)

	return null
}

// A BulkActionButton that opens a menu of its `children` (dropdown-family entries) instead of acting. `kbdAction` shows in
// its tooltip and, unless `kbdOpensMenu` is false (a key the surface runs itself), opens it from the keyboard too while it
// is enabled and nothing else is open. `open`/`onOpenChange` control it from outside (a key that opens it on other
// content).
export function BulkActionMenuButton(props: {
	icon: LucideIcon
	label: string
	disabled?: boolean | undefined
	disabledReason?: string | undefined
	kbdAction?: string | undefined
	kbdOpensMenu?: boolean | undefined
	open?: boolean | undefined
	onOpenChange?: ((open: boolean) => void) | undefined
	children: ReactNode
}) {
	const [ownOpen, setOwnOpen] = useState(false)
	const open = props.open ?? ownOpen
	const setOpen = props.onOpenChange ?? setOwnOpen
	const reasonId = useId()
	const reason = props.disabled === true ? props.disabledReason : undefined
	const explained = reason !== undefined

	return (
		<DropdownMenu
			open={open}
			onOpenChange={setOpen}
		>
			{props.kbdAction === undefined || props.kbdOpensMenu === false || props.disabled === true ? null : (
				<MenuShortcut
					action={props.kbdAction}
					onPress={() => {
						setOpen(true)
					}}
				/>
			)}
			<Tooltip>
				<TooltipTrigger
					render={
						<DropdownMenuTrigger
							disabled={props.disabled}
							render={
								<Button
									variant="outline"
									size="icon-sm"
									disabled={props.disabled}
									focusableWhenDisabled={explained}
									aria-label={props.label}
									aria-describedby={explained ? reasonId : undefined}
									className={explained ? EXPLAINED_DISABLED_CLASS : undefined}
								>
									{createElement(props.icon, { "aria-hidden": true })}
									<DisabledReason
										id={reasonId}
										reason={reason}
									/>
								</Button>
							}
						/>
					}
				/>
				<TooltipContent>
					{reason ?? props.label}
					{props.kbdAction === undefined ? null : <Kbd action={props.kbdAction} />}
				</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="end">{props.children}</DropdownMenuContent>
		</DropdownMenu>
	)
}
