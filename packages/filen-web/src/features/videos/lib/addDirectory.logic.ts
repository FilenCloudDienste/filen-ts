import { withLibraryRoot, withoutLibraryRoot, type LibraryConfigDoc, type Stamp } from "@filen/shared/videos"
import { ROOT_ENTRIES_LARGE } from "@/features/videos/lib/library.logic"
import { rootPickVerdict, type RootPickValidation } from "@/lib/rootChooser.logic"

// The "Add a directory" flow: the steps from a pick to the saved root (overlap → replace offer, a very large
// directory → memory warning, then the save). Which chooser rows can be picked: rootChooser.logic.ts.

export type AddDirectoryStep =
	| { kind: "browse" }
	// The pick is being validated.
	| { kind: "checking" }
	// Validated (replacing `replace`); its size is being read.
	| { kind: "sizing"; uuid: string; replace: string[] }
	// Overlaps these library directories: adding replaces them, once confirmed.
	| { kind: "replace"; uuid: string; replace: string[] }
	| { kind: "large"; uuid: string; replace: string[]; entries: number }
	| { kind: "blocked"; reason: "alreadyRoot" | "systemDirectory" | "notFound" | "notOwnDrive" }
	| { kind: "saving" }

// After the pick was validated (see rootPickVerdict); a clear pick is sized next.
export function stepAfterValidation({
	uuid,
	validation,
	replacing
}: {
	uuid: string
	validation: RootPickValidation
	replacing: readonly string[]
}): AddDirectoryStep {
	const verdict = rootPickVerdict({ uuid, validation, replacing })

	switch (verdict.kind) {
		case "clear":
			return {
				kind: "sizing",
				uuid,
				replace: verdict.replace
			}
		case "replace":
			return {
				kind: "replace",
				uuid,
				replace: verdict.replace
			}
		case "blocked":
			return verdict
	}
}

// After the pick's size is known (files and directories below it, or null when it couldn't be read).
export function stepAfterSize({
	uuid,
	replace,
	entries
}: {
	uuid: string
	replace: readonly string[]
	entries: number | null
}): AddDirectoryStep {
	return entries !== null && entries >= ROOT_ENTRIES_LARGE
		? {
				kind: "large",
				uuid,
				replace: [...replace],
				entries
			}
		: {
				kind: "saving"
			}
}

// The configuration edit adding `uuid` as a library directory in place of `replace`.
export function addRootEdit({
	uuid,
	replace,
	now
}: {
	uuid: string
	replace: readonly string[]
	now: number
}): (doc: LibraryConfigDoc, stamp: Stamp) => LibraryConfigDoc {
	return (doc, stamp) => {
		let next = doc

		for (const dirUuid of replace) {
			if (dirUuid !== uuid) {
				next = withoutLibraryRoot({
					doc: next,
					dirUuid,
					stamp,
					at: now
				})
			}
		}

		return withLibraryRoot({
			doc: next,
			dirUuid: uuid,
			stamp,
			now
		})
	}
}
