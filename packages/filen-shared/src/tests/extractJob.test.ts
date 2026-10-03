import { describe, expect, it } from "vitest"
import {
	EMPTY_CAPPED_LIST,
	applyExtractUpdate,
	classifyExtractEvents,
	createExtractJob,
	extractHasIssues,
	groupExtractRetries,
	isExtractPreflightRefusal,
	mergeExtractReports,
	rewindExtractEvents,
	settleExtractJob,
	type CopyCountsInput,
	type ExtractEventInput,
	type ExtractFailure,
	type ExtractFailureInput,
	type ExtractJob,
	type ExtractProgressBasis,
	type ExtractReportInput,
	type ExtractSettlement,
	type ExtractSkippedInput,
	type ExtractUpdateInput
} from "@filen/shared"

interface TestError {
	kind?: string
	label: string
}

interface Dir {
	uuid: string
}

type Job = ExtractJob<string, Dir, TestError>
type Report = ExtractReportInput<Dir, TestError>

function rejected(error: TestError): ExtractSettlement<Dir, TestError> {
	return { error }
}

const DESTINATION = { uuid: "dest", name: "Documents" }

function job(overrides: Partial<Job> = {}, basis: ExtractProgressBasis = { type: "archiveRead" }): Job {
	return {
		...createExtractJob<string, Dir, TestError>("e", {
			destination: DESTINATION,
			archiveUuid: "arc",
			archiveName: "photos.zip",
			rowName: "photos",
			root: "newFolder",
			partial: false,
			retry: false,
			dispose: null,
			basis
		}),
		...overrides
	}
}

function counts(overrides: Partial<CopyCountsInput> = {}): CopyCountsInput {
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

function update(overrides: Partial<ExtractUpdateInput<Dir, TestError>> = {}): ExtractUpdateInput<Dir, TestError> {
	return {
		phase: "extracting",
		runState: "running",
		archiveBytes: 1_000n,
		counts: counts(),
		bytesRead: 0n,
		active: [],
		bytesPerSecond: undefined,
		etaMs: undefined,
		events: classifyExtractEvents<Dir, TestError>([]),
		...overrides
	}
}

function report(overrides: Partial<Report> = {}): Report {
	return {
		topLevelCount: 1,
		failures: [],
		skipped: [],
		renamed: [],
		misleadingNames: [],
		omitted: { skipped: 0n, renamed: 0n, misleadingNames: 0n, failures: 0n, topLevel: 0n },
		archiveBytes: 1_000n,
		counts: counts({ dirsCreated: 1n, filesDone: 3n, bytesDone: 900n }),
		unaccountedBytes: 0n,
		duplicates: undefined,
		dispositions: [],
		error: undefined,
		...overrides
	}
}

function failureInput(index: number, retry: { destination: string; base: string } | undefined): ExtractFailureInput<Dir, TestError> {
	return {
		entry: { archive: "arc", index },
		path: `p${index}`,
		destParent: "parent",
		destName: `n${index}`,
		stage: { type: "upload" },
		retry: retry === undefined ? undefined : { ...retry, destinationDir: { uuid: retry.destination } },
		error: { label: `e${index}` }
	}
}

function failure(index: number, retry: { destination: string; base: string } | null): ExtractFailure<Dir, TestError> {
	return {
		...failureInput(index, retry ?? undefined),
		retry: retry === null ? null : { ...retry, destinationDir: { uuid: retry.destination } }
	}
}

const SKIPPED_EVENT_INPUT: ExtractSkippedInput = {
	entry: { archive: "arc", index: 9 },
	path: "__MACOSX/._a",
	pathTruncated: false,
	bytes: 4n,
	reason: { type: "macMetadata" }
}

const SKIPPED_EVENT: ExtractEventInput<Dir, TestError> = { type: "skipped", ...SKIPPED_EVENT_INPUT }

describe("createExtractJob", () => {
	it("starts waiting for the slot with empty lists", () => {
		const created = job()

		expect(created).toMatchObject({ id: "e", kind: "extract", phase: "waitingForWorker", archiveName: "photos.zip", root: "newFolder" })
		expect(created.failures).toBe(EMPTY_CAPPED_LIST)
		expect(created.outcome).toEqual({ status: "running" })
	})
})

describe("classifyExtractEvents", () => {
	it("sorts the events, counting files saved as versions apart from failures", () => {
		const events = classifyExtractEvents<Dir, TestError>([
			{ type: "fileFailed", ...failureInput(1, { destination: "d", base: "" }) },
			{ type: "dirFailed", ...failureInput(2, undefined) },
			{ type: "fileFailed", ...failureInput(3, undefined), stage: { type: "registeredAsVersion", existingFile: "old" } },
			SKIPPED_EVENT,
			{ type: "renamed", entry: { archive: "arc", index: 4 }, path: "a/b", name: "b (1)", reason: "duplicateName" },
			{ type: "misleadingName", entry: { archive: "arc", index: 5 }, path: "invoice‮fdp.exe" },
			{ type: "topLevelTrashed", destUuid: "t1" },
			{ type: "sourceDisposition", uuid: "arc", outcome: { type: "disposed", how: "trash", bytesFreed: 1_000n } },
			{ type: "propagationFailed", destUuid: "p", error: { label: "x" } }
		])

		expect(events.failures.map(entry => entry.path)).toEqual(["p1", "p2"])
		expect(events.failures[0]?.retry).toEqual({ destination: "d", base: "", destinationDir: { uuid: "d" } })
		expect(events.failures[1]?.retry).toBeNull()
		expect(events.savedAsVersion).toBe(1)
		expect(events.macMetadataSkipped).toBe(1)
		expect(events.skipped).toEqual([
			{ entry: { archive: "arc", index: 9 }, path: "__MACOSX/._a", pathTruncated: false, bytes: 4, reason: { type: "macMetadata" } }
		])
		expect(events.renamed.map(entry => entry.name)).toEqual(["b (1)"])
		expect(events.misleadingNames.map(entry => entry.path)).toEqual(["invoice‮fdp.exe"])
		expect(events.topLevelTrashed).toEqual(["t1"])
		expect(events.dispositions).toEqual([{ uuid: "arc", outcome: { type: "disposed", how: "trash", bytesFreed: 1_000 } }])
		expect(events.propagationFailed).toBe(1)
	})

	it("is one shared value for an update with nothing in it", () => {
		expect(classifyExtractEvents([])).toBe(classifyExtractEvents([]))
	})

	it("carries what the delivery left out", () => {
		const omitted = { failures: 1, skipped: 2_000, renamed: 0, misleadingNames: 0, savedAsVersion: 0, macMetadata: 1_500 }
		const events = classifyExtractEvents([SKIPPED_EVENT], omitted)

		expect(events.omitted).toBe(omitted)
		expect(events.macMetadataSkipped).toBe(1_501)
	})

	it("counts left-out files saved as versions apart from the left-out failures", () => {
		const events = classifyExtractEvents<Dir, TestError>(
			[{ type: "fileFailed", ...failureInput(1, undefined), stage: { type: "registeredAsVersion", existingFile: "old" } }],
			{ failures: 10, skipped: 0, renamed: 0, misleadingNames: 0, savedAsVersion: 4, macMetadata: 0 }
		)

		expect(events.savedAsVersion).toBe(5)
		expect(events.omitted).toEqual({ failures: 6, skipped: 0, renamed: 0, misleadingNames: 0 })
	})
})

describe("applyExtractUpdate", () => {
	it("narrows the SDK's state to numbers and run flags", () => {
		const next = applyExtractUpdate(
			job(),
			update({
				runState: "paused",
				bytesRead: 400n,
				counts: counts({ filesDone: 2n, bytesDone: 300n }),
				active: [
					{ entry: { archive: "arc", index: 1 }, destUuid: "f", destParent: "d", name: "x", size: undefined, bytesDone: 5n }
				],
				bytesPerSecond: 100n,
				etaMs: 2_000n
			})
		)

		expect(next).toMatchObject({
			phase: "extracting",
			paused: true,
			archiveBytes: 1_000,
			bytesRead: 400,
			bytesPerSecond: 100,
			etaMs: 2_000
		})
		expect(next.counts.bytesDone).toBe(300)
		expect(next.active).toEqual([
			{ entry: { archive: "arc", index: 1 }, destUuid: "f", destParent: "d", name: "x", size: null, bytesDone: 5 }
		])
	})

	it("adds the earlier calls' counts", () => {
		const base = { ...job().counts, filesDone: 10, bytesDone: 1_000 }
		const next = applyExtractUpdate(job(), update({ counts: counts({ filesDone: 2n, bytesDone: 50n }) }), base)

		expect(next.counts.filesDone).toBe(12)
		expect(next.counts.bytesDone).toBe(1_050)
	})

	it("keeps the lists when an update adds nothing", () => {
		const first = applyExtractUpdate(job(), update({ events: classifyExtractEvents([SKIPPED_EVENT]) }))
		const second = applyExtractUpdate(first, update())

		expect(second.failures).toBe(first.failures)
		expect(second.skipped).toBe(first.skipped)
		expect(second.renamed).toBe(first.renamed)
		expect(second.misleadingNames).toBe(first.misleadingNames)
		expect(second.dispositions).toBe(first.dispositions)
	})

	it("adds up the counted events and omissions", () => {
		const events = classifyExtractEvents<Dir, TestError>(
			[
				{ type: "topLevelTrashed", destUuid: "t1" },
				{ type: "topLevelTrashed", destUuid: "t2" },
				{ type: "fileFailed", ...failureInput(3, undefined), stage: { type: "registeredAsVersion", existingFile: "old" } },
				{ type: "fileFailed", ...failureInput(4, undefined) },
				SKIPPED_EVENT
			],
			{ failures: 7, skipped: 3, renamed: 0, misleadingNames: 0, savedAsVersion: 2, macMetadata: 1 }
		)
		const next = applyExtractUpdate(applyExtractUpdate(job(), update({ events })), update({ events }))

		expect(next.topLevelTrashedCount).toBe(4)
		expect(next.savedAsVersionCount).toBe(6)
		expect(next.failures.items).toHaveLength(2)
		expect(next.failures.omitted).toBe(10)
		expect(next.skipped.omitted).toBe(6)
		expect(next.macMetadataSkippedCount).toBe(4)
	})
})

describe("rewindExtractEvents", () => {
	it("takes the lists and tallies back to an earlier state, keeping the rest", () => {
		const earlier = applyExtractUpdate(job(), update({ events: classifyExtractEvents([SKIPPED_EVENT]) }))
		const events = classifyExtractEvents<Dir, TestError>([
			{ type: "topLevelTrashed", destUuid: "t1" },
			{ type: "fileFailed", ...failureInput(3, undefined), stage: { type: "registeredAsVersion", existingFile: "old" } },
			{ type: "fileFailed", ...failureInput(4, undefined) },
			{ type: "renamed", entry: { archive: "arc", index: 5 }, path: "p5", name: "n5 (1)", reason: "duplicateName" },
			{ type: "misleadingName", entry: { archive: "arc", index: 6 }, path: "p6" },
			{ type: "sourceDisposition", uuid: "arc", outcome: { type: "kept", reason: { type: "interrupted" }, bytesFreed: 0n } },
			{ type: "propagationFailed", destUuid: "p", error: { label: "x" } },
			SKIPPED_EVENT
		])
		const after = applyExtractUpdate(earlier, update({ phase: "finishing", events }))
		const rewound = rewindExtractEvents(after, earlier)

		expect(rewound).toMatchObject({
			failures: earlier.failures,
			skipped: earlier.skipped,
			renamed: earlier.renamed,
			misleadingNames: earlier.misleadingNames,
			dispositions: earlier.dispositions,
			topLevelTrashedCount: 0,
			savedAsVersionCount: 0,
			macMetadataSkippedCount: 1,
			propagationFailedCount: 0,
			phase: "finishing"
		})
	})
})

describe("isExtractPreflightRefusal", () => {
	const quota = { kind: "MaxStorageReached", label: "" }

	it("is a storage refusal before anything was created", () => {
		expect(isExtractPreflightRefusal(report({ topLevelCount: 0, counts: counts(), error: quota }))).toBe(true)
	})

	it("is not one after something was created", () => {
		expect(isExtractPreflightRefusal(report({ topLevelCount: 1, counts: counts(), error: quota }))).toBe(false)
		expect(isExtractPreflightRefusal(report({ topLevelCount: 0, counts: counts({ dirsCreated: 1n }), error: quota }))).toBe(false)
		expect(isExtractPreflightRefusal(report({ topLevelCount: 0, counts: counts({ filesDone: 1n }), error: quota }))).toBe(false)
		expect(
			isExtractPreflightRefusal(
				report({ topLevelCount: 0, counts: counts(), error: quota, omitted: { ...report().omitted, topLevel: 2n } })
			)
		).toBe(false)
	})

	it("is not another error", () => {
		expect(isExtractPreflightRefusal(report({ topLevelCount: 0, counts: counts(), error: { kind: "Server", label: "" } }))).toBe(false)
	})
})

describe("mergeExtractReports", () => {
	it("sums the counts and joins the lists", () => {
		const merged = mergeExtractReports(
			report({ failures: [failureInput(1, undefined)], omitted: { ...report().omitted, failures: 2n, topLevel: 1n } }),
			report({ topLevelCount: 2, failures: [failureInput(2, undefined)], counts: counts({ filesDone: 1n, bytesDone: 10n }) })
		)

		expect(merged.topLevelCount).toBe(3)
		expect(merged.failures.map(entry => entry.path)).toEqual(["p1", "p2"])
		expect(merged.omitted.failures).toBe(2n)
		expect(merged.omitted.topLevel).toBe(1n)
		expect(merged.counts.filesDone).toBe(4n)
		expect(merged.counts.bytesDone).toBe(910n)
	})

	it("caps the joined lists and counts what did not fit", () => {
		const many = Array.from({ length: 999 }, (_, index) => failureInput(index, undefined))
		const merged = mergeExtractReports(
			report({ failures: many }),
			report({ failures: [failureInput(1, undefined), failureInput(2, undefined)] })
		)

		expect(merged.failures).toHaveLength(1_000)
		expect(merged.omitted.failures).toBe(1n)
	})

	it("keeps the first stopping error and the first call's own archive figures", () => {
		const first = { kind: "Cancelled", label: "a" }
		const merged = mergeExtractReports(
			report({ error: first, duplicates: { names: ["x"], count: 1n } }),
			report({ error: { kind: "Server", label: "b" }, archiveBytes: 5n })
		)

		expect(merged.error).toBe(first)
		expect(merged.archiveBytes).toBe(1_000n)
		expect(merged.duplicates).toEqual({ names: ["x"], count: 1n })
		expect(mergeExtractReports(report(), report({ error: first })).error).toBe(first)
	})

	it("keeps the first report's lists when the second adds none", () => {
		const a = report({ failures: [failureInput(1, undefined)] })

		expect(mergeExtractReports(a, report()).failures).toBe(a.failures)
	})
})

describe("groupExtractRetries", () => {
	it("groups by destination and base in first-failure order, leaving out what cannot go again", () => {
		const groups = groupExtractRetries([
			failure(1, { destination: "d1", base: "a" }),
			failure(2, { destination: "d2", base: "" }),
			failure(3, null),
			failure(4, { destination: "d1", base: "a" }),
			failure(5, { destination: "d1", base: "b" })
		])

		expect(groups).toEqual([
			{
				destination: "d1",
				destinationDir: { uuid: "d1" },
				base: "a",
				entries: [
					{ archive: "arc", index: 1 },
					{ archive: "arc", index: 4 }
				]
			},
			{ destination: "d2", destinationDir: { uuid: "d2" }, base: "", entries: [{ archive: "arc", index: 2 }] },
			{ destination: "d1", destinationDir: { uuid: "d1" }, base: "b", entries: [{ archive: "arc", index: 5 }] }
		])
	})

	it("is empty without retryable failures", () => {
		expect(groupExtractRetries([failure(1, null)])).toEqual([])
	})
})

describe("extractHasIssues", () => {
	it("is a failure, a kept archive, a propagation failure or an entry skipped for another reason than macOS metadata", () => {
		expect(extractHasIssues(job())).toBe(false)
		expect(extractHasIssues(job({ failures: { items: [], omitted: 1 } }))).toBe(true)
		expect(
			extractHasIssues(
				job({ dispositions: [{ uuid: "arc", outcome: { type: "kept", reason: { type: "incomplete" }, bytesFreed: 0 } }] })
			)
		).toBe(true)
		expect(extractHasIssues(job({ propagationFailedCount: 1 }))).toBe(true)
		expect(extractHasIssues(job({ skipped: { items: [], omitted: 50 }, macMetadataSkippedCount: 49 }))).toBe(true)
	})

	it("is not macOS metadata left out", () => {
		expect(extractHasIssues(job({ skipped: { items: [], omitted: 50 }, macMetadataSkippedCount: 50 }))).toBe(false)
	})
})

describe("settleExtractJob", () => {
	it("is done when the report has no error, its figures replacing the updates'", () => {
		const running = applyExtractUpdate(job(), update({ events: classifyExtractEvents([SKIPPED_EVENT]) }))
		const settled = settleExtractJob(running, {
			report: report({ omitted: { ...report().omitted, topLevel: 4n }, duplicates: { names: ["a"], count: 2n } }),
			maxBytes: undefined
		})

		expect(settled.outcome).toEqual({ status: "done" })
		expect(settled.skipped).toBe(EMPTY_CAPPED_LIST)
		expect(settled.topLevelCount).toBe(5)
		expect(settled.duplicates).toEqual({ names: ["a"], count: 2 })
		expect(settled.counts.filesDone).toBe(3)
	})

	it("is done with issues on failures, counting files saved as versions apart", () => {
		const settled = settleExtractJob(job(), {
			report: report({
				failures: [
					failureInput(1, undefined),
					{ ...failureInput(2, undefined), stage: { type: "registeredAsVersion", existingFile: "old" } }
				],
				omitted: { ...report().omitted, failures: 3n }
			}),
			maxBytes: undefined
		})

		expect(settled.outcome).toEqual({ status: "doneWithIssues" })
		expect(settled.failures.items.map(entry => entry.path)).toEqual(["p1"])
		expect(settled.failures.items[0]?.retry).toBeNull()
		expect(settled.failures.omitted).toBe(3)
		expect(settled.savedAsVersionCount).toBe(1)
	})

	it("keeps the updates' tallies where the report's caps left out the stage or reason", () => {
		const running = job({ savedAsVersionCount: 4, macMetadataSkippedCount: 1_200 })
		const settled = settleExtractJob(running, {
			report: report({
				failures: [{ ...failureInput(1, undefined), stage: { type: "registeredAsVersion", existingFile: "old" } }],
				skipped: Array.from({ length: 1_000 }, () => SKIPPED_EVENT_INPUT),
				omitted: { ...report().omitted, failures: 5n, skipped: 200n }
			}),
			maxBytes: undefined
		})

		expect(settled.savedAsVersionCount).toBe(4)
		expect(settled.failures.omitted).toBe(2)
		expect(settled.macMetadataSkippedCount).toBe(1_200)
		expect(settled.outcome).toEqual({ status: "doneWithIssues" })
	})

	it("takes the report's own counts when it lists every entry", () => {
		const settled = settleExtractJob(job({ savedAsVersionCount: 4, macMetadataSkippedCount: 9 }), {
			report: report({ skipped: [SKIPPED_EVENT_INPUT] }),
			maxBytes: undefined
		})

		expect(settled.savedAsVersionCount).toBe(0)
		expect(settled.macMetadataSkippedCount).toBe(1)
		expect(settled.outcome).toEqual({ status: "done" })
	})

	it("is done with issues on an entry skipped for another reason", () => {
		const settled = settleExtractJob(job(), {
			report: report({ skipped: [{ ...SKIPPED_EVENT_INPUT, reason: { type: "symlink", target: "/etc" } }] }),
			maxBytes: undefined
		})

		expect(settled.outcome).toEqual({ status: "doneWithIssues" })
	})

	it("is cancelled, password required or wrong password by the report's error", () => {
		const settle = (kind: string) => settleExtractJob(job(), { report: report({ error: { kind, label: "" } }), maxBytes: 10 }).outcome

		expect(settle("Cancelled")).toEqual({ status: "cancelled" })
		expect(settle("ArchivePasswordRequired")).toEqual({ status: "passwordRequired" })
		expect(settle("ArchiveWrongPassword")).toEqual({ status: "wrongPassword" })
	})

	it("is over quota up front with what a listing planned, keeping partial counts", () => {
		const settled = settleExtractJob(job({}, { type: "planned", bytes: 5_000, files: 3 }), {
			report: report({ topLevelCount: 0, counts: counts(), error: { kind: "MaxStorageReached", label: "" } }),
			maxBytes: 100
		})

		expect(settled.outcome).toEqual({ status: "quotaExceeded", neededBytes: 5_000, freeBytes: 100 })
	})

	it("is over quota without a figure after a tar was partly extracted", () => {
		const settled = settleExtractJob(job(), {
			report: report({ counts: counts({ filesDone: 2n, bytesDone: 80n }), error: { kind: "MaxStorageReached", label: "" } }),
			maxBytes: 100
		})

		expect(settled.outcome).toEqual({ status: "quotaExceeded", neededBytes: null, freeBytes: 100 })
		expect(settled.counts.filesDone).toBe(2)
	})

	it("is failed on a storage refusal when the free storage was unknown, and on any other error", () => {
		const quota = { kind: "MaxStorageReached", label: "" }
		const corrupt = { kind: "ArchiveCorrupt", label: "" }

		expect(settleExtractJob(job(), { report: report({ error: quota }), maxBytes: undefined }).outcome).toEqual({
			status: "failed",
			error: quota
		})
		expect(settleExtractJob(job(), { report: report({ error: corrupt }), maxBytes: 10 }).outcome).toEqual({
			status: "failed",
			error: corrupt
		})
	})

	it("caps the report lists", () => {
		const skipped = Array.from({ length: 1_002 }, (_, index) => ({
			entry: { archive: "arc", index },
			path: "x",
			pathTruncated: false,
			bytes: 1n,
			reason: { type: "device" as const }
		}))
		const settled = settleExtractJob(job(), {
			report: report({ skipped, omitted: { ...report().omitted, skipped: 10n } }),
			maxBytes: undefined
		})

		expect(settled.skipped.items).toHaveLength(1_000)
		expect(settled.skipped.omitted).toBe(12)
	})

	describe("a rejected call", () => {
		it("is cancelled when cancelled or a stop was requested", () => {
			expect(settleExtractJob(job(), rejected({ kind: "Cancelled", label: "" })).outcome).toEqual({ status: "cancelled" })
			expect(settleExtractJob(job({ cancelRequest: "trash" }), rejected({ kind: "Internal", label: "" })).outcome).toEqual({
				status: "cancelled"
			})
		})

		it("is failed otherwise, keeping what the updates built", () => {
			const error: TestError = { kind: "InvalidState", label: "" }
			const running = applyExtractUpdate(job(), update({ events: classifyExtractEvents([SKIPPED_EVENT]) }))
			const settled = settleExtractJob(running, rejected(error))

			expect(settled.outcome).toEqual({ status: "failed", error })
			expect(settled.skipped).toBe(running.skipped)
		})
	})
})
