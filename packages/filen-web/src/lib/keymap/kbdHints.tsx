import type { ReactElement } from "react"
import { parseCombo } from "@filen/shared/keymap"
import { MenuShortcut } from "@/components/ui/menuShortcut"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useComboFor } from "@/lib/keymap/registry"
import { Kbd } from "@/lib/keymap/kbd"

// Where a control names its action's keys beside its label: a menu item's end, a labelled button's tooltip.

// A menu item's key hint: the action's keys in effect at the item's end (nothing for no action, or an unbound one).
export function MenuKbd({ action }: { action: string | undefined }) {
	return action === undefined ? null : (
		<MenuShortcut>
			<Kbd action={action} />
		</MenuShortcut>
	)
}

// A labelled control's tooltip naming it with its action's keys, only while the action has keys: without them the
// tooltip would only repeat the label the control already shows. `children` is the control (the tooltip's trigger).
export function KeyTooltip({ action, label, children }: { action: string; label: string; children: ReactElement }) {
	const bound = parseCombo(useComboFor(action)).length > 0

	if (!bound) {
		return children
	}

	return (
		<Tooltip>
			<TooltipTrigger render={children} />
			<TooltipContent>
				{label}
				<Kbd action={action} />
			</TooltipContent>
		</Tooltip>
	)
}
