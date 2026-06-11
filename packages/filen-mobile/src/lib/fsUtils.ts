import * as FileSystem from "expo-file-system"
import {
	OFFLINE_FILES_DIRECTORY,
	OFFLINE_DIRECTORIES_DIRECTORY,
	FILE_CACHE_PARENT_DIRECTORY,
	AUDIO_CACHE_PARENT_DIRECTORY,
	THUMBNAILS_DIRECTORY
} from "@/lib/storageRoots"

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
	return [
		OFFLINE_FILES_DIRECTORY,
		OFFLINE_DIRECTORIES_DIRECTORY,
		FILE_CACHE_PARENT_DIRECTORY,
		AUDIO_CACHE_PARENT_DIRECTORY,
		THUMBNAILS_DIRECTORY,
		new FileSystem.Directory(FileSystem.Paths.join(FileSystem.Paths.document, "Downloads"))
	]
}

// Best-effort sweep: per-entry failures are swallowed so an unreadable orphan
// doesn't block the others. Safe to call only when no transfers can be in
// flight — the Settings → Advanced "Clean up temporary files" action that
// invokes this (alongside sweepTmpDir()) gates on the transfers/sync stores.
// NOTE: walks the entire offline store; measured ~1.9s with a heavily
// offline-marked drive — never put this back on the boot path.
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
