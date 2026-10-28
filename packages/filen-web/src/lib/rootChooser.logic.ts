import type { RootValidation } from "@filen/shared"

// The root chooser of a feature with several root directories (Videos, Photos): which rows can be picked, and what
// a validated pick leads to (overlap → replace offer).

export interface ChooserRoot {
	uuid: string
	name: string
}

// Filen's own directory at the drive root never shows in the chooser.
export function isHiddenChooserRow({ name, atDriveRoot, systemName }: { name: string; atDriveRoot: boolean; systemName: string }): boolean {
	return atDriveRoot && name.toLowerCase() === systemName
}

// A row that already is a root can't be picked again.
export function isRootRow(uuid: string, roots: readonly ChooserRoot[]): boolean {
	return roots.some(root => root.uuid === uuid)
}

// What the chooser says about the open directory before it is added: it is a root already, or sits inside one
// (adding it is then offered as a replacement).
export type ChooserPickHint = { kind: "none" } | { kind: "alreadyRoot" } | { kind: "insideRoot"; root: ChooserRoot }

export function chooserPickHint({ pathStack, roots }: { pathStack: readonly string[]; roots: readonly ChooserRoot[] }): ChooserPickHint {
	const current = pathStack.at(-1)

	if (current !== undefined && isRootRow(current, roots)) {
		return {
			kind: "alreadyRoot"
		}
	}

	for (let index = pathStack.length - 2; index >= 0; index--) {
		const root = roots.find(candidate => candidate.uuid === pathStack[index])

		if (root !== undefined) {
			return {
				kind: "insideRoot",
				root
			}
		}
	}

	return {
		kind: "none"
	}
}

export type RootPickValidation = RootValidation | { ok: false; reason: "notFound" }

export type RootPickVerdict =
	// Can be added, in place of `replace`.
	| { kind: "clear"; replace: string[] }
	// Overlaps these roots: adding replaces them, once confirmed.
	| { kind: "replace"; replace: string[] }
	| { kind: "blocked"; reason: "alreadyRoot" | "systemDirectory" | "notFound" | "notOwnDrive" }

function union(a: readonly string[], b: readonly string[]): string[] {
	return [...new Set([...a, ...b])]
}

// What a validated pick leads to. `replacing` names roots the pick replaces regardless (the chooser was opened to
// swap one); a validation that finds only those overlapping still counts as clear.
export function rootPickVerdict({
	uuid,
	validation,
	replacing
}: {
	uuid: string
	validation: RootPickValidation
	replacing: readonly string[]
}): RootPickVerdict {
	const clear: RootPickVerdict = {
		kind: "clear",
		replace: [...replacing]
	}

	if (validation.ok) {
		return clear
	}

	if (validation.reason !== "nested") {
		return validation.reason === "alreadyRoot" && replacing.includes(uuid)
			? clear
			: {
					kind: "blocked",
					reason: validation.reason
				}
	}

	const others = validation.replace.filter(root => !replacing.includes(root))

	return others.length === 0
		? clear
		: {
				kind: "replace",
				replace: union(replacing, validation.replace)
			}
}
