// Formats a millisecond position/duration as a media clock: `m:ss`, or `h:mm:ss` past an hour. A
// non-finite or negative input renders as `0:00` so a not-yet-known duration never shows "NaN:NaN".
// Pure and framework-free, shared by the player bar's elapsed/total readout.
export function formatTime(ms: number): string {
	const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
	const seconds = totalSeconds % 60
	const minutes = Math.floor(totalSeconds / 60) % 60
	const hours = Math.floor(totalSeconds / 3600)
	const paddedSeconds = seconds.toString().padStart(2, "0")

	if (hours > 0) {
		return `${hours.toString()}:${minutes.toString().padStart(2, "0")}:${paddedSeconds}`
	}

	return `${minutes.toString()}:${paddedSeconds}`
}
