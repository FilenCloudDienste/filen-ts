import * as FileSystem from "expo-file-system"

export function listLocalDirectoryRecursive(directory: FileSystem.Directory): (FileSystem.File | FileSystem.Directory)[] {
	const visited = new Set<string>()
	const allEntries: (FileSystem.File | FileSystem.Directory)[] = []

	function traverse(dir: FileSystem.Directory) {
		if (visited.has(dir.uri)) {
			return
		}

		visited.add(dir.uri)

		try {
			const entries = dir.list()

			for (const entry of entries) {
				allEntries.push(entry)

				if (entry instanceof FileSystem.Directory) {
					traverse(entry)
				}
			}
		} catch {
			return
		}
	}

	traverse(directory)

	return allEntries
}
