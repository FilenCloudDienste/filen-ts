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

// A key F6 is read from: React's on a viewer's root, or the page's for one pressed elsewhere in its layer.
export interface PaneKeyEvent {
	readonly key: string
	readonly ctrlKey: boolean
	readonly metaKey: boolean
	readonly altKey: boolean
	readonly defaultPrevented: boolean
	readonly target: EventTarget | null
	preventDefault(): void
}

// F6 and Shift+F6 in a viewer (`root`) move between its command bar and its content, as Office's panes.
export function onCommandBarF6(event: PaneKeyEvent, root: Element, focusContent: () => void): void {
	if (event.key !== "F6" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
		return
	}

	const bar = root.querySelector("[data-office-ribbon]")

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
