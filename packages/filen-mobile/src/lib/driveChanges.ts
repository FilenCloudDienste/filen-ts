// When this session last saw the user's drive content change: a local write or a drive socket event.
// Caches derived from drive content that no socket keeps current compare their read time against it.
let lastChangeAt = 0

export function noteDriveContentChanged(): void {
	lastChangeAt = Date.now()
}

// Inclusive: a change in the same millisecond as the read counts as after it.
export function driveContentChangedSince(time: number): boolean {
	return lastChangeAt >= time
}
