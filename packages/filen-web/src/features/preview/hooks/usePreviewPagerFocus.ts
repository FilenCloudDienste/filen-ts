import { useEffect, type FocusEvent as ReactFocusEvent, type RefObject } from "react"

// The preview overlay's (PreviewOverlay) popup keeps keyboard focus while its pager steps: a step that disables the
// pager button pressed (either end) would otherwise strand focus on <body>, outside the dialog and its keys.
// Returns the popup's blur handler.
export function usePreviewPagerFocus(
	popupRef: RefObject<HTMLDivElement | null>,
	index: number
): (event: ReactFocusEvent<HTMLDivElement>) => void {
	// A step can disable the very pager button that triggered it (index lands on the first/last item,
	// see the overlay's Prev/Next buttons' own `disabled`) — the browser blurs a disabled focused control
	// straight to `<body>` with no app-level recovery, which strands keyboard/AT focus OUTSIDE the
	// dialog's own DOM subtree (body is an ancestor of the portaled popup, not a descendant, so no
	// handler scoped to the popup — including the overlay's handleKeyDown — ever sees another keypress there).
	// Live-verified (page.evaluate(() => document.activeElement) read "BODY" right after such a step).
	// Pulls focus back onto the popup container itself whenever that's happened; a no-op otherwise
	// (focus already on something valid inside the dialog, e.g. the other, still-enabled pager button).
	useEffect(() => {
		if (popupRef.current && !popupRef.current.contains(document.activeElement)) {
			popupRef.current.focus()
		}
	}, [index, popupRef])

	// Base UI's focus trap does not cover focus lost because the focused control DISABLED ITSELF: paging
	// to either end disables the very pager button that was just clicked, and the browser then drops
	// focus on the floor (document.body) rather than moving it anywhere. Because Base UI stops composite
	// keys from reaching the document (see the overlay's handleKeyDown), the popup's own handler is the ONLY
	// route to the pager — so once focus lands outside, arrow paging is silently dead until the user
	// clicks back in. Pull it back to the popup, which is focusable (tabIndex -1).
	//
	// Deliberately narrow: only when focus actually fell to <body>. A Base UI menu/dialog opened from the
	// preview header portals OUTSIDE this popup's subtree and legitimately takes focus with it — that
	// lands on a real element, never body, so this never fights it.
	function handlePopupBlur(event: ReactFocusEvent<HTMLDivElement>): void {
		if (event.relatedTarget !== null) {
			return
		}

		// focusout runs BEFORE the browser settles the new focus target; read it a microtask later.
		queueMicrotask(() => {
			const popup = popupRef.current

			if (popup !== null && popup.isConnected && document.activeElement === document.body) {
				popup.focus()
			}
		})
	}

	return handlePopupBlur
}
