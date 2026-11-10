// Every Base UI Dialog/AlertDialog popup in this codebase carries its own `role="dialog"` (Dialog) or
// `role="alertdialog"` (AlertDialog, used by ConfirmDialog/TypedConfirmDialog) plus a `data-open`
// attribute for as long as it's open — `CommonPopupDataAttributes.open` in the installed package's own
// utils/popupStateMapping.js, driven synchronously off React state, not a deferred side effect. A
// scroll-lock attribute (Base UI's `useScrollLock`, which some dialogs also engage) looked like a
// simpler shared signal but is NOT reliable here: it only gets written on the "inset scrollbars"
// code path (@base-ui/utils/useScrollLock.js's `preventScrollInsetScrollbars`) — verified live via a
// real preview-overlay Dialog in Playwright/Chromium, where the "overlay scrollbars" branch runs
// instead and never sets it, silently making that signal always-false. `[role="dialog"]`/
// `[role="alertdialog"]` is what every one of this app's dialogs actually renders regardless of that
// branch, so it covers the drive dialog host's confirm/rename/input dialogs, the preview overlay
// (mounts through that same host, see useDriveDialogHost.tsx's `kind: "preview"`), and every
// settings-route dialog — with zero opt-in wiring, and stays correct automatically as new dialogs are
// added, as long as they build on Base UI's Dialog store: the shell's narrow-viewport sidebar drawer
// renders the same `role="dialog"` + `data-open` pair and is covered here for free.
//
// A plain synchronous DOM read, not a subscribed hook or a new global store: every caller here is a
// keyboard-shortcut handler mounted well outside the drive feature (theme toggle, rail navigation)
// that only needs the answer at the moment a key is pressed.
const OPEN_DIALOG_SELECTOR = '[role="dialog"][data-open], [role="alertdialog"][data-open]'

export function isAnyDialogOpen(): boolean {
	return document.querySelector(OPEN_DIALOG_SELECTOR) !== null
}

// The dialog a node is shown in (the preview overlay, a dialog over it), or null on the page itself: a key belongs to
// an editor only when it was pressed in the editor's own layer, whatever dialogs that layer is.
export function dialogLayerOf(node: Element): Element | null {
	return node.closest('[role="dialog"], [role="alertdialog"]')
}

// Base UI menus (dropdown AND context) carry `role="menu"` + the same `data-open` marker while open.
// Escape belongs to an open menu — Base UI closes it on Escape itself — so a global Escape action must
// stand down, exactly as it already does for dialogs. Without this a bulk context menu is
// undismissable: Escape clears the drive selection instead, the row swaps its bulk menu content for
// the single-item one WHILE the menu is open, and the stranded popup keeps `data-open` forever.
const OPEN_MENU_SELECTOR = '[role="menu"][data-open]'

export function isAnyMenuOpen(): boolean {
	return document.querySelector(OPEN_MENU_SELECTOR) !== null
}

// Both of the above as one selector, for a caller that asks "is ANY layer still stacked over the page"
// rather than which kind, in one DOM scan. The selector itself is exported because the e2e teardown
// helper (e2e/helpers/listing.ts) needs the same answer from outside the page, and the two selectors
// above are subtle enough (see their comments) that a second copy of them would drift.
export const OPEN_OVERLAY_SELECTOR = `${OPEN_DIALOG_SELECTOR}, ${OPEN_MENU_SELECTOR}`

export function isAnyOverlayOpen(): boolean {
	return document.querySelector(OPEN_OVERLAY_SELECTOR) !== null
}

// Whether a dialog or menu is open other than the one holding `node`: a drawer's own toggle may close it, but not
// from under a confirm the drawer opened.
export function isOverlayOpenBesides(node: Element | null): boolean {
	for (const overlay of document.querySelectorAll(OPEN_OVERLAY_SELECTOR)) {
		if (node === null || !overlay.contains(node)) {
			return true
		}
	}

	return false
}

// Whether a key pressed with focus on `target` is for the editor at `root`: pressed in the editor, or anywhere else in
// the layer the editor is shown in (the preview overlay, which Safari and macOS Firefox leave focused after a click),
// but never in a native field outside the editor, which owns the key, nor in a dialog over the editor.
export function keyForEditor(root: Element, target: EventTarget | null): boolean {
	if (!(target instanceof Element)) {
		return false
	}

	if (root.contains(target)) {
		return true
	}

	if (target.matches("input, textarea, select") || (target instanceof HTMLElement && target.isContentEditable)) {
		return false
	}

	const layer = dialogLayerOf(root)

	return dialogLayerOf(target) === layer && (layer !== null || !isAnyDialogOpen())
}
