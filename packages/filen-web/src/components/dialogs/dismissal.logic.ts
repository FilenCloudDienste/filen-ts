// Shared dismissal gate for dialogs whose caller owns an async operation: a `false` open-change (any
// dismissal route — Escape, the X close button, outside-press where the underlying dialog allows
// it) is blocked while the caller's operation is pending, so the dialog stays open until it
// settles. The primitives' onConfirm/onSubmit is fire-and-forget and the caller owns the async
// lifecycle — a dismissal racing a late-settling operation would let its result act as if
// confirmed, with no dialog left to show for it.
//
// A blocked change must ALSO cancel the Base UI event (`details.cancel()`): the dialog store flips
// its own open state after the onOpenChange callback unless the event is canceled, so swallowing
// the callback alone would still animate the popup closed despite the controlled `open` prop.
export function pendingGuardedOpenChange(
	pending: boolean,
	onChange: (next: boolean) => void
): (next: boolean, details: { cancel: () => void }) => void {
	return (next, details) => {
		if (!next && pending) {
			details.cancel()
			return
		}

		onChange(next)
	}
}
