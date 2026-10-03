import { describe, expect, it } from "vitest"
import {
	EMPTY_CAPPED_LIST,
	applyCompressUpdate,
	classifyCompressEvents,
	compressHasIssues,
	createCompressJob,
	isCompressPreflightRefusal,
	rewindCompressEvents,
	settleCompressJob,
	type CompressCountsInput,
	type CompressEventInput,
	type CompressJob,
	type CompressReportInput,
	type CompressSettlement,
	type CompressUpdateInput
} from "@filen/shared"

interface TestError {
	kind?: string
	label: string
}

type Job = CompressJob<string, TestError>
type Report = CompressReportInput<string, TestError>

function rejected(error: TestError): CompressSettlement<string, TestError> {
	return { error }
}

const DESTINATION = { uuid: "dest", name: "Documents" }

function job(overrides: Partial<Job> = {}): Job {
	return {
		...createCompressJob<string, TestError>("c", {
			destination: DESTINATION,
			name: "Archive.zip",
			itemCount: 2,
			dispose: null,
			encrypted: false
		}),
		...overrides
	}
}

function counts(overrides: Partial<CompressCountsInput> = {}): CompressCountsInput {
	return {
		filesDone: 0n,
		entriesSkipped: 0n,
		bytesSkipped: 0n,
		bytesRead: 0n,
		bytesWritten: 0n,
		archiveBytes: 0n,
		bytesVerified: 0n,
		...overrides
	}
}

function update(overrides: Partial<CompressUpdateInput<TestError>> = {}): CompressUpdateInput<TestError> {
	return {
		phase: "compressing",
		runState: "running",
		scan: { sourcesDone: 2n, sourcesTotal: 2n },
		totals: { dirs: 1n, files: 4n, bytes: 400n },
		counts: counts(),
		active: [],
		bytesPerSecond: undefined,
		etaMs: undefined,
		events: classifyCompressEvents<TestError>([]),
		...overrides
	}
}

function report(overrides: Partial<Report> = {}): Report {
	return {
		archive: "archive-file",
		skipped: [],
		renamed: [],
		totals: { dirs: 1n, files: 4n, bytes: 400n },
		counts: counts({ filesDone: 4n, bytesRead: 400n, bytesWritten: 300n, archiveBytes: 300n }),
		neededBytes: undefined,
		dispositions: [],
		hashMismatches: [],
		omittedHashMismatches: 0n,
		error: undefined,
		...overrides
	}
}

const SKIPPED_EVENT: CompressEventInput<TestError> = {
	type: "skipped",
	sourcePath: "a/broken.bin",
	bytes: 12n,
	reason: { type: "undecryptableFile", uuid: "u1" }
}

describe("createCompressJob", () => {
	it("starts scanning with empty lists", () => {
		const created = job()

		expect(created).toMatchObject({ id: "c", kind: "compress", name: "Archive.zip", itemCount: 2, phase: "scanning", archive: null })
		expect(created.skipped).toBe(EMPTY_CAPPED_LIST)
		expect(created.outcome).toEqual({ status: "running" })
	})
})

describe("classifyCompressEvents", () => {
	it("sorts the events into lists, narrowing their bigints", () => {
		const events = classifyCompressEvents<TestError>([
			SKIPPED_EVENT,
			{ type: "skipped", sourcePath: "gone", bytes: 0n, reason: { type: "unreachable", count: 3n } },
			{ type: "renamed", sourceUuid: "r", sourcePath: "a/b", name: "b (1)", reason: "duplicateName" },
			{ type: "sourceHashMismatch", sourceUuid: "h", path: "a/h" },
			{ type: "sourceDisposition", uuid: "s", outcome: { type: "disposed", how: "trash", bytesFreed: 9n } },
			{ type: "propagationFailed", destUuid: "p", error: { label: "x" } }
		])

		expect(events.skipped).toEqual([
			{ sourcePath: "a/broken.bin", bytes: 12, reason: { type: "undecryptableFile", uuid: "u1" } },
			{ sourcePath: "gone", bytes: 0, reason: { type: "unreachable", count: 3 } }
		])
		expect(events.renamed.map(entry => entry.name)).toEqual(["b (1)"])
		expect(events.hashMismatches.map(entry => entry.path)).toEqual(["a/h"])
		expect(events.dispositions).toEqual([{ uuid: "s", outcome: { type: "disposed", how: "trash", bytesFreed: 9 } }])
		expect(events.propagationFailed).toBe(1)
	})

	it("is one shared value for an update with nothing in it", () => {
		expect(classifyCompressEvents([])).toBe(classifyCompressEvents([]))
	})

	it("carries what the delivery left out", () => {
		expect(classifyCompressEvents([], { skipped: 4, renamed: 0, hashMismatches: 1 }).omitted).toEqual({
			skipped: 4,
			renamed: 0,
			hashMismatches: 1
		})
	})
})

describe("applyCompressUpdate", () => {
	it("narrows the SDK's state to numbers and run flags", () => {
		const next = applyCompressUpdate(
			job(),
			update({
				runState: "pausing",
				counts: counts({ filesDone: 1n, bytesRead: 100n }),
				active: [{ sourceUuid: "s", name: "x", path: "a/x", size: 50n, bytesDone: 10n }],
				bytesPerSecond: 1_000n,
				etaMs: 3_000n
			})
		)

		expect(next).toMatchObject({ phase: "compressing", pausing: true, paused: false, cancelling: false })
		expect(next.scan).toEqual({ sourcesDone: 2, sourcesTotal: 2 })
		expect(next.totals).toEqual({ dirs: 1, files: 4, bytes: 400 })
		expect(next.counts.bytesRead).toBe(100)
		expect(next.active).toEqual([{ sourceUuid: "s", name: "x", path: "a/x", size: 50, bytesDone: 10 }])
		expect(next.bytesPerSecond).toBe(1_000)
		expect(next.etaMs).toBe(3_000)
	})

	it("keeps the lists, active files and dispositions when an update adds nothing", () => {
		const first = applyCompressUpdate(job(), update({ events: classifyCompressEvents([SKIPPED_EVENT]) }))
		const second = applyCompressUpdate(first, update())

		expect(second.skipped).toBe(first.skipped)
		expect(second.renamed).toBe(first.renamed)
		expect(second.hashMismatches).toBe(first.hashMismatches)
		expect(second.dispositions).toBe(first.dispositions)
		expect(second.active).toBe(first.active)
	})

	it("appends events and the delivery's omissions across updates", () => {
		let next = applyCompressUpdate(job(), update({ events: classifyCompressEvents([SKIPPED_EVENT]) }))

		next = applyCompressUpdate(
			next,
			update({
				events: classifyCompressEvents<TestError>(
					[
						SKIPPED_EVENT,
						{ type: "sourceDisposition", uuid: "s", outcome: { type: "kept", reason: { type: "changed" }, bytesFreed: 0n } },
						{ type: "propagationFailed", destUuid: "p", error: { label: "x" } }
					],
					{ skipped: 5, renamed: 0, hashMismatches: 0 }
				)
			})
		)

		expect(next.skipped.items).toHaveLength(2)
		expect(next.skipped.omitted).toBe(5)
		expect(next.dispositions).toHaveLength(1)
		expect(next.propagationFailedCount).toBe(1)
	})

	it("keeps an app's own fields", () => {
		expect(applyCompressUpdate({ ...job(), glyph: "file" as const }, update()).glyph).toBe("file")
	})
})

describe("rewindCompressEvents", () => {
	it("takes the lists and tallies back to an earlier state, keeping the rest", () => {
		const before = job()
		const after = applyCompressUpdate(
			before,
			update({
				phase: "finishing",
				events: classifyCompressEvents<TestError>([
					SKIPPED_EVENT,
					{ type: "renamed", sourceUuid: "r", sourcePath: "a/r", name: "r (1)", reason: "duplicateName" },
					{ type: "sourceHashMismatch", sourceUuid: "h", path: "a/h" },
					{ type: "sourceDisposition", uuid: "s", outcome: { type: "kept", reason: { type: "interrupted" }, bytesFreed: 0n } },
					{ type: "propagationFailed", destUuid: "p", error: { label: "x" } }
				])
			})
		)
		const rewound = rewindCompressEvents({ ...after, glyph: "file" as const }, before)

		expect(rewound).toMatchObject({
			skipped: before.skipped,
			renamed: before.renamed,
			hashMismatches: before.hashMismatches,
			dispositions: before.dispositions,
			propagationFailedCount: 0,
			phase: "finishing",
			glyph: "file"
		})
	})
})

describe("isCompressPreflightRefusal", () => {
	it("is a refusal of a bare tar stating what it needed, with no archive", () => {
		expect(
			isCompressPreflightRefusal(report({ archive: undefined, neededBytes: 500n, error: { kind: "MaxStorageReached", label: "" } }))
		).toBe(true)
	})

	it("is not a refusal part way through, nor one with an archive", () => {
		expect(isCompressPreflightRefusal(report({ archive: undefined, error: { kind: "MaxStorageReached", label: "" } }))).toBe(false)
		expect(isCompressPreflightRefusal(report({ neededBytes: 500n, error: { kind: "MaxStorageReached", label: "" } }))).toBe(false)
		expect(isCompressPreflightRefusal(report({ archive: undefined, neededBytes: 500n, error: { kind: "Server", label: "" } }))).toBe(
			false
		)
	})
})

describe("compressHasIssues", () => {
	it("is false for a clean job", () => {
		expect(compressHasIssues(job())).toBe(false)
	})

	it("is any skipped entry, hash mismatch, kept original, propagation failure or end error", () => {
		expect(compressHasIssues(job({ skipped: { items: [], omitted: 1 } }))).toBe(true)
		expect(compressHasIssues(job({ hashMismatches: { items: [{ sourceUuid: "h", path: "h" }], omitted: 0 } }))).toBe(true)
		expect(
			compressHasIssues(
				job({ dispositions: [{ uuid: "s", outcome: { type: "kept", reason: { type: "interrupted" }, bytesFreed: 0 } }] })
			)
		).toBe(true)
		expect(compressHasIssues(job({ dispositions: [{ uuid: "s", outcome: { type: "disposed", how: "trash", bytesFreed: 0 } }] }))).toBe(
			false
		)
		expect(compressHasIssues(job({ propagationFailedCount: 1 }))).toBe(true)
		expect(compressHasIssues(job({ endError: { label: "x" } }))).toBe(true)
	})

	it("does not count renames", () => {
		expect(compressHasIssues(job({ renamed: { items: [], omitted: 3 } }))).toBe(false)
	})
})

describe("settleCompressJob", () => {
	it("is done when the report has no error, its figures replacing the updates'", () => {
		const running = applyCompressUpdate(job(), update({ events: classifyCompressEvents([SKIPPED_EVENT]) }))
		const settled = settleCompressJob(running, { report: report(), maxBytes: undefined })

		expect(settled.outcome).toEqual({ status: "done" })
		expect(settled.archive).toBe("archive-file")
		expect(settled.skipped).toBe(EMPTY_CAPPED_LIST)
		expect(settled.counts.archiveBytes).toBe(300)
		expect(settled.active).toEqual([])
	})

	it("is done with issues when the report lists some", () => {
		const settled = settleCompressJob(job(), {
			report: report({ hashMismatches: [{ sourceUuid: "h", path: "a/h" }], omittedHashMismatches: 4n }),
			maxBytes: undefined
		})

		expect(settled.outcome).toEqual({ status: "doneWithIssues" })
		expect(settled.hashMismatches.omitted).toBe(4)
	})

	it("keeps the archive and the originals when cancelled after the archive was registered", () => {
		const settled = settleCompressJob(job({ dispose: "trash", cancelRequest: "keep" }), {
			report: report({
				error: { kind: "Cancelled", label: "" },
				dispositions: [{ uuid: "s", outcome: { type: "kept", reason: { type: "interrupted" }, bytesFreed: 0n } }]
			}),
			maxBytes: undefined
		})

		expect(settled.outcome).toEqual({ status: "doneWithIssues" })
		expect(settled.stoppedAfterArchive).toBe(true)
		expect(settled.endError).toBeNull()
	})

	it("notes the archive was kept when a stop reached the job only after the archive was registered", () => {
		const settled = settleCompressJob(job({ cancelRequest: "keep" }), { report: report(), maxBytes: undefined })

		expect(settled.outcome).toEqual({ status: "done" })
		expect(settled.stoppedAfterArchive).toBe(true)
		expect(settleCompressJob(job(), { report: report(), maxBytes: undefined }).stoppedAfterArchive).toBe(false)
		expect(
			settleCompressJob(job({ cancelRequest: "keep" }), { report: report({ archive: undefined }), maxBytes: undefined })
				.stoppedAfterArchive
		).toBe(false)
	})

	it("is cancelled when cancelled before the archive existed", () => {
		const settled = settleCompressJob(job(), {
			report: report({ archive: undefined, error: { kind: "Cancelled", label: "" } }),
			maxBytes: undefined
		})

		expect(settled.outcome).toEqual({ status: "cancelled" })
		expect(settled.stoppedAfterArchive).toBe(false)
	})

	it("is over quota with what a bare tar needed", () => {
		const settled = settleCompressJob(job(), {
			report: report({ archive: undefined, neededBytes: 900n, error: { kind: "MaxStorageReached", label: "" } }),
			maxBytes: 100
		})

		expect(settled.outcome).toEqual({ status: "quotaExceeded", neededBytes: 900, freeBytes: 100 })
		expect(settled.neededBytes).toBe(900)
	})

	it("is over quota without a figure when refused part way through", () => {
		const settled = settleCompressJob(job(), {
			report: report({ archive: undefined, error: { kind: "MaxStorageReached", label: "" } }),
			maxBytes: 100
		})

		expect(settled.outcome).toEqual({ status: "quotaExceeded", neededBytes: null, freeBytes: 100 })
	})

	it("is failed on a storage refusal when the free storage was unknown", () => {
		const error = { kind: "MaxStorageReached", label: "" }

		expect(settleCompressJob(job(), { report: report({ archive: undefined, error }), maxBytes: undefined }).outcome).toEqual({
			status: "failed",
			error
		})
	})

	it("is failed on a password error", () => {
		for (const kind of ["ArchivePasswordRequired", "ArchiveWrongPassword"]) {
			const error = { kind, label: "" }

			expect(settleCompressJob(job(), { report: report({ archive: undefined, error }), maxBytes: undefined }).outcome).toEqual({
				status: "failed",
				error
			})
		}
	})

	it("is done with issues, keeping the error, when the archive exists", () => {
		const error = { kind: "Server", label: "verify failed" }
		const settled = settleCompressJob(job(), { report: report({ error }), maxBytes: undefined })

		expect(settled.outcome).toEqual({ status: "doneWithIssues" })
		expect(settled.endError).toBe(error)
	})

	it("is failed on another error without an archive", () => {
		const error = { kind: "Server", label: "" }

		expect(settleCompressJob(job(), { report: report({ archive: undefined, error }), maxBytes: undefined }).outcome).toEqual({
			status: "failed",
			error
		})
	})

	it("keeps an archive the callback announced when the report lacks it", () => {
		const settled = settleCompressJob(job({ archive: "announced" }), { report: report({ archive: undefined }), maxBytes: undefined })

		expect(settled.archive).toBe("announced")
		expect(settled.outcome).toEqual({ status: "done" })
	})

	it("caps an oversized skipped list", () => {
		const skipped = Array.from({ length: 1_003 }, () => ({
			sourcePath: "x",
			bytes: 1n,
			reason: { type: "unreachable" as const, count: 1n }
		}))
		const settled = settleCompressJob(job(), { report: report({ skipped }), maxBytes: undefined })

		expect(settled.skipped.items).toHaveLength(1_000)
		expect(settled.skipped.omitted).toBe(3)
	})

	it("caps an oversized renamed list, counting what it cut", () => {
		const renamed = Array.from({ length: 1_004 }, () => ({
			sourceUuid: "r",
			sourcePath: "a/b",
			name: "b (1)",
			reason: "duplicateName" as const
		}))
		const settled = settleCompressJob(job(), { report: report({ renamed }), maxBytes: undefined })

		expect(settled.renamed.items).toHaveLength(1_000)
		expect(settled.renamed.omitted).toBe(4)
	})

	describe("a rejected call", () => {
		it("ends done after the archive was announced, the stop having come after it", () => {
			const settled = settleCompressJob(
				job({ archive: "announced", cancelRequest: "keep" }),
				rejected({ kind: "Internal", label: "" })
			)

			expect(settled.outcome).toEqual({ status: "done" })
			expect(settled.stoppedAfterArchive).toBe(true)
		})

		it("ends with issues when the originals' outcomes did not all arrive", () => {
			const disposed = { uuid: "a", outcome: { type: "disposed", how: "trash", bytesFreed: 0 } } as const
			const missing = settleCompressJob(
				job({ archive: "announced", cancelRequest: "keep", dispose: "trash", dispositions: [disposed] }),
				rejected({ kind: "Internal", label: "" })
			)
			const complete = settleCompressJob(
				job({
					archive: "announced",
					cancelRequest: "keep",
					dispose: "trash",
					dispositions: [disposed, { ...disposed, uuid: "b" }]
				}),
				rejected({ kind: "Internal", label: "" })
			)

			expect(missing.outcome).toEqual({ status: "doneWithIssues" })
			expect(missing.stoppedAfterArchive).toBe(true)
			expect(complete.outcome).toEqual({ status: "done" })
		})

		it("is cancelled when cancelled or a stop was requested", () => {
			expect(settleCompressJob(job(), rejected({ kind: "Cancelled", label: "" })).outcome).toEqual({ status: "cancelled" })
			expect(settleCompressJob(job({ cancelRequest: "keep" }), rejected({ kind: "Internal", label: "" })).outcome).toEqual({
				status: "cancelled"
			})
		})

		it("is failed otherwise", () => {
			const error: TestError = { kind: "InvalidName", label: "" }

			expect(settleCompressJob(job({ paused: true }), rejected(error))).toMatchObject({
				paused: false,
				outcome: { status: "failed", error }
			})
		})
	})
})
