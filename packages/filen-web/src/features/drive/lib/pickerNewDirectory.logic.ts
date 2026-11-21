import type { EntryNameErrorKindJS } from "@filen/sdk-rs"
import { driveItemName, nameCollisionKey } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"

// The name row a directory picker inserts over its listing. `parentUuid` is the directory it was opened in;
// the row only shows while that directory is open.
export interface PickerNewDirectoryDraft {
	parentUuid: string | null
	name: string
	pending: boolean
	error: PickerNewDirectoryError | null
}

export type PickerNewDirectoryError =
	{ kind: "empty" } | { kind: "taken" } | { kind: "name"; reason: EntryNameErrorKindJS } | { kind: "failed"; message: string }

// What the listing already held can answer: a blank name, or one an item there already has (names are unique per
// directory case-insensitively). Null: the SDK is asked next.
export function localDraftError(name: string, listing: readonly DriveItem[]): PickerNewDirectoryError | null {
	const trimmed = name.trim()

	if (trimmed.length === 0) {
		return { kind: "empty" }
	}

	const wanted = nameCollisionKey(trimmed)

	return listing.some(item => nameCollisionKey(driveItemName(item)) === wanted) ? { kind: "taken" } : null
}

// Esc, or leaving the row with nothing typed, drops it; a pending create keeps it.
export function cancelsOnBlur(draft: PickerNewDirectoryDraft): boolean {
	return !draft.pending && draft.name.trim().length === 0
}
