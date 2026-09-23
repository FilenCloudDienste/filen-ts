import { beforeEach, describe, expect, it } from "vitest"
import { createCopyJob } from "@/features/drive/lib/copy.logic"
import { getCopyJob, useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"

const DESTINATION = { uuid: null, name: "My Drive" }

beforeEach(() => {
	useCopyJobsStore.setState({ jobs: {} })
})

describe("useCopyJobsStore", () => {
	it("puts, updates and removes a job by id", () => {
		useCopyJobsStore.getState().put(createCopyJob("a", DESTINATION, 1))
		useCopyJobsStore.getState().update("a", job => ({ ...job, cancelRequest: "keep" }))

		expect(getCopyJob("a")?.cancelRequest).toBe("keep")

		useCopyJobsStore.getState().remove("a")

		expect(getCopyJob("a")).toBeUndefined()
	})

	it("never resurrects a removed job from a late update", () => {
		const before = useCopyJobsStore.getState()

		useCopyJobsStore.getState().update("gone", job => ({ ...job, cancelRequest: "trash" }))
		useCopyJobsStore.getState().remove("gone")

		expect(getCopyJob("gone")).toBeUndefined()
		expect(useCopyJobsStore.getState()).toBe(before)
	})
})
