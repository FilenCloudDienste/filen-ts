import { estimateCaptureTimestamp } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"

// Every item a photos listing ever holds is the "file" arm (isPhotoItem's own precondition — a
// directory or an undecryptable row never survives the predicate), so this module works against that
// narrower arm directly rather than DriveItem's full six-member union.
export type PhotoItem = Extract<DriveItem, { type: "file" }>

// See @filen/shared's estimateCaptureTimestamp for the floor/ceiling/min-of-candidates rationale.
export function captureTimestamp(item: PhotoItem): number {
	return estimateCaptureTimestamp(Number(item.data.timestamp), item.data.decryptedMeta?.created, item.data.decryptedMeta?.modified)
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
