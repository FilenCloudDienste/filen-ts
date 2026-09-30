// Elapsed/total media-player readout: unpadded leading unit, zero-padded trailing units,
// `h:mm:ss` once past an hour. A non-finite or non-positive input renders as "0:00" so a
// not-yet-known duration never shows "NaN:NaN".
export function formatSecondsToMediaClock(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return "0:00"
	}

	const totalSeconds = Math.floor(seconds)
	const secs = totalSeconds % 60
	const minutes = Math.floor(totalSeconds / 60) % 60
	const hours = Math.floor(totalSeconds / 3600)
	const paddedSeconds = secs.toString().padStart(2, "0")

	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, "0")}:${paddedSeconds}`
	}

	return `${minutes}:${paddedSeconds}`
}
