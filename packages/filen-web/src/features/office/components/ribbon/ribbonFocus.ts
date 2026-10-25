import type { KeyboardEvent } from "react"

// Where F6 lands in a ribbon (the Word editor's panes; the spreadsheet's data-sheet-pane cycle finds the same
// first control): its File menu, as in Office, else its selected tab.
export function ribbonLanding(root: Element): HTMLElement | null {
	return (
		root.querySelector<HTMLElement>("[data-ribbon-file]:not(:disabled)") ??
		root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
	)
}

// Where F6 lands in a command bar: its File menu, else its command row's stop (a viewer may offer no File menu).
export function commandBarLanding(root: Element): HTMLElement | null {
	return ribbonLanding(root) ?? root.querySelector<HTMLElement>('[role="toolbar"] [tabindex="0"], input:not(:disabled)')
}

// F6 and Shift+F6 on a viewer's root move between its command bar and its content, as Office's panes.
export function onCommandBarF6(event: KeyboardEvent<HTMLElement>, focusContent: () => void): void {
	if (event.key !== "F6" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
		return
	}

	const bar = event.currentTarget.querySelector("[data-office-ribbon]")

	if (bar === null) {
		return
	}

	event.preventDefault()

	if (event.target instanceof Node && bar.contains(event.target)) {
		focusContent()
	} else {
		commandBarLanding(bar)?.focus()
	}
}
