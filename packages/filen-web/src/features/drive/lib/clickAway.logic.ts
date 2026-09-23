// Click-away deselection (hooks/useClickAwayDeselect.ts): a plain click on "empty space" clears the
// selection, like clicking a file manager's background. Everything that acts on or around the selection
// is excluded instead — the items themselves, every control, and every overlay.

// Opt-in marker (spread onto the element) for a surface that is neither a control nor an overlay but must
// keep the selection when its background is clicked: a bulk bar, the breadcrumb, the search field.
const KEEP_SELECTION_ATTRIBUTE = "data-keep-selection"

export const KEEP_SELECTION_PROPS = { [KEEP_SELECTION_ATTRIBUTE]: "" }

const KEEP_SELECTION_SELECTOR = [
	'[role="option"]',
	"button",
	"a",
	"input",
	"textarea",
	"select",
	"label",
	"summary",
	'[contenteditable]:not([contenteditable="false"])',
	'[role="button"]',
	'[role="link"]',
	'[role="checkbox"]',
	'[role="radio"]',
	'[role="switch"]',
	'[role="slider"]',
	'[role="tab"]',
	'[role="treeitem"]',
	'[role="combobox"]',
	'[role="menu"]',
	'[role="menubar"]',
	'[role="menuitem"]',
	'[role="menuitemcheckbox"]',
	'[role="menuitemradio"]',
	'[role="dialog"]',
	'[role="alertdialog"]',
	'[role="tooltip"]',
	'[role="toolbar"]',
	// the sidebar resize handles
	'[role="separator"]',
	"[data-sonner-toaster]",
	`[${KEEP_SELECTION_ATTRIBUTE}]`
].join(", ")

// True when a click on `target` must leave the selection alone. `root` is the React root: anything
// outside it was portalled (menus, dialogs, popovers, tooltips), so it is an overlay by construction. A
// target that is not an element at all is never treated as empty space.
export function isKeepSelectionTarget(target: EventTarget | null, root: Node | null): boolean {
	if (!(target instanceof Element)) {
		return true
	}

	if (root !== null && !root.contains(target)) {
		return true
	}

	return target.closest(KEEP_SELECTION_SELECTOR) !== null
}

export interface ClickModifierState {
	button: number
	detail: number
	shiftKey: boolean
	metaKey: boolean
	ctrlKey: boolean
	altKey: boolean
}

// A primary-button click with no modifier. `detail` is 0 for a click synthesized from the keyboard
// (Enter/Space on a control) or from script, neither of which is a pointer landing anywhere.
export function isPlainPointerClick(event: ClickModifierState): boolean {
	return event.button === 0 && event.detail > 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
}

// A press that began in an element's scrollbar gutter: outside its client box while it overflows. Such a
// press scrolls, it does not click on empty space. `offsetX`/`offsetY` are relative to the element's
// border box.
export function isScrollbarPress(
	offsetX: number,
	offsetY: number,
	el: {
		clientLeft: number
		clientTop: number
		clientWidth: number
		clientHeight: number
		scrollWidth: number
		scrollHeight: number
	}
): boolean {
	const overflowsY = el.scrollHeight > el.clientHeight
	const overflowsX = el.scrollWidth > el.clientWidth

	return (overflowsY && offsetX - el.clientLeft >= el.clientWidth) || (overflowsX && offsetY - el.clientTop >= el.clientHeight)
}

// Whether a right-click or long-press on `target` lands on `container`'s own empty space (a listing's
// background menu) rather than on an item or a control inside it. Only the container's DOM subtree
// counts: a portalled popup's events still bubble through the React tree to the container's handlers.
// The match is bounded to the container, so a keep-selection marker on one of its ancestors does not
// turn its whole background into a control. `offsetX`/`offsetY` are relative to the container's border
// box, as in isScrollbarPress.
export function isEmptySpaceTarget(target: EventTarget | null, container: HTMLElement, offsetX: number, offsetY: number): boolean {
	if (!(target instanceof Element) || !container.contains(target)) {
		return false
	}

	if (target === container && isScrollbarPress(offsetX, offsetY, container)) {
		return false
	}

	const hit = target.closest(KEEP_SELECTION_SELECTOR)

	return hit === null || !container.contains(hit)
}
