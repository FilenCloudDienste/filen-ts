import { beforeEach, describe, expect, it, vi } from "vitest"
import { createCopyJob, type CopyJob } from "@/features/drive/lib/copy.logic"
import type { ExtractJob } from "@/features/drive/lib/archiveJobs.logic"
import { getCopyJob, getDriveJob, getJobOf, jobsAccess, useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"

const DESTINATION = { uuid: null, name: "My Drive" }

beforeEach(() => {
	useDriveJobsStore.setState({ jobs: {}, cancelPromptId: null, passwordPromptId: null, reportJobId: null })
})

describe("useDriveJobsStore", () => {
	it("puts, updates and removes a job by id", () => {
		useDriveJobsStore.getState().put(createCopyJob("a", DESTINATION, 1))
		useDriveJobsStore.getState().update("copy", "a", job => ({ ...job, cancelRequest: "keep" }))

		expect(getCopyJob("a")?.cancelRequest).toBe("keep")

		useDriveJobsStore.getState().remove("a")

		expect(getCopyJob("a")).toBeUndefined()
	})

	it("closes the stop prompt and report a job's earlier run left open once a fresh run replaces it", () => {
		const { put, setCancelPromptId, setReportJobId } = useDriveJobsStore.getState()

		put({ ...createCopyJob("a", DESTINATION, 1), outcome: { status: "done" } })
		put(createCopyJob("b", DESTINATION, 1))
		setCancelPromptId("a")
		setReportJobId("a")
		put(createCopyJob("a", DESTINATION, 1))

		expect(useDriveJobsStore.getState().cancelPromptId).toBeNull()
		expect(useDriveJobsStore.getState().reportJobId).toBeNull()

		setCancelPromptId("b")
		setReportJobId("b")
		put(createCopyJob("a", DESTINATION, 1))

		expect(useDriveJobsStore.getState().cancelPromptId).toBe("b")
		expect(useDriveJobsStore.getState().reportJobId).toBe("b")
	})

	it("keeps an open report when a settled job is put back under its id", () => {
		const { put, setReportJobId } = useDriveJobsStore.getState()
		const settled: CopyJob = { ...createCopyJob("a", DESTINATION, 1), outcome: { status: "done" } }

		put(settled)
		setReportJobId("a")
		put({ ...settled, cardVisible: false })

		expect(useDriveJobsStore.getState().reportJobId).toBe("a")
	})

	it("never resurrects a removed job from a late update", () => {
		const before = useDriveJobsStore.getState()

		useDriveJobsStore.getState().update("copy", "gone", job => ({ ...job, cancelRequest: "trash" }))
		useDriveJobsStore.getState().remove("gone")

		expect(getCopyJob("gone")).toBeUndefined()
		expect(useDriveJobsStore.getState()).toBe(before)
	})

	it("leaves a job of another kind alone", () => {
		useDriveJobsStore.getState().put(createCopyJob("a", DESTINATION, 1))

		const before = useDriveJobsStore.getState()
		const updater = vi.fn<(job: ExtractJob) => ExtractJob>(job => job)

		useDriveJobsStore.getState().update("extract", "a", updater)

		expect(updater).not.toHaveBeenCalled()
		expect(useDriveJobsStore.getState()).toBe(before)
		expect(getJobOf("compress", "a")).toBeUndefined()
		expect(getJobOf("copy", "a")).toBe(getDriveJob("a"))
	})

	it("notifies no one when the updater returns the same job", () => {
		useDriveJobsStore.getState().put(createCopyJob("a", DESTINATION, 1))

		const listener = vi.fn()
		const unsubscribe = useDriveJobsStore.subscribe(listener)

		useDriveJobsStore.getState().update("copy", "a", job => job)
		unsubscribe()

		expect(listener).not.toHaveBeenCalled()
	})

	it("removes many in one write, and none when none is there", () => {
		useDriveJobsStore.getState().put(createCopyJob("a", DESTINATION, 1))
		useDriveJobsStore.getState().put(createCopyJob("b", DESTINATION, 1))
		useDriveJobsStore.getState().put(createCopyJob("c", DESTINATION, 1))

		const listener = vi.fn()
		const unsubscribe = useDriveJobsStore.subscribe(listener)

		useDriveJobsStore.getState().removeMany(new Set(["a", "c", "missing"]))
		useDriveJobsStore.getState().removeMany(new Set(["missing"]))
		unsubscribe()

		expect(listener).toHaveBeenCalledOnce()
		expect(Object.keys(useDriveJobsStore.getState().jobs)).toEqual(["b"])
	})

	it("holds the cancel, password and report prompt ids", () => {
		useDriveJobsStore.getState().setCancelPromptId("a")
		useDriveJobsStore.getState().setPasswordPromptId("b")
		useDriveJobsStore.getState().setReportJobId("c")

		expect(useDriveJobsStore.getState()).toMatchObject({ cancelPromptId: "a", passwordPromptId: "b", reportJobId: "c" })

		useDriveJobsStore.getState().setPasswordPromptId(null)

		expect(useDriveJobsStore.getState().passwordPromptId).toBeNull()
	})

	it("gives a runner its own kind's view", () => {
		const copies = jobsAccess("copy")

		copies.put(createCopyJob("a", DESTINATION, 1))
		copies.update("a", job => ({ ...job, cardVisible: true }))

		expect(copies.get("a")?.cardVisible).toBe(true)
		expect(jobsAccess("compress").get("a")).toBeUndefined()
	})
})
