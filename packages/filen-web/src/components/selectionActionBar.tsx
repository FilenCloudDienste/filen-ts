import { createElement, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { XIcon, type LucideIcon } from "lucide-react"
import { Kbd } from "@/lib/keymap/kbd"
import { toastObstructionRef } from "@/lib/toastClearance"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"

// Surfaces whose rows carry their own actions mount the floating bar only from two selected up.
export const BULK_BAR_MIN_SELECTION = 2

// Bottom-anchored floating selection pill: clear + count on the left, the surface's actions on the right.
export function SelectionActionBar(props: { count: number; onClear: () => void; clearKbdAction: string; children: ReactNode }) {
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
				<p className="text-sm text-muted-foreground">{t("selectedCount", { count: props.count })}</p>
			</div>
			<div className="flex items-center gap-2">{props.children}</div>
		</div>
	)
}

// Icon-only keeps the pill compact: the label is the stable accessible name, and a disabled button
// explains itself through both the tooltip and a native title.
export function BulkActionButton(props: {
	icon: LucideIcon
	label: string
	destructive?: boolean | undefined
	disabled?: boolean | undefined
	disabledReason?: string | undefined
	kbdAction?: string | undefined
	onClick: () => void
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant={props.destructive === true ? "destructive" : "outline"}
						size="icon-sm"
						disabled={props.disabled}
						aria-label={props.label}
						title={props.disabledReason}
						onClick={props.onClick}
					>
						{createElement(props.icon, { "aria-hidden": true })}
					</Button>
				}
			/>
			<TooltipContent>
				{props.disabledReason ?? props.label}
				{props.kbdAction === undefined ? null : <Kbd action={props.kbdAction} />}
			</TooltipContent>
		</Tooltip>
	)
}
