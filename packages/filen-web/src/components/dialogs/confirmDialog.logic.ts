export type ConfirmInitialFocus = "confirm" | "cancel"

// Which button a confirm prompt opens with focused. A non-destructive confirm (trash, restore,
// archive — all reversible) keeps the confirm button focused: Enter is the fast path and the worst
// case is undoable. A destructive one focuses Cancel instead, so a blind Enter (a stray keypress, a
// held key, a Delete-key bulk action landing on a freshly-opened prompt) can never fire an
// irreversible action. Platform convention, and the friction tier a phrase-typed confirm would
// over-serve — see typedConfirmDialog.tsx for where THAT tier starts.
export function confirmInitialFocus(destructive: boolean): ConfirmInitialFocus {
	return destructive ? "cancel" : "confirm"
}
