import { confirmedAction } from "@/lib/confirmedAction"
import type { DriveItem } from "@/types"
import { isFileItem } from "@/features/drive/driveSelectors"

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
	// When true and the purged item is a previewable file, pop back (closes the
	// file preview / detail route sitting on top). Call sites set this from their
	// preview context — see `isPreview` in createMenuButtons.
	dismissOnSuccess: boolean
}): () => Promise<void> {
	return confirmedAction({
		promptTitle,
		promptMessage,
		promptOkText,
		promptDestructive,
		action,
		// Only files are previewed (a directory tap navigates into it), so the dismiss
		// targets any previewable file type — including the shared* variants opened from
		// the sharedIn/sharedOut/links galleries (the old `type === "file"` check missed those).
		dismiss: dismissOnSuccess ? () => isFileItem(item) : undefined
	})
}
