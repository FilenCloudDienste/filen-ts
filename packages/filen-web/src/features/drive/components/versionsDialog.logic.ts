import type { FileVersion } from "@filen/sdk-rs"
import type { FileItem } from "@/features/drive/lib/actions"

// A version's OWN uuid becomes the file's live uuid the moment it's the active content — restoring
// an older version rotates the file onto THAT version's uuid (see actions.ts's restoreVersion) — so
// matching against the file's CURRENT uuid is what "current" means among a file's version history.
export function isCurrentVersion(version: FileVersion, file: FileItem): boolean {
	return version.uuid === file.data.uuid
}

// Every version EXCEPT the live one — the only set the multi-select bulk actions (delete selected /
// delete all) ever operate on: the live version's uuid IS the file's current content (see
// isCurrentVersion), so it can never be a bulk-delete candidate any more than a per-row one. The SDK's
// list always includes the live version, so an empty result is what "no previous versions" means.
export function nonCurrentVersions(versions: FileVersion[], file: FileItem): FileVersion[] {
	return versions.filter(version => !isCurrentVersion(version, file))
}
