import * as FileSystem from "expo-file-system"
import { Platform } from "react-native"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"

// Storage version numbers — kept in sync with the per-module `VERSION` exports.
// Hardcoded here (instead of imported) to avoid a circular load chain that drags
// each module's transitive deps (expo-image via thumbnails, etc.) into every
// test file that touches fsUtils. Bump in both places if a module's VERSION moves.
const OFFLINE_VERSION = 1 // src/lib/offline.ts:83
const FILE_CACHE_VERSION = 1 // src/lib/fileCache.ts:33
const AUDIO_CACHE_VERSION = 1 // src/lib/audioCache.ts:26
const THUMBNAILS_VERSION = 2 // src/lib/thumbnails.ts:37

// Calls `visit` for every File and Directory under `directory`, recursively.
// Visits each entry exactly once even if the tree contains symlink-style cycles.
// Subtree read failures are swallowed — best-effort traversal.
// Return "skip" from `visit` for a Directory to avoid descending into it.
export function walkLocalDirectory(
	directory: FileSystem.Directory,
	visit: (entry: FileSystem.File | FileSystem.Directory) => "skip" | void
): void {
	const visited = new Set<string>()

	function traverse(dir: FileSystem.Directory): void {
		if (visited.has(dir.uri)) {
			return
		}

		visited.add(dir.uri)

		try {
			for (const entry of dir.list()) {
				const result = visit(entry)

				if (result === "skip") {
					continue
				}

				if (entry instanceof FileSystem.Directory) {
					traverse(entry)
				}
			}
		} catch {
			return
		}
	}

	traverse(directory)
}

// Sums every File.size under `directory` recursively. O(stack depth) memory;
// does not materialize an intermediate array. Use this in size() hot paths.
export function sumLocalDirectoryFileBytes(directory: FileSystem.Directory): number {
	let total = 0

	walkLocalDirectory(directory, entry => {
		if (entry instanceof FileSystem.File) {
			total += entry.size ?? 0
		}
	})

	return total
}

// Returns a flat array of every entry. Use when the caller needs random access
// to the array (e.g., `Promise.all(entries.map(...))`). For pure aggregation,
// prefer `walkLocalDirectory` / `sumLocalDirectoryFileBytes`.
export function listLocalDirectoryRecursive(directory: FileSystem.Directory): (FileSystem.File | FileSystem.Directory)[] {
	const entries: (FileSystem.File | FileSystem.Directory)[] = []

	walkLocalDirectory(directory, entry => {
		entries.push(entry)
	})

	return entries
}

// The Rust SDK writes `<target>.filendl` next to the target during downloads,
// then atomically renames on success. If the process is killed mid-download,
// the .filendl partial is left behind. sweepStrayDownloadFiles() removes these
// orphans across every known download-destination root.
export const STRAY_DOWNLOAD_EXTENSION = ".filendl"

function strayDownloadRoots(): FileSystem.Directory[] {
	const base = Platform.select({
		ios: FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER] ?? FileSystem.Paths.document,
		default: FileSystem.Paths.document
	})

	return [
		new FileSystem.Directory(FileSystem.Paths.join(base, "offline", `v${OFFLINE_VERSION}`, "files")),
		new FileSystem.Directory(FileSystem.Paths.join(base, "offline", `v${OFFLINE_VERSION}`, "directories")),
		new FileSystem.Directory(FileSystem.Paths.join(base, "fileCache", `v${FILE_CACHE_VERSION}`)),
		new FileSystem.Directory(FileSystem.Paths.join(base, "audioCache", `v${AUDIO_CACHE_VERSION}`)),
		new FileSystem.Directory(FileSystem.Paths.join(base, "thumbnails", `v${THUMBNAILS_VERSION}`)),
		new FileSystem.Directory(FileSystem.Paths.join(FileSystem.Paths.document, "Downloads"))
	]
}

// Best-effort sweep: per-entry failures are swallowed so an unreadable orphan
// doesn't block the others. Safe to call only when no transfers can be in
// flight (i.e., once at app start, alongside sweepTmpDir()).
export function sweepStrayDownloadFiles(): void {
	for (const root of strayDownloadRoots()) {
		if (!root.exists) {
			continue
		}

		walkLocalDirectory(root, entry => {
			if (!(entry instanceof FileSystem.File)) {
				return
			}

			if (!entry.name.endsWith(STRAY_DOWNLOAD_EXTENSION)) {
				return
			}

			try {
				entry.delete()
			} catch {
				// best-effort
			}
		})
	}
}
