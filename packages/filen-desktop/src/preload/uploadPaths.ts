// The local paths of Files the page hands to `transfers.upload`. `pathOf` is webUtils.getPathForFile, which answers ""
// for a File without one (built in the page) and throws for anything that is not a File.

function safePathOf<F>(file: F, pathOf: (file: F) => string): string {
	try {
		return pathOf(file)
	} catch {
		return ""
	}
}

// `indexes`: the File index of each path; `skipped`: the indexes of Files without a path.
export function uploadPaths<F>(
	files: readonly F[],
	pathOf: (file: F) => string
): { paths: string[]; indexes: number[]; skipped: number[] } {
	const paths: string[] = []
	const indexes: number[] = []
	const skipped: number[] = []

	files.forEach((file, index) => {
		const local = safePathOf(file, pathOf)

		if (local.length === 0) {
			skipped.push(index)
		} else {
			paths.push(local)
			indexes.push(index)
		}
	})

	return { paths, indexes, skipped }
}

// The picked directory of a webkitdirectory input: each File's path less its relative path below that directory
// ("/x/dir/a/b.txt" with "dir/a/b.txt" → "/x/dir"); null when Files disagree, a path is missing, or no Files.
export function directoryRootOf<F extends { readonly webkitRelativePath: string }>(
	files: readonly F[],
	pathOf: (file: F) => string
): string | null {
	let root: string | null = null

	for (const file of files) {
		const local = safePathOf(file, pathOf)
		const relative = file.webkitRelativePath
		const below = relative.indexOf("/")

		if (local.length === 0 || below <= 0 || below === relative.length - 1) {
			return null
		}

		// Windows paths use backslashes; webkitRelativePath always uses slashes.
		if (!["/", "\\"].some(separator => local.endsWith(`${separator}${relative.replaceAll("/", separator)}`))) {
			return null
		}

		const fileRoot = local.slice(0, local.length - relative.length + below)

		if (root !== null && root !== fileRoot) {
			return null
		}

		root = fileRoot
	}

	return root
}
