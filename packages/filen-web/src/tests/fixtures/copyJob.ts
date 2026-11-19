import type { ItemCounts } from "@filen/sdk-rs"
import type { CopyReportDTO, CopyUpdateDTO } from "@/lib/sdk/jobErrors"

export function counts(overrides: Partial<ItemCounts> = {}): ItemCounts {
	return {
		dirsCreated: 0n,
		dirsFailed: 0n,
		filesDone: 0n,
		filesFailed: 0n,
		bytesDone: 0n,
		bytesFailed: 0n,
		dirsNotAttempted: 0n,
		filesNotAttempted: 0n,
		bytesNotAttempted: 0n,
		entriesSkipped: 0n,
		bytesSkipped: 0n,
		...overrides
	}
}

// A copy job's progress update and final report over one set of totals: an update mid-copy with nothing
// counted yet, a report with everything done. Each suite names its own totals.
export function copyJobFixtures(totals: CopyUpdateDTO["totals"]): {
	copyUpdate: (overrides?: Partial<CopyUpdateDTO>) => CopyUpdateDTO
	copyReport: (overrides?: Partial<CopyReportDTO>) => CopyReportDTO
} {
	return {
		copyUpdate: (overrides = {}) => ({
			phase: "copyingFiles",
			runState: "running",
			scan: { sourcesDone: 1n, sourcesTotal: 1n, listingBytes: 0n, listingTotalBytes: undefined },
			totals,
			counts: counts(),
			active: [],
			events: [],
			bytesPerSecond: undefined,
			etaMs: undefined,
			activeTimeMs: 0n,
			...overrides
		}),
		copyReport: (overrides = {}) => ({
			topLevel: [],
			failures: [],
			skipped: [],
			renamed: [],
			totals,
			counts: counts({ filesDone: totals.files, bytesDone: totals.bytes, dirsCreated: totals.dirs }),
			error: undefined,
			...overrides
		})
	}
}
