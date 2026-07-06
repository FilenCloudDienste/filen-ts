// Shared dismissal gate for the dialog primitives in this directory: a `false` open-change (any
// dismissal route — Escape, the X close button, outside-press where the underlying dialog allows
// it) is blocked while the caller's operation is pending, so the dialog stays open until it
// settles. The primitives' onConfirm/onSubmit is fire-and-forget and the caller owns the async
// lifecycle — a dismissal racing a late-settling operation would let its result act as if
// confirmed, with no dialog left to show for it. The two-factor dialog handles the same hazard
// with caller-side generation guarding; the primitives block dismissal instead, as the generic
// default that keeps every consumer correct without extra wiring.
//
// A blocked change must ALSO cancel the Base UI event (`details.cancel()`): the dialog store flips
// its own open state after the onOpenChange callback unless the event is canceled, so swallowing
// the callback alone would still animate the popup closed despite the controlled `open` prop.
export function shouldForwardOpenChange(next: boolean, pending: boolean): boolean {
	return next || !pending
}
