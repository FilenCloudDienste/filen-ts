// Where F6 lands in a ribbon (the Word editor's panes; the spreadsheet's data-sheet-pane cycle finds the same
// first control): its File menu, as in Office, else its selected tab.
export function ribbonLanding(root: Element): HTMLElement | null {
	return (
		root.querySelector<HTMLElement>("[data-ribbon-file]:not(:disabled)") ??
		root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
	)
}
