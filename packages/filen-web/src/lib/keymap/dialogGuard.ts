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
// added, as long as they stay Dialog/AlertDialog (the app's only two dialog primitives today).
//
// A plain synchronous DOM read, not a subscribed hook or a new global store: every caller here is a
// keyboard-shortcut handler mounted well outside the drive feature (theme toggle, rail navigation)
// that only needs the answer at the moment a key is pressed.
const OPEN_DIALOG_SELECTOR = '[role="dialog"][data-open], [role="alertdialog"][data-open]'

export function isAnyDialogOpen(): boolean {
	return document.querySelector(OPEN_DIALOG_SELECTOR) !== null
}
