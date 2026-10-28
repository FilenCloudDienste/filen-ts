import { rootPickVerdict, type RootPickValidation, type RootPickVerdict } from "@/lib/rootChooser.logic"

// What "Choose this directory" picks: the directory open in the picker, or at the top the whole drive,
// chosen by its root uuid — null until the account that names the root is loaded, so confirm stays
// disabled rather than saving an empty root.
export function photosChooserChoice(targetUuid: string | null, driveRootUuid: string | undefined): string | null {
	if (targetUuid !== null) {
		return targetUuid
	}

	return driveRootUuid !== undefined && driveRootUuid.length > 0 ? driveRootUuid : null
}

// What a validated pick leads to in Photos: the Videos chooser's verdicts, except that a directory inside a photos
// directory is refused rather than offered as its replacement (its photos already show).
export function photosPickVerdict(uuid: string, validation: RootPickValidation): RootPickVerdict | { kind: "inside"; root: string } {
	const [root] = !validation.ok && validation.reason === "nested" ? (validation.within ?? []) : []

	return root === undefined ? rootPickVerdict({ uuid, validation, replacing: [] }) : { kind: "inside", root }
}
