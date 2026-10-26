// What the 3.x client's rules kept out of a pair that the new engine's rules for a migrated user may not: dot files
// and directories when the pair excluded them (the root `.filenignore` excepted, which the new rules read and sync),
// and the old local trash. Its always-on temp-file patterns are deliberately not carried over and not checked.
export function oldWouldIgnore(relPath: string, options: { excludeDotFiles: boolean }): boolean {
	if (relPath === ".filenignore") {
		return false
	}

	for (const segment of relPath.split("/")) {
		if (segment === ".filen.trash.local" || (options.excludeDotFiles && segment.startsWith("."))) {
			return true
		}
	}

	return false
}
