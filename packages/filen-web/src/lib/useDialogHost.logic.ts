export interface DialogNavigationCloseInput {
	hasDialog: boolean
	// The same gate dismissal.logic.ts applies to Escape/outside-press: a close must never race an
	// in-flight mutation the host is still awaiting. Every host closes (or deliberately keeps open, on
	// error) as the last step of its own async tail, so a dialog left open here is closed there.
	pending: boolean
	// The host declared this dialog kind's navigation semantics its own — see keepOpenOnNavigate.
	keepOpen: boolean
}

// Whether a location change closes the host's open dialog. A modal belongs to the screen it was
// opened from; leaving that screen while the host itself stays mounted (an in-place param change, a
// browser back/forward) would otherwise strand it over a view it no longer describes.
export function shouldCloseDialogOnNavigate({ hasDialog, pending, keepOpen }: DialogNavigationCloseInput): boolean {
	return hasDialog && !pending && !keepOpen
}
