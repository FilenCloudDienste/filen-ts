import { describe, expect, it } from "vitest"
import {
	compressJobPercent,
	compressJobRowFigures,
	createCompressJob,
	createExtractJob,
	extractJobPercent,
	extractJobRowFigures,
	type CompressJob,
	type ExtractJob,
	type ExtractProgressBasis,
	type SourceDisposalKind
} from "@filen/shared"

type Compress = CompressJob<unknown, unknown>
type Extract = ExtractJob<unknown, unknown, unknown>

function compress(overrides: Partial<Compress> = {}, dispose: SourceDisposalKind | null = null): Compress {
	return {
		...createCompressJob("c", { destination: { uuid: null, name: "Drive" }, name: "a.zip", itemCount: 1, dispose, encrypted: false }),
		phase: "compressing",
		totals: { dirs: 0, files: 4, bytes: 1_000 },
		...overrides
	}
}

function compressCounts(job: Compress, overrides: Partial<Compress["counts"]>): Compress["counts"] {
	return { ...job.counts, ...overrides }
}

function extract(basis: ExtractProgressBasis, overrides: Partial<Extract> = {}): Extract {
	return {
		...createExtractJob("e", {
			destination: { uuid: null, name: "Drive" },
			archiveUuid: "arc",
			archiveName: "a.zip",
			rowName: "a",
			root: "newFolder",
			partial: false,
			retry: false,
			dispose: null,
			basis
		}),
		phase: "extracting",
		archiveBytes: 2_000,
		...overrides
	}
}

function extractCounts(overrides: Partial<Extract["counts"]>): Extract["counts"] {
	return { ...extract({ type: "unknown" }).counts, ...overrides }
}

describe("compressJobPercent", () => {
	it("is indeterminate while listing the sources or waiting for the slot", () => {
		expect(compressJobPercent(compress({ phase: "scanning" }))).toBeNull()
		expect(compressJobPercent(compress({ phase: "waitingForWorker" }))).toBeNull()
	})

	it("is the share of the sources read", () => {
		const job = compress()

		expect(compressJobPercent({ ...job, counts: compressCounts(job, { bytesRead: 250 }) })).toBe(25)
	})

	it("falls back to files when every file is empty", () => {
		const job = compress({ totals: { dirs: 0, files: 4, bytes: 0 } })

		expect(compressJobPercent({ ...job, counts: compressCounts(job, { filesDone: 1 }) })).toBe(25)
		expect(compressJobPercent(compress({ totals: { dirs: 3, files: 0, bytes: 0 } }))).toBeNull()
	})

	it("reads at most 99 while running", () => {
		const job = compress({ phase: "disposingSources" })

		expect(compressJobPercent(job)).toBe(99)
		expect(compressJobPercent({ ...compress(), counts: compressCounts(compress(), { bytesRead: 1_000 }) })).toBe(99)
	})

	it("is 100 once done", () => {
		expect(compressJobPercent(compress({ outcome: { status: "done" } }))).toBe(100)
	})

	// Deleting the originals for good reads the archive back: reading and verifying are half each.
	it("weighs the check only when the originals are deleted for good, and only moves forward", () => {
		const deleting = compress({}, "deletePermanently")
		const halfRead = compressJobPercent({ ...deleting, counts: compressCounts(deleting, { bytesRead: 500 }) })
		const allRead = compressJobPercent({ ...deleting, counts: compressCounts(deleting, { bytesRead: 1_000 }) })
		const finishing = compressJobPercent({ ...deleting, phase: "finishing", counts: compressCounts(deleting, { bytesRead: 900 }) })
		const verifyStart = compressJobPercent({ ...deleting, phase: "verifying", counts: compressCounts(deleting, { archiveBytes: 800 }) })
		const verifyHalf = compressJobPercent({
			...deleting,
			phase: "verifying",
			counts: compressCounts(deleting, { archiveBytes: 800, bytesVerified: 400 })
		})

		expect(halfRead).toBe(25)
		expect(allRead).toBe(50)
		expect(finishing).toBe(50)
		expect(verifyStart).toBe(50)
		expect(verifyHalf).toBe(75)

		const trashing = compress({ phase: "compressing" }, "trash")

		expect(compressJobPercent({ ...trashing, counts: compressCounts(trashing, { bytesRead: 500 }) })).toBe(50)
	})

	it("is 0 for a settled job with nothing to measure", () => {
		expect(compressJobPercent(compress({ totals: { dirs: 1, files: 0, bytes: 0 }, outcome: { status: "cancelled" } }))).toBe(0)
	})
})

describe("compressJobRowFigures", () => {
	it("shows the share of the work in the sources' bytes, at most 99% while running", () => {
		const job = compress({}, "deletePermanently")

		expect(compressJobRowFigures({ ...job, counts: compressCounts(job, { bytesRead: 500 }) })).toEqual({ size: 1_000, shown: 250 })
		expect(
			compressJobRowFigures({
				...job,
				phase: "disposingSources",
				counts: compressCounts(job, { archiveBytes: 10, bytesVerified: 10 })
			})
		).toEqual({
			size: 1_000,
			shown: 990
		})
	})

	it("is the whole size once done", () => {
		expect(compressJobRowFigures(compress({ outcome: { status: "done" } }))).toEqual({ size: 1_000, shown: 1_000 })
	})

	it("shows nothing while listing", () => {
		expect(compressJobRowFigures(compress({ phase: "scanning", totals: { dirs: 0, files: 0, bytes: 0 } }))).toEqual({
			size: 0,
			shown: 0
		})
	})
})

describe("extractJobPercent", () => {
	it("is indeterminate while waiting for the slot or reading the index", () => {
		expect(extractJobPercent(extract({ type: "archiveRead" }, { phase: "waitingForWorker" }))).toBeNull()
		expect(extractJobPercent(extract({ type: "archiveRead" }, { phase: "scanning" }))).toBeNull()
	})

	it("measures the archive read", () => {
		expect(extractJobPercent(extract({ type: "archiveRead" }, { bytesRead: 500 }))).toBe(25)
		expect(extractJobPercent(extract({ type: "archiveRead" }, { bytesRead: 2_000 }))).toBe(99)
		expect(extractJobPercent(extract({ type: "archiveRead" }, { archiveBytes: 0 }))).toBeNull()
	})

	it("measures a listing's plan, failed bytes included, or its files when it planned no bytes", () => {
		expect(
			extractJobPercent(
				extract({ type: "planned", bytes: 400, files: 2 }, { counts: extractCounts({ bytesDone: 100, bytesFailed: 100 }) })
			)
		).toBe(50)
		expect(extractJobPercent(extract({ type: "planned", bytes: 0, files: 4 }, { counts: extractCounts({ filesDone: 1 }) }))).toBe(25)
		expect(extractJobPercent(extract({ type: "planned", bytes: 0, files: 0 }))).toBeNull()
	})

	it("is indeterminate without a basis", () => {
		expect(extractJobPercent(extract({ type: "unknown" }, { bytesRead: 1_000 }))).toBeNull()
		expect(extractJobPercent(extract({ type: "unknown" }, { outcome: { status: "cancelled" } }))).toBeNull()
	})

	it("is 100 once done, whatever the basis", () => {
		expect(extractJobPercent(extract({ type: "unknown" }, { outcome: { status: "done" } }))).toBe(100)
	})
})

describe("extractJobRowFigures", () => {
	it("is the archive read for a read basis, at most 99% while running", () => {
		expect(extractJobRowFigures(extract({ type: "archiveRead" }, { bytesRead: 500 }))).toEqual({ size: 2_000, shown: 500 })
		expect(extractJobRowFigures(extract({ type: "archiveRead" }, { bytesRead: 2_000 }))).toEqual({ size: 2_000, shown: 1_980 })
	})

	it("is the bytes extracted against a listing's plan", () => {
		expect(
			extractJobRowFigures(extract({ type: "planned", bytes: 400, files: 2 }, { counts: extractCounts({ bytesDone: 100 }) }))
		).toEqual({
			size: 400,
			shown: 100
		})
	})

	it("has no size without a basis", () => {
		expect(extractJobRowFigures(extract({ type: "unknown" }, { counts: extractCounts({ bytesDone: 70 }) }))).toEqual({
			size: 0,
			shown: 70
		})
	})

	it("is the whole size once done", () => {
		expect(extractJobRowFigures(extract({ type: "archiveRead" }, { outcome: { status: "done" } }))).toEqual({
			size: 2_000,
			shown: 2_000
		})
	})

	it("is not capped once settled otherwise", () => {
		expect(extractJobRowFigures(extract({ type: "archiveRead" }, { bytesRead: 2_000, outcome: { status: "cancelled" } }))).toEqual({
			size: 2_000,
			shown: 2_000
		})
	})
})
