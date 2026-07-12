import type { FileVersion } from "@filen/sdk-rs"
import type { FileItem } from "@/features/drive/lib/actions"

// A version's OWN uuid becomes the file's live uuid the moment it's the active content — restoring
// an older version rotates the file onto THAT version's uuid (see actions.ts's restoreVersion) — so
// matching against the file's CURRENT uuid is what "current" means among a file's version history.
export function isCurrentVersion(version: FileVersion, file: FileItem): boolean {
	return version.uuid === file.data.uuid
}

// The SDK's version list always includes the file's own LIVE version alongside any history (that's
// exactly why isCurrentVersion exists) — so the raw list length is never 0, even for a file with no
// prior versions. "No previous versions" instead means every entry present IS the current one.
export function hasNoPreviousVersions(versions: FileVersion[], file: FileItem): boolean {
	return versions.every(version => isCurrentVersion(version, file))
}

// Every version EXCEPT the live one — the only set the multi-select bulk actions (delete selected /
// delete all) ever operate on: the live version's uuid IS the file's current content (see
// isCurrentVersion), so it can never be a bulk-delete candidate any more than a per-row one.
export function nonCurrentVersions(versions: FileVersion[], file: FileItem): FileVersion[] {
	return versions.filter(version => !isCurrentVersion(version, file))
}

// Select-all/deselect-all toggle target for the versions panel's own multi-select — mirrors
// selectAllToggle-style helpers elsewhere (bulk-select is "all selected" only when every non-current
// version's uuid is present in the selection, never merely "some").
export function isEverySelected(selected: ReadonlySet<string>, versions: FileVersion[], file: FileItem): boolean {
	const candidates = nonCurrentVersions(versions, file)

	return candidates.length > 0 && candidates.every(version => selected.has(version.uuid))
}
