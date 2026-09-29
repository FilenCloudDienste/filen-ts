import { type MouseEvent } from "react"

// Menus and ⋯ triggers are React descendants of clickable rows, and a portaled popup's synthetic events
// still bubble through the React tree, so their clicks must not reach the row's select/open handlers.
export function stopRowPropagation(event: MouseEvent): void {
	event.stopPropagation()
}
