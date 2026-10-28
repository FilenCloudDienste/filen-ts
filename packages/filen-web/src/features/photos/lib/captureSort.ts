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

// Lists each sorted by sortPhotosByCaptureDesc, merged into that same order in one pass over a handful of heads. A
// photo listed twice (it sorts next to itself) is kept once.
export function mergePhotosByCaptureDesc(lists: readonly (readonly PhotoItem[])[]): PhotoItem[] {
	const positions = lists.map(() => 0)
	// Each list's head's capture time, computed once per head.
	const keys = lists.map(list => (list[0] === undefined ? 0 : captureTimestamp(list[0])))
	const out: PhotoItem[] = []

	for (;;) {
		let best = -1
		let bestItem: PhotoItem | undefined
		let bestKey = 0

		for (let index = 0; index < lists.length; index++) {
			const item = lists[index]?.[positions[index] ?? 0]
			const key = keys[index] ?? 0

			if (
				item !== undefined &&
				(bestItem === undefined || key > bestKey || (key === bestKey && item.data.uuid < bestItem.data.uuid))
			) {
				best = index
				bestItem = item
				bestKey = key
			}
		}

		if (bestItem === undefined) {
			return out
		}

		const next = (positions[best] ?? 0) + 1
		const following = lists[best]?.[next]

		positions[best] = next
		keys[best] = following === undefined ? 0 : captureTimestamp(following)

		if (out.at(-1)?.data.uuid !== bestItem.data.uuid) {
			out.push(bestItem)
		}
	}
}
