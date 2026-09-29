export function isTimestampSameMinute(timestamp1: number, timestamp2: number): boolean {
	const diff = Math.abs(timestamp1 - timestamp2)

	if (diff > 120000) {
		return false
	}

	const date1 = new Date(timestamp1)
	const date2 = new Date(timestamp2)

	if (
		date1.getFullYear() !== date2.getFullYear() ||
		date1.getMonth() !== date2.getMonth() ||
		date1.getDate() !== date2.getDate() ||
		date1.getHours() !== date2.getHours()
	) {
		return false
	}

	const minuteDiff = Math.abs(date1.getMinutes() - date2.getMinutes())

	return minuteDiff <= 2
}

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
