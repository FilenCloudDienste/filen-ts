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
	// An input method's composition the key belongs to (the page's event, or React's through nativeEvent).
	readonly isComposing?: boolean
	readonly nativeEvent?: { readonly isComposing: boolean }
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

// The parts of an editor that are not its document: the ribbon or command bar, and the panes (slide rail, notes,
// comments, Animation Pane, SmartArt text pane, sheet tabs), marked data-office-pane.
const CHROME = "[data-office-ribbon], [data-office-pane]"

// What answers its own Escape first: a field (an entry to cancel) and a list's or grid's item (a selection to clear).
const OWN_ESCAPE =
	'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="option"], [role="row"], [role="gridcell"], [role="treeitem"]'

// Escape on a control of the ribbon, command bar or a pane in `root` (an editor's or a viewer's) gives the document the
// focus (`focusDocument`: its canvas, page or grid), as desktop Office does, and is taken (prevented), so the preview
// overlay, which closes on an Escape nothing took, stays: only an Escape from the document closes it. Called twice by
// the root: in the capture phase for a button or tab (ahead of its tooltip, which would otherwise take the key and leave
// focus there; moving focus hides it too), and in the bubble phase for what answers its own Escape first (OWN_ESCAPE:
// a field cancels its entry and takes the key; the next press is this rule's). A menu, popup or dialog opened from
// them answers its own Escape: it is pressed in them, or the control says it is expanded (a combobox's list); so does
// an input method's composition. True when it was taken.
export function onRibbonEscape(event: PaneKeyEvent, root: Element, focusDocument: () => void, phase: "capture" | "bubble"): boolean {
	if (
		event.key !== "Escape" ||
		event.defaultPrevented ||
		event.ctrlKey ||
		event.metaKey ||
		event.altKey ||
		event.isComposing === true ||
		event.nativeEvent?.isComposing === true
	) {
		return false
	}

	const target = event.target instanceof Element ? event.target : null
	const region = target?.closest(CHROME) ?? null

	if (target === null || region === null || !root.contains(region) || target.getAttribute("aria-expanded") === "true") {
		return false
	}

	if ((target.closest(OWN_ESCAPE) !== null) !== (phase === "bubble")) {
		return false
	}

	event.preventDefault()
	focusDocument()

	return true
}
