// Focus a popup hands back to its trigger as it closes (a menu's, a dialog's): from inside that popup, or from nowhere once
// it unmounted. Focus the user moves (Tab), or that moves within the popup holding the trigger, comes from elsewhere.
export function isFocusReturn(event: Event, trigger: Element | undefined): boolean {
	if (!(event instanceof FocusEvent)) {
		return false
	}

	const from = event.relatedTarget

	if (!(from instanceof Element)) {
		return from === null
	}

	const layer = from.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]')

	return layer !== null && (trigger === undefined || !layer.contains(trigger))
}
