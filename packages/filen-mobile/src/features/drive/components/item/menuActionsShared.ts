import { confirmedAction } from "@/lib/confirmedAction"
import type { DriveItem } from "@/types"

// Shared shape for confirmed destructive drive actions (trash / delete / remove
// offline / remove share / stop sharing / disable link): prompt → guard cancel →
// runWithLoading(action) → guard failure → optionally pop back when we just purged
// a file we may be previewing. Returns the onPress handler. Mirrors notes'
// `confirmedNoteAction`.
export function confirmedDriveAction({
	item,
	promptTitle,
	promptMessage,
	promptOkText,
	promptDestructive = true,
	action,
	dismissOnSuccess
}: {
	item: DriveItem
	promptTitle: string
	promptMessage: string
	promptOkText: string
	// The plain `trash` action is the one site that omits destructive styling on the
	// alert itself — default true preserves the destructive look everywhere else.
	promptDestructive?: boolean
	// Return value is awaited then discarded (matches the original `await drive.X(...)`).
	action: () => Promise<unknown>
	// When true and the purged item is a file we can navigate away from, pop back
	// (closes a file preview / detail route sitting on top).
	dismissOnSuccess: boolean
}): () => Promise<void> {
	return confirmedAction({
		promptTitle,
		promptMessage,
		promptOkText,
		promptDestructive,
		action,
		dismiss: dismissOnSuccess ? () => item.type === "file" : undefined
	})
}
