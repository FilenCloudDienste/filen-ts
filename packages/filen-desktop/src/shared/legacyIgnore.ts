// What the 3.x client's rules kept out of a pair that the new engine's rules for a migrated user may not: dot files
// and directories when the pair excluded them (the root `.filenignore` excepted, which the new rules read and sync).
// The old local trash the engine reserves itself; the old always-on temp-file patterns are deliberately not carried
// over and not checked.
export function oldWouldIgnore(relPath: string, options: { excludeDotFiles: boolean }): boolean {
	// A segment starts with a dot.
	return options.excludeDotFiles && relPath !== ".filenignore" && (relPath.startsWith(".") || relPath.includes("/."))
}
