// Roving-tabindex cursor math for the drive listbox — kept as pure functions so the surrounding
// component only ever wires DOM events to arithmetic, never re-derives it inline.

import { hasClosest } from "@/lib/domTarget"

// Clamps a cursor into [0, length-1]. Callers must not invoke this against an empty list (the
// listbox itself is not rendered in that state — see directoryListing.tsx's empty branch); the 0
// fallback here exists only so a transient zero-length render can never throw.
export function clampListboxIndex(index: number, length: number): number {
	if (length <= 0) {
		return 0
	}

	return Math.min(Math.max(index, 0), length - 1)
}

// The items between an anchor and the active cursor, inclusive and ascending regardless of which side
// is larger — the shape Shift+Arrow/Shift+Click both turn into a selection. Out-of-range indices are
// skipped.
export function listboxRangeItems<T>(items: readonly T[], anchor: number, active: number): T[] {
	const end = Math.max(anchor, active)
	const range: T[] = []

	for (let i = Math.min(anchor, active); i <= end; i++) {
		const item = items[i]

		if (item !== undefined) {
			range.push(item)
		}
	}

	return range
}

// Re-maps a roving cursor/anchor tracked by item identity back onto the CURRENT item-set's index —
// a positional index alone drifts under a background reorder (e.g. sort-by-size backfilling sizes,
// or a live socket/optimistic patch) with no navigation, silently retargeting Enter/Shift+Arrow onto
// the wrong item. `fallbackIndex` is the last position the tracked uuid resolved to (or the initial
// position before any move): used only when the uuid is no longer present in `uuids` (item deleted/
// moved/filtered out from under the cursor), clamped into the current bounds as the nearest neighbor.
export function resolveCursorIndex(targetUuid: string | null, uuids: readonly string[], fallbackIndex: number): number {
	if (targetUuid !== null) {
		const index = uuids.indexOf(targetUuid)

		if (index !== -1) {
			return index
		}
	}

	return clampListboxIndex(fallbackIndex, uuids.length)
}

// The plain-Arrow/Home/End cursor target for one key press, or null for a key this listbox does not
// move on. `step` is how far a vertical arrow jumps (1 in a single-column list, `columns` in a grid);
// `horizontal` enables Left/Right, which a single-column list has no axis for. The result is raw —
// callers clamp it through moveActive/clampListboxIndex. One definition of the table, shared by the
// drive listbox and the photos grid.
export function listboxKeyTarget(key: string, activeIndex: number, itemCount: number, step: number, horizontal: boolean): number | null {
	if (key === "ArrowDown") {
		return activeIndex + step
	}

	if (key === "ArrowUp") {
		return activeIndex - step
	}

	if (key === "ArrowRight" && horizontal) {
		return activeIndex + 1
	}

	if (key === "ArrowLeft" && horizontal) {
		return activeIndex - 1
	}

	if (key === "Home") {
		return 0
	}

	if (key === "End") {
		return itemCount - 1
	}

	return null
}

// Controls inside an option that own their own keys: the row or tile's ⋯ menu trigger, which carries
// the cursor option's tab stop alongside the option itself.
const INTERACTIVE_KEY_TARGET_SELECTOR = "button, a, input, select, textarea"

// True when a keydown started on such a control rather than on the option itself. The listbox leaves
// those keys alone: its preventDefault on Enter/Space would cancel the native click the control's menu
// opens on. Shared by the drive listbox and the photos grid.
export function listboxKeyTargetIsInteractive(target: EventTarget | null): boolean {
	return hasClosest(target) && target.closest(INTERACTIVE_KEY_TARGET_SELECTOR) !== null
}

// A plain click on the item that already IS the whole selection deselects it. Only the first click of a
// sequence (`clickCount` is the event's `detail`): the second click of a double-click lands on the item
// the first one just selected or deselected, and has to leave it selected for the open that follows.
// A touch tap never gets here (touchTapIntent decides it).
export function isPlainClickDeselect(selected: readonly { data: { uuid: string } }[], uuid: string, clickCount: number): boolean {
	return clickCount === 1 && selected.length === 1 && selected[0]?.data.uuid === uuid
}

// The pointer type a click reports itself, or "" where the browser still dispatches click as a plain
// MouseEvent. Not trusted alone: some iOS Safari builds report a tap's click as "mouse" (see
// useTouchLongPress's pointerType).
export function clickPointerType(event: MouseEvent): string {
	return "pointerType" in event && typeof event.pointerType === "string" ? event.pointerType : ""
}

// The modifier flags a click carries, decoupled from React's MouseEvent so pure resolvers can take a
// hand-built object.
export interface ClickModifiers {
	shiftKey: boolean
	metaKey: boolean
	ctrlKey: boolean
}

// Ctrl/Cmd toggles one item in or out of the selection (Shift extends a range instead).
export function isToggleModifier(modifiers: Pick<ClickModifiers, "metaKey" | "ctrlKey">): boolean {
	return modifiers.metaKey || modifiers.ctrlKey
}

// Any of Shift/Ctrl/Cmd makes a click a selection gesture rather than an open or navigation.
export function isSelectionGesture(modifiers: ClickModifiers): boolean {
	return modifiers.shiftKey || isToggleModifier(modifiers)
}

// What a plain touch tap does to an item of a click-to-select list: opens it while nothing is selected,
// and toggles it once something is (selection mode, entered by a long-press). null for a mouse, pen or
// keyboard click and for a modified tap, which keep the file-manager model: a click selects, a double
// click opens.
export function touchTapIntent(pointerType: string, modifiers: ClickModifiers, selectionCount: number): "open" | "toggle" | null {
	if (pointerType !== "touch" || isSelectionGesture(modifiers)) {
		return null
	}

	return selectionCount > 0 ? "toggle" : "open"
}

// Click handler for a row's navigating Link. `onPointerSelect` returns true when it took the click as a
// selection gesture (a modified click, or a touch tap in selection mode): that click is preventDefaulted,
// blocking both the router's SPA navigate and the browser's native open-in-new-tab. Any other click still
// navigates.
export function selectionAwareLinkClick<E extends { preventDefault: () => void }>(onPointerSelect: (event: E) => boolean): (event: E) => void {
	return event => {
		if (onPointerSelect(event)) {
			event.preventDefault()
		}
	}
}
