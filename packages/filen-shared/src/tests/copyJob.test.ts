import { describe, expect, it } from "vitest"
import {
	applyCopyCreated,
	applyCopyUpdate,
	copyMaxBytes,
	createCopyJob,
	isQuotaPreflightFailure,
	settleCopyJob,
	type CopyCountsInput,
	type CopyJob,
	type CopyReportInput,
	type CopySettlement,
	type CopyUpdateInput
} from "@filen/shared"

interface Failure {
	destName: string
}

interface TestError {
	kind?: string
	label: string
}

type Job = CopyJob<string, Failure, string, TestError>
type Report = CopyReportInput<Failure, string, TestError>

function rejected(error: TestError): CopySettlement<Failure, string, TestError> {
	return { error }
}

const DESTINATION = { uuid: null, name: "My Drive" }

function job(itemCount = 1): Job {
	return createCopyJob<string, Failure, string, TestError>("j", DESTINATION, itemCount)
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

function update(overrides: Partial<CopyUpdateInput<Failure>> = {}): CopyUpdateInput<Failure> {
	return {
		phase: "copyingFiles",
		pausing: false,
		paused: false,
		cancelling: false,
		scan: { sourcesDone: 1n, sourcesTotal: 1n },
		totals: { dirs: 1n, files: 3n, bytes: 300n },
		counts: counts(),
		active: [],
		bytesPerSecond: undefined,
		etaMs: undefined,
		events: { failures: [], savedAsVersion: 0, renamed: 0, propagationFailed: 0 },
		...overrides
	}
}

function report(overrides: Partial<Report> = {}): Report {
	return {
		createdCount: 0,
		totals: { dirs: 1n, files: 3n, bytes: 300n },
		counts: counts({ filesDone: 3n, bytesDone: 300n, dirsCreated: 1n }),
		failures: [],
		savedAsVersionCount: 0,
		renamedCount: 0,
		error: undefined,
		...overrides
	}
}

const QUOTA_REPORT = report({
	counts: counts(),
	totals: { dirs: 1n, files: 2n, bytes: 100n },
	error: { kind: "MaxStorageReached", label: "needs more" }
})

describe("createCopyJob", () => {
	it("starts scanning with nothing counted", () => {
		const created = job(2)

		expect(created).toMatchObject({ id: "j", destination: DESTINATION, itemCount: 2, phase: "scanning", cancelRequest: null })
		expect(created.counts.bytesDone).toBe(0)
		expect(created.outcome).toEqual({ status: "running" })
	})
})

describe("applyCopyUpdate", () => {
	it("narrows the SDK's bigint state to numbers", () => {
		const next = applyCopyUpdate(
			job(2),
			update({
				scan: { sourcesDone: 2n, sourcesTotal: 3n },
				counts: counts({ filesDone: 2n, bytesDone: 200n }),
				active: [{ destUuid: "d", name: "x", size: 50n, bytesDone: 10n }],
				bytesPerSecond: 1_000n,
				etaMs: 5_000n
			})
		)

		expect(next.scan).toEqual({ sourcesDone: 2, sourcesTotal: 3 })
		expect(next.totals).toEqual({ dirs: 1, files: 3, bytes: 300 })
		expect(next.counts.filesDone).toBe(2)
		expect(next.counts.bytesDone).toBe(200)
		expect(next.active).toEqual([{ destUuid: "d", name: "x", size: 50, bytesDone: 10 }])
		expect(next.bytesPerSecond).toBe(1_000)
		expect(next.etaMs).toBe(5_000)
		expect(next.phase).toBe("copyingFiles")
	})

	it("reads an unknown speed and ETA as null", () => {
		const next = applyCopyUpdate(job(), update())

		expect(next.bytesPerSecond).toBeNull()
		expect(next.etaMs).toBeNull()
	})

	it("appends failures and adds up the notes across updates", () => {
		let next = applyCopyUpdate(
			job(),
			update({ events: { failures: [{ destName: "a" }], savedAsVersion: 1, renamed: 2, propagationFailed: 0 } })
		)

		next = applyCopyUpdate(
			next,
			update({ events: { failures: [{ destName: "b" }], savedAsVersion: 1, renamed: 0, propagationFailed: 3 } })
		)

		expect(next.failures.map(failure => failure.destName)).toEqual(["a", "b"])
		expect(next.savedAsVersionCount).toBe(2)
		expect(next.renamedCount).toBe(2)
		expect(next.propagationFailedCount).toBe(3)
	})

	it("keeps the failures array identity when an update brings none", () => {
		const next = applyCopyUpdate(job(), update())

		expect(applyCopyUpdate(next, update()).failures).toBe(next.failures)
	})

	it("keeps an app's own fields", () => {
		const withExtra = { ...job(), glyph: "file" as const }

		expect(applyCopyUpdate(withExtra, update()).glyph).toBe("file")
	})
})

describe("applyCopyCreated", () => {
	it("records created top-level items in creation order", () => {
		expect(applyCopyCreated(applyCopyCreated(job(2), "one"), "two").created).toEqual(["one", "two"])
	})
})

describe("copyMaxBytes", () => {
	it("is the free storage as a number", () => {
		expect(copyMaxBytes({ maxStorage: 1_000n, storageUsed: 400n })).toBe(600)
	})

	it("is undefined without a cached account or a resolvable quota", () => {
		expect(copyMaxBytes(undefined)).toBeUndefined()
		expect(copyMaxBytes({ maxStorage: 0n, storageUsed: 0n })).toBeUndefined()
	})

	it("floors at zero when usage exceeds the plan", () => {
		expect(copyMaxBytes({ maxStorage: 100n, storageUsed: 500n })).toBe(0)
	})
})

describe("isQuotaPreflightFailure", () => {
	it("is a MaxStorageReached report that wrote nothing", () => {
		expect(isQuotaPreflightFailure(QUOTA_REPORT)).toBe(true)
	})

	it("is not a server-side quota failure part way through", () => {
		expect(isQuotaPreflightFailure(report({ error: { kind: "MaxStorageReached", label: "full" } }))).toBe(false)
		expect(isQuotaPreflightFailure({ ...QUOTA_REPORT, createdCount: 1 })).toBe(false)
	})

	it("is not another error", () => {
		expect(isQuotaPreflightFailure(report({ counts: counts(), error: { kind: "Server", label: "x" } }))).toBe(false)
	})
})

describe("settleCopyJob", () => {
	const running = job(3)

	it("settles a clean report as done with the report's totals and counts", () => {
		const settled = settleCopyJob(
			{ ...running, active: [{ destUuid: "d", name: "x", size: 1, bytesDone: 0 }], paused: true, pausing: true },
			{ report: report(), maxBytes: undefined }
		)

		expect(settled.outcome).toEqual({ status: "done" })
		expect(settled.totals.bytes).toBe(300)
		expect(settled.counts.filesDone).toBe(3)
		expect(settled.active).toEqual([])
		expect(settled.paused).toBe(false)
		expect(settled.pausing).toBe(false)
	})

	it("settles as doneWithFailures, replacing what the updates accumulated with the report's own", () => {
		const accumulated = { ...running, failures: [{ destName: "stale" }], savedAsVersionCount: 5, renamedCount: 5 }
		const settled = settleCopyJob(accumulated, {
			report: report({ failures: [{ failure: { destName: "b.txt" }, retryable: "raw-b" }], savedAsVersionCount: 1, renamedCount: 2 }),
			maxBytes: undefined
		})

		expect(settled.outcome).toEqual({ status: "doneWithFailures" })
		expect(settled.failures).toEqual([{ destName: "b.txt" }])
		expect(settled.retryable).toEqual(["raw-b"])
		expect(settled.savedAsVersionCount).toBe(1)
		expect(settled.renamedCount).toBe(2)
	})

	it("is done when the only failures were saved as versions", () => {
		const settled = settleCopyJob(running, { report: report({ savedAsVersionCount: 1 }), maxBytes: undefined })

		expect(settled.outcome).toEqual({ status: "done" })
		expect(settled.retryable).toEqual([])
	})

	it("settles a Cancelled report as cancelled", () => {
		const settled = settleCopyJob(running, { report: report({ error: { kind: "Cancelled", label: "c" } }), maxBytes: undefined })

		expect(settled.outcome).toEqual({ status: "cancelled" })
	})

	it("settles a quota pre-flight refusal with what it needs and the free storage it was checked against", () => {
		expect(settleCopyJob(running, { report: QUOTA_REPORT, maxBytes: 42 }).outcome).toEqual({
			status: "quotaExceeded",
			neededBytes: 100,
			freeBytes: 42
		})
	})

	it("settles a server refusal of a copy that fit the free figure as failed", () => {
		expect(settleCopyJob(running, { report: QUOTA_REPORT, maxBytes: 100 }).outcome).toEqual({
			status: "failed",
			error: { kind: "MaxStorageReached", label: "needs more" }
		})
	})

	it("settles a quota pre-flight refusal without a known free figure as failed", () => {
		expect(settleCopyJob(running, { report: QUOTA_REPORT, maxBytes: undefined }).outcome).toEqual({
			status: "failed",
			error: { kind: "MaxStorageReached", label: "needs more" }
		})
	})

	it("settles any other report error as failed with the adapter's error", () => {
		const error = { kind: "Server", label: "boom" }

		expect(settleCopyJob(running, { report: report({ error }), maxBytes: 42 }).outcome).toEqual({ status: "failed", error })
	})

	it("settles a rejection: Cancelled as cancelled, anything else as failed", () => {
		expect(settleCopyJob(running, rejected({ kind: "Cancelled", label: "c" })).outcome).toEqual({ status: "cancelled" })
		expect(settleCopyJob(running, rejected({ label: "no client" })).outcome).toEqual({
			status: "failed",
			error: { label: "no client" }
		})
	})

	it("stops a rejected job's in-flight state", () => {
		const settled = settleCopyJob(
			{ ...running, active: [{ destUuid: "d", name: "x", size: 1, bytesDone: 0 }], paused: true },
			rejected({ label: "x" })
		)

		expect(settled.active).toEqual([])
		expect(settled.paused).toBe(false)
	})
})
