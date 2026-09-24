import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("@filen/sdk-rs", async () => await import("@/tests/mocks/sdkCopy"))
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }))
vi.mock("@/lib/sdkUnwrap", () => ({}))

import useCopyJobsStore, { getCopyJob } from "@/features/copy/store/useCopyJobs.store"
import { createCopyJob } from "@/features/copy/copyAdapter"

const job = (id: string) => createCopyJob(id, { uuid: null, name: "Cloud Drive" }, 1, "file")

beforeEach(() => {
	useCopyJobsStore.getState().clear()
})

describe("useCopyJobs.store", () => {
	it("puts, updates and removes jobs by id", () => {
		useCopyJobsStore.getState().put(job("a"))
		useCopyJobsStore.getState().update("a", current => ({ ...current, cancelRequest: "trash" }))

		expect(getCopyJob("a")?.cancelRequest).toBe("trash")

		useCopyJobsStore.getState().remove("a")

		expect(getCopyJob("a")).toBeUndefined()
	})

	it("an update or remove of an unknown job leaves the state object untouched (no re-render)", () => {
		useCopyJobsStore.getState().put(job("a"))

		const before = useCopyJobsStore.getState()

		useCopyJobsStore.getState().update("missing", current => current)
		useCopyJobsStore.getState().remove("missing")

		expect(useCopyJobsStore.getState()).toBe(before)
	})
})
