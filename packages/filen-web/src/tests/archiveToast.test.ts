import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { ExternalToast } from "sonner"

const { toastCustom, startExtract } = vi.hoisted(() => ({
	toastCustom: vi.fn<(jsx: (id: string | number) => unknown, data?: ExternalToast) => string | number>(),
	startExtract: vi.fn<() => string>()
}))

vi.mock("sonner", () => ({ toast: { custom: toastCustom, dismiss: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/features/drive/lib/archiveJobs", () => ({
	startCompress: vi.fn(),
	startExtract,
	rerunCompress: vi.fn(),
	retryFailedExtract: vi.fn()
}))

import { startExtractBatchWithCards, startExtractWithCard } from "@/features/transfers/lib/archiveToast"
import { getDriveJob, useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { ARCHIVE_FILE, JOB_DESTINATION, extractJob } from "@/tests/support/archiveJobFixtures"
import type { ExtractJobRequest } from "@/features/drive/lib/archiveJobs.logic"
import type { JobOutcome } from "@filen/shared"
import type { ErrorDTO } from "@/lib/sdk/errors"

const REQUEST: Omit<ExtractJobRequest, "id"> = {
	archive: { file: ARCHIVE_FILE, uuid: ARCHIVE_FILE.uuid, name: "photos.zip" },
	destination: JOB_DESTINATION,
	root: { type: "newFolder" },
	rowName: "photos",
	calls: [{ type: "all" }],
	skipMacMetadata: true,
	dispose: null,
	basis: { type: "archiveRead" },
	formatHint: "zip",
	glyph: "directory"
}

let started = 0

beforeEach(() => {
	started = 0
	useDriveJobsStore.setState({ jobs: {}, cancelPromptId: null, passwordPromptId: null, reportJobId: null })
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
	startExtract.mockImplementation(() => {
		started += 1

		const id = `job${String(started)}`

		useDriveJobsStore.getState().put(extractJob({ phase: "extracting" }, id))

		return id
	})
})

function settle(id: string, outcome: JobOutcome<ErrorDTO>): void {
	useDriveJobsStore.getState().update("extract", id, job => ({ ...job, outcome }))
}

function cardsShown(): string[] {
	return toastCustom.mock.calls.map(call => String(call[1]?.id).split(":")[1] ?? "")
}

describe("startExtractWithCard", () => {
	it("shows the card and asks for the password by itself when the run needs one", () => {
		const id = startExtractWithCard(REQUEST, undefined)

		expect(getDriveJob(id)?.cardVisible).toBe(true)

		settle(id, { status: "passwordRequired" })

		expect(useDriveJobsStore.getState().passwordPromptId).toBe(id)
	})
})

describe("startExtractBatchWithCards", () => {
	it("starts one job per archive, without a password, and shows only the first card", () => {
		const ids = startExtractBatchWithCards([REQUEST, REQUEST, REQUEST])

		expect(ids).toEqual(["job1", "job2", "job3"])
		expect(startExtract).toHaveBeenCalledTimes(3)
		expect(startExtract).toHaveBeenCalledWith(REQUEST, undefined)
		expect(cardsShown()).toEqual(["job1"])
		expect(getDriveJob("job2")?.cardVisible).toBe(false)
	})

	it("opens a later job's card once it ends with something to look at, and only then", () => {
		startExtractBatchWithCards([REQUEST, REQUEST, REQUEST, REQUEST, REQUEST])
		toastCustom.mockClear()

		settle("job2", { status: "done" })
		settle("job3", { status: "cancelled" })

		expect(cardsShown()).toEqual([])

		settle("job4", { status: "failed", error: { species: "plain", message: "x", label: "x" } })
		settle("job5", { status: "doneWithIssues" })

		expect(cardsShown()).toEqual(["job4", "job5"])

		// Settled for good: a later change opens nothing.
		toastCustom.mockClear()
		settle("job2", { status: "doneWithIssues" })

		expect(cardsShown()).toEqual([])
	})

	it("sends a password outcome to the password queue, not a card, and still watches the rerun", () => {
		startExtractBatchWithCards([REQUEST, REQUEST, REQUEST])
		toastCustom.mockClear()

		settle("job2", { status: "passwordRequired" })
		settle("job3", { status: "wrongPassword" })

		expect(cardsShown()).toEqual([])
		expect(useDriveJobsStore.getState().passwordPromptId).toBe("job2")

		useDriveJobsStore.getState().put(extractJob({ phase: "extracting" }, "job2"))
		settle("job2", { status: "quotaExceeded", neededBytes: null, freeBytes: 0 })

		expect(cardsShown()).toEqual(["job2"])
	})

	it("forgets a job dropped before it settled", () => {
		startExtractBatchWithCards([REQUEST, REQUEST])
		toastCustom.mockClear()

		useDriveJobsStore.getState().remove("job2")
		useDriveJobsStore
			.getState()
			.put({ ...extractJob({}, "job2"), outcome: { status: "failed", error: { species: "plain", message: "x", label: "x" } } })

		expect(cardsShown()).toEqual([])
	})
})
