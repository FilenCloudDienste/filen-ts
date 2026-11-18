// The Files of a `transfers.upload` call the page uploads itself, as indexes into its Files. `localSkipped`: Files
// without a path (never sent); `mainSkipped`: main's skipped indexes into the sent paths, mapped through `indexes` (the
// File index of each path). `asDirectory` sent one path standing for every File: any skip skips them all.
export function skippedFileIndexes(
	fileCount: number,
	indexes: readonly number[],
	localSkipped: readonly number[],
	mainSkipped: readonly number[],
	asDirectory: boolean
): number[] {
	if (asDirectory) {
		return mainSkipped.length > 0 ? Array.from({ length: fileCount }, (_value, index) => index) : []
	}

	return [...localSkipped, ...mainSkipped.flatMap(index => indexes[index] ?? [])].sort((a, b) => a - b)
}
