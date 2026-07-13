import type { DriveItem } from "@/features/drive/lib/item"

// Every item a photos listing ever holds is the "file" arm (isPhotoItem's own precondition — a
// directory or an undecryptable row never survives the predicate), so this module works against that
// narrower arm directly rather than DriveItem's full six-member union.
export type PhotoItem = Extract<DriveItem, { type: "file" }>

// Client-written timestamps below this (1980-01-01 UTC) are treated as garbage — epoch-zero mtimes
// and similar artifacts of legacy uploaders — rather than as very old capture dates. Ported verbatim
// from filen-mobile's lib/sort.ts (same constant, same rationale): the repo-wide "lastModified is
// untrusted" rule made concrete for a capture-date estimate.
export const CAPTURE_TIMESTAMP_FLOOR = Date.UTC(1980, 0, 1)

// Best-effort capture time (ms), mobile-exact (lib/sort.ts's own captureTimestamp): legacy clients
// stamped `created` with the upload time instead of the file's real creation date, stranding old
// photos at their upload position while the real date survived in `modified`. A photo cannot be
// modified before it was captured, so the earliest plausible client timestamp — above the garbage
// floor and no later than the server-assigned upload time (`timestamp`, the only fully trusted stamp)
// — is the closest available estimate. Falls back to the upload time when neither client timestamp is
// usable.
export function captureTimestamp(item: PhotoItem): number {
	const uploaded = Number(item.data.timestamp)
	let best = Number.POSITIVE_INFINITY

	for (const candidate of [item.data.decryptedMeta?.created, item.data.decryptedMeta?.modified]) {
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

// Descending by capture timestamp, ties broken by uuid (deterministic across refetches — the input's
// own order is raw query data, not stable). No numeric-uuid parts-cache dance like drive's own
// sort.ts: a photos listing is a single flat capture-sorted pass, not a multi-mode, hot resort-on-
// every-click surface, so a plain per-comparison uuid string compare is the right amount of
// engineering here.
export function sortPhotosByCaptureDesc(items: PhotoItem[]): PhotoItem[] {
	return items
		.map(item => ({ item, key: captureTimestamp(item) }))
		.sort((a, b) => {
			if (a.key !== b.key) {
				return b.key - a.key
			}

			return a.item.data.uuid < b.item.data.uuid ? -1 : a.item.data.uuid > b.item.data.uuid ? 1 : 0
		})
		.map(({ item }) => item)
}
