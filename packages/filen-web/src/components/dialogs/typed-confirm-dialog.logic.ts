// Pure arm/disarm rules for TypedConfirmDialog, split out of the component file: react-refresh
// requires a component file to export components only, and these two are plain functions consumed
// by both the component and its colocated test.

// Exact-match only (no trim/case-fold): `matchValue` is a live value (an email, a directory name,
// etc.) the caller already holds, never a translated string — i18n copy can reword at any time,
// which would make the required input silently unreproducible (or trivially wrong) the moment a
// translation changes, and reproducing exactly what the user already sees elsewhere is the whole
// point of typed confirmation.
export function isArmed(typed: string, matchValue: string): boolean {
	return typed === matchValue
}

// True exactly on the render where `open` flips false→true — the point where a previous attempt's
// typed value must not resurface.
export function shouldResetOnOpen(open: boolean, wasOpen: boolean): boolean {
	return open && !wasOpen
}
