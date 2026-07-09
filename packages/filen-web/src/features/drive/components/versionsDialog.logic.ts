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
