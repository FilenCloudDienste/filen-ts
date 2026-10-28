import { nameCollisionKey } from "./driveItem"
import { VIDEOS_DIR_NAME } from "./videos/libraryConfig"

// The app's own directory at the drive root: settings Filen syncs across devices live in its subdirectories.
export const DOT_FILEN_DIR_NAME = ".filen"

// Every subdirectory of `.filen`, by its canonical name. The one list every client names them from, so the
// apps can never drift apart again. Lowercase: lookups go by the server's case-insensitive name hash anyway.
export const DOT_FILEN_SUBDIRS = {
	videos: VIDEOS_DIR_NAME,
	office: "office",
	playlists: "playlists",
	chatUploads: "chat-uploads",
	photos: "photos"
} as const

export type DotFilenSubdirName = (typeof DOT_FILEN_SUBDIRS)[keyof typeof DOT_FILEN_SUBDIRS]

// Names older clients created a subdirectory under that a case-insensitive lookup of the canonical one misses.
// Older clients keep creating these: a legacy one standing beside the canonical one is left alone.
const LEGACY_SUBDIR_NAMES: Readonly<Partial<Record<string, readonly string[]>>> = {
	[DOT_FILEN_SUBDIRS.chatUploads]: ["Chat Uploads"]
}

// The names a subdirectory is looked up under, in order: the canonical one first, then any legacy one.
export function dotFilenSubdirLookupNames(name: string): readonly string[] {
	const legacy = LEGACY_SUBDIR_NAMES[name]

	return legacy === undefined ? [name] : [name, ...legacy]
}

// Whether a directory named `actual` is the subdirectory `name` resolves to, under any name it is looked up under.
export function isDotFilenSubdirName(actual: string, name: string): boolean {
	const key = nameCollisionKey(actual)

	return dotFilenSubdirLookupNames(name).some(candidate => nameCollisionKey(candidate) === key)
}

// The name a resolved subdirectory named `actual` is renamed to, once, or null when it already carries it.
export function dotFilenSubdirRename(actual: string, name: string): string | null {
	return actual !== name && isDotFilenSubdirName(actual, name) ? name : null
}

export function isDotFilenName(name: string): boolean {
	return nameCollisionKey(name) === DOT_FILEN_DIR_NAME
}

// The `.filen` directly under the drive root; never one nested elsewhere, nor anything inside it. `parentUuid` is
// the directory's own parent (null for anything that isn't an own directory); an unknown root matches nothing.
export function isRootDotFilen({ name, parentUuid, rootUuid }: { name: string; parentUuid: string | null; rootUuid: string | null }): boolean {
	return rootUuid !== null && rootUuid.length > 0 && parentUuid === rootUuid && isDotFilenName(name)
}

// Whether a search hit lies inside the root `.filen`, from its ancestry relative to a search rooted at the drive
// root ("/"-joined, empty for a direct child).
export function isDotFilenSearchPath(parentPath: string): boolean {
	const slash = parentPath.indexOf("/")

	return isDotFilenName(slash === -1 ? parentPath : parentPath.slice(0, slash))
}
