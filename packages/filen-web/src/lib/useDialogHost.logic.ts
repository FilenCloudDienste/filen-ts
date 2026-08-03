export interface DialogNavigationCloseInput {
	hasDialog: boolean
	// The same gate dismissal.logic.ts applies to Escape/outside-press: a close must never race an
	// in-flight mutation the host is still awaiting.
	pending: boolean
	// The host declared this dialog kind's navigation semantics its own — see keepOpenOnNavigate.
	keepOpen: boolean
}

// "defer" = the close is owed, not dropped: the host is mid-mutation, so it is re-evaluated once that
// settles. Every host closes as the last step of its own successful tail, but the ERROR arms
// deliberately keep the dialog open for a retry — which, after a navigation, is a retry against the
// screen the user already left.
export type DialogNavigationCloseOutcome = "close" | "defer" | "ignore"

// What a location change does to the host's open dialog. A modal belongs to the screen it was opened
// from; leaving that screen while the host itself stays mounted (an in-place param change, a browser
// back/forward) would otherwise strand it over a view it no longer describes.
export function resolveDialogNavigationClose({ hasDialog, pending, keepOpen }: DialogNavigationCloseInput): DialogNavigationCloseOutcome {
	if (!hasDialog || keepOpen) {
		return "ignore"
	}

	return pending ? "defer" : "close"
}
