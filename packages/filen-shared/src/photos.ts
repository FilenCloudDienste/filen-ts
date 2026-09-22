// Client-written timestamps below this (1980-01-01 UTC) are treated as garbage — epoch-zero
// mtimes and similar artifacts of legacy uploaders — rather than as very old capture dates.
export const CAPTURE_TIMESTAMP_FLOOR = Date.UTC(1980, 0, 1)

// Best-effort capture time (ms) for a photo. Legacy clients stamped `created` with the upload
// time instead of the file's real creation date, stranding old photos at their upload position
// while the real date survived in `modified`. A photo cannot be modified before it was captured,
// so the earliest plausible client timestamp — above the garbage floor and no later than the
// server-assigned upload time (the only fully trusted stamp) — is the closest available estimate.
// Falls back to the upload time when neither client timestamp is usable.
export function estimateCaptureTimestamp(uploaded: number, created?: number | bigint, modified?: number | bigint): number {
	let best = Number.POSITIVE_INFINITY

	for (const candidate of [created, modified]) {
		if (candidate === undefined) {
			continue
		}

		const value = Number(candidate)

		if (value > CAPTURE_TIMESTAMP_FLOOR && value <= uploaded && value < best) {
			best = value
		}
	}

	return best === Number.POSITIVE_INFINITY ? uploaded : best
}
