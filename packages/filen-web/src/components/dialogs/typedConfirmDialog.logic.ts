// Pure arm/disarm rules for TypedConfirmDialog, split out of the component file: react-refresh
// requires a component file to export components only, and these two are plain functions consumed
// by both the component and its colocated test.

// Exact-match only (no trim/case-fold): the caller guarantees the displayed instruction and
// `matchValue` are the same string by construction — a live value (an email, a directory name)
// interpolated into the copy, or a translated phrase resolved once and fed to both the copy and
// the check (see the matchValue prop notes) — so normalization here could only loosen the
// confirmation, never repair a drift.
export function isArmed(typed: string, matchValue: string): boolean {
	return typed === matchValue
}

// True exactly on the render where `open` flips false→true — the point where a previous attempt's
// typed value must not resurface.
export function shouldResetOnOpen(open: boolean, wasOpen: boolean): boolean {
	return open && !wasOpen
}
