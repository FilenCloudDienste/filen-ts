// `.filen` and the subdirectories resolved this session (lib/dotFilenDirectory.ts), kept past the resolver's memo,
// which any directory change clears: only what a resolve already learned, for guarding `.filen` and hiding its
// contents. Best effort: one not resolved yet is simply not known. No imports, so any list can read it.

let dotFilenUuid: string | null = null
const dirUuids = new Set<string>()

export function noteKnownDotFilenDirs(dotFilen: string, subdirectory: string): void {
	dotFilenUuid = dotFilen
	dirUuids.add(dotFilen)
	dirUuids.add(subdirectory)
}

export function forgetKnownDotFilenDirs(): void {
	dotFilenUuid = null
	dirUuids.clear()
}

export function getKnownDotFilenUuid(): string | null {
	return dotFilenUuid
}

// Whether `uuid` is `.filen` or one of its subdirectories, as far as this session resolved them.
export function isKnownDotFilenDir(uuid: string): boolean {
	return dirUuids.has(uuid)
}
