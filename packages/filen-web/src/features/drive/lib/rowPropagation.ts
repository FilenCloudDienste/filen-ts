import { type MouseEvent } from "react"

// A row's ⋯ dropdown is a React descendant of the row, so clicks in any popup bubble through the
// React tree into the row's own select/open handlers (see itemMenu.tsx). Unlike an item, a submenu
// trigger never closes the menu, so its click and double-click must not reach the row either.
export function stopRowPropagation(event: MouseEvent): void {
	event.stopPropagation()
}
