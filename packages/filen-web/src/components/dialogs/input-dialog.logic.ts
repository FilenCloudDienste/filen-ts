import { shouldResetOnOpen } from "@/components/dialogs/typed-confirm-dialog.logic"

// Pure value-on-open resolver, split out of the component file for the same react-refresh reason as
// typed-confirm-dialog.logic.ts. Mirrors TypedConfirmDialog's own reset-during-render pattern (a
// closed→open transition only, via the shared shouldResetOnOpen predicate) except the seed is the
// caller's initialValue (rename's pre-filled name) rather than always blank — a caller with no
// initialValue passes "" and gets the original always-blank behavior back. Returns null when no
// reseed is due, so the "adjusting state during render" call site stays a plain `if`.
export function seededValueOnOpen(open: boolean, wasOpen: boolean, initialValue: string): string | null {
	return shouldResetOnOpen(open, wasOpen) ? initialValue : null
}
