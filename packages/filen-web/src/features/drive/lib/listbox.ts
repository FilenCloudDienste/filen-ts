// Roving-tabindex cursor math for the drive listbox — kept as pure functions so the surrounding
// component only ever wires DOM events to arithmetic, never re-derives it inline.

import { isImeKeydown } from "@filen/shared/keymap"
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
// drive listbox and the photos grid. `pageStep`, how many items a screenful holds, enables PageUp and
// PageDown; a caller that cannot say leaves them to the browser.
export function listboxKeyTarget(
	key: string,
	activeIndex: number,
	itemCount: number,
	step: number,
	horizontal: boolean,
	pageStep?: number
): number | null {
	if (key === "ArrowDown") {
		return activeIndex + step
	}

	if (key === "ArrowUp") {
		return activeIndex - step
	}

	if (pageStep !== undefined && key === "PageDown") {
		return activeIndex + pageStep
	}

	if (pageStep !== undefined && key === "PageUp") {
		return activeIndex - pageStep
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

// Type-ahead, the WAI-ARIA listbox's and every file manager's: printable keys typed within TYPE_AHEAD_RESET_MS of
// each other build one prefix, and the cursor jumps to the next item whose name starts with it. Shared by the drive
// listbox and the photos grid (useListboxTypeAhead), which is why neither binds a bare printable key as a shortcut.
export const TYPE_AHEAD_RESET_MS = 1000

// What type-ahead reads of a keydown.
export interface TypeAheadKeyEvent {
	readonly key: string
	readonly ctrlKey: boolean
	readonly metaKey: boolean
	readonly altKey: boolean
	readonly isComposing?: boolean
	readonly keyCode?: number
	readonly target: EventTarget | null
}

// Whether a prefix typed `at` is still being added to `now`.
export function typeAheadBuffering(text: string, at: number, now: number): boolean {
	return text.length > 0 && now - at < TYPE_AHEAD_RESET_MS
}

function isEditableTarget(target: EventTarget | null): boolean {
	return typeof target === "object" && target !== null && "isContentEditable" in target && target.isContentEditable === true
}

// The character a keydown adds to the prefix, or null when it is not type-ahead's: a named key, a chord with Ctrl,
// Cmd or Alt (Shift only picks the character), a key an input method is composing with, or one typed into an
// editable. Space continues a prefix ("my file") but never starts one: alone it toggles the cursor's item.
export function typeAheadCharacter(event: TypeAheadKeyEvent, buffering: boolean): string | null {
	const { key } = event

	// One character, or one astral character's surrogate pair; a named key ("Enter", "F2") is longer.
	const printable = key.length === 1 || (key.length === 2 && key.charCodeAt(0) >= 0xd800 && key.charCodeAt(0) <= 0xdbff)

	if (
		!printable ||
		event.ctrlKey ||
		event.metaKey ||
		event.altKey ||
		(key === " " && !buffering) ||
		isImeKeydown(event) ||
		isEditableTarget(event.target)
	) {
		return null
	}

	return key
}

// Case- and accent-insensitive, in the user's locale: "e" finds "École".
const TYPE_AHEAD_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", usage: "search" })

// Combining diacritical marks, which a name stored decomposed (NFD, as macOS writes them) carries after its base
// letter. The collator ignores accents anyway, so both sides skip them.
function isCombiningMark(code: number): boolean {
	return code >= 0x300 && code <= 0x36f
}

// Whether `name` starts with `prefix`, compared a character at a time so no substring is built per item.
export function startsWithTypeAhead(name: string, prefix: string): boolean {
	let at = 0

	for (let p = 0; p < prefix.length; p++) {
		const code = prefix.charCodeAt(p)

		if (isCombiningMark(code)) {
			continue
		}

		while (at < name.length && isCombiningMark(name.charCodeAt(at))) {
			at++
		}

		if (at >= name.length) {
			return false
		}

		if (name.charCodeAt(at) !== code && TYPE_AHEAD_COLLATOR.compare(name.charAt(at), prefix.charAt(p)) !== 0) {
			return false
		}

		at++
	}

	return true
}

// The index type-ahead moves the cursor to, or -1 when no name starts with `prefix`. A prefix just started (`fresh`)
// looks from the item after the cursor on, so typing its character again later steps through the items it starts; a
// prefix being added to looks from the cursor itself, which keeps its place while it still matches. Wraps past the end.
export function typeAheadIndex<T>(
	items: readonly T[],
	nameOf: (item: T) => string,
	activeIndex: number,
	prefix: string,
	fresh: boolean
): number {
	const count = items.length
	const start = fresh ? activeIndex + 1 : activeIndex

	for (let offset = 0; offset < count; offset++) {
		const index = (start + offset) % count
		const item = items[index]

		if (item !== undefined && startsWithTypeAhead(nameOf(item), prefix)) {
			return index
		}
	}

	return -1
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

// How many items a screenful of `viewportHeight` holds, `rowHeight` tall rows of `perRow` items: what PageUp and
// PageDown move by. Never less than one row, so a short viewport still moves.
export function listboxPageStep(viewportHeight: number, rowHeight: number, perRow: number): number {
	return Math.max(1, Math.floor(viewportHeight / rowHeight)) * perRow
}

// Opens the item menu of the option holding `target`, the keyboard twin of right-clicking it: the context menu the
// row or tile is the trigger of, placed over the option's leading edge, where Shift+F10 on Windows places it. False
// when `target` is in no option.
export function openOptionContextMenu(target: EventTarget | null): boolean {
	const option = hasClosest(target) ? target.closest('[role="option"]') : null

	if (option === null) {
		return false
	}

	const rect = option.getBoundingClientRect()
	const inset = Math.min(rect.width, rect.height) / 2

	option.dispatchEvent(
		new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			button: 2,
			clientX: rect.left + inset,
			clientY: rect.top + rect.height / 2
		})
	)

	return true
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
export function selectionAwareLinkClick<E extends { preventDefault: () => void }>(
	onPointerSelect: (event: E) => boolean
): (event: E) => void {
	return event => {
		if (onPointerSelect(event)) {
			event.preventDefault()
		}
	}
}
