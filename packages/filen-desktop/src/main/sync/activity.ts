import type { DesktopSyncActivity } from "@filen/shared/desktop"
import type { NativeActivity } from "../../shared/nativeProtocol.ts"

// The latest entries kept per pair; this run only, never on disk.
export const ACTIVITY_PER_PAIR = 200

export interface ActivityLog {
	// Numbers and keeps the entries; returns them numbered.
	append(entries: readonly NativeActivity[]): DesktopSyncActivity[]
	// Newest first.
	list(pairId: string, limit: number): DesktopSyncActivity[]
	drop(pairId: string): void
	clear(): void
}

export function createActivityLog(perPair = ACTIVITY_PER_PAIR): ActivityLog {
	const pairs = new Map<string, DesktopSyncActivity[]>()
	let seq = 0

	return {
		append: entries =>
			entries.map(entry => {
				const numbered: DesktopSyncActivity = { ...entry, seq: seq++ }
				let ring = pairs.get(entry.pairId)

				if (ring === undefined) {
					ring = []
					pairs.set(entry.pairId, ring)
				}

				ring.push(numbered)

				if (ring.length > perPair) {
					ring.shift()
				}

				return numbered
			}),
		list: (pairId, limit) => (pairs.get(pairId) ?? []).slice(-limit).reverse(),
		drop: pairId => {
			pairs.delete(pairId)
		},
		clear: () => {
			pairs.clear()
		}
	}
}
