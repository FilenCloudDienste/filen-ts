import { canMove, canResize, selectKey, type ToolKey } from "@filen/office/react/pdfedit/tools"
import type { PdfAnnotationInfo } from "@filen/office/core/pdfedit/annotations"
import { annotationStoreOf } from "@/features/pdf/annotations/annotationStore"
import type { PdfToolContext, PdfToolKeyEvent } from "@/features/pdf/tools/registry"

// The annotation tools' keys on the page surface. Space held is a temporary hand while a tool is active (with nothing
// active, Space keeps scrolling the pages). The selection: arrows nudge it (Shift ×10), Alt+arrows resize it, Delete
// removes it, Escape drops it; each change one command. A placing tool: Enter starts a keyboard placement on the page
// in view, arrows move it, Enter places it, Escape cancels it, and with nothing placing Escape goes back to selection.

function toolKey(event: PdfToolKeyEvent): ToolKey | null {
	return event.key === "Space" ? null : { key: event.key, shift: event.shift, alt: event.alt }
}

function hand(event: PdfToolKeyEvent, context: PdfToolContext): boolean {
	if (event.key !== "Space" || context.activeTool === null) return false

	annotationStoreOf(context.swap).setHand(event.kind === "down")

	return true
}

// An arrow the selection takes even when it changes nothing (already at the minimum size, or flush with the page
// edge), so it does not scroll the pages instead; one that cannot move or resize it (locked, a markup) is not taken.
function takesArrow(selected: PdfAnnotationInfo, key: ToolKey): boolean {
	if (!key.key.startsWith("Arrow")) return false

	return key.alt === true ? canResize(selected) : canMove(selected)
}

export function selectionKey(event: PdfToolKeyEvent, context: PdfToolContext): boolean {
	if (hand(event, context)) return true

	const key = toolKey(event)
	const store = annotationStoreOf(context.swap)
	const selected = store.getState().selected

	if (event.kind !== "down" || key === null || selected === null) return false

	// An arrow stays inside the selected annotation's page (Escape and Delete do not read the box): with that box not
	// known yet, it is taken and does nothing, so it cannot walk the annotation off the page.
	const box = store.pageBox(selected.page)

	if (box === undefined && key.key.startsWith("Arrow")) return takesArrow(selected, key)

	const step = selectKey({ selected, drag: null }, key, box ?? selected.rect)
	const commit = step.commit

	if (step.state.selected !== selected) store.select(step.state.selected)

	if (commit === undefined) return step.state.selected !== selected || takesArrow(selected, key)
	if (commit.kind === "select") return true
	if (!context.editable) return true

	context.edit(session =>
		commit.kind === "move"
			? session.dispatch("annotations.move", { ...commit.ref, dx: commit.dx, dy: commit.dy })
			: commit.kind === "resize"
				? session.dispatch("annotations.resize", { ...commit.ref, rect: commit.rect })
				: session.dispatch("annotations.delete", commit.ref)
	)

	return true
}

export function placingKey(event: PdfToolKeyEvent, context: PdfToolContext): boolean {
	if (hand(event, context)) return true

	const key = toolKey(event)

	if (event.kind !== "down" || key === null) return false
	if (annotationStoreOf(context.swap).key(event.page, key)) return true

	if (key.key === "Escape") {
		context.finish()

		return true
	}

	return false
}
