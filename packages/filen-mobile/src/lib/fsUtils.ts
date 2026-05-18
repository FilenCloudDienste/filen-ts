import * as FileSystem from "expo-file-system"

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
