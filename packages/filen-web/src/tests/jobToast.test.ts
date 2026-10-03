import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { ExternalToast } from "sonner"

const { toastCustom, toastDismiss, startCompress, startExtract } = vi.hoisted(() => ({
	toastCustom: vi.fn<(jsx: (id: string | number) => unknown, data?: ExternalToast) => string | number>(),
	toastDismiss: vi.fn(),
	startCompress: vi.fn<() => string>(),
	startExtract: vi.fn<() => string>()
}))

vi.mock("sonner", () => ({ toast: { custom: toastCustom, dismiss: toastDismiss, success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/features/drive/lib/archiveJobs", () => ({ startCompress, startExtract, rerunCompress: vi.fn(), retryFailedExtract: vi.fn() }))

import { hideJobToast, showJobToast } from "@/features/transfers/lib/jobToast"
import { startCompressWithCard, startExtractWithCard } from "@/features/transfers/lib/archiveToast"
import { createCopyJob } from "@/features/drive/lib/copy.logic"
import { getDriveJob, useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { ARCHIVE_FILE, compressJob, extractJob, JOB_DESTINATION } from "@/tests/support/archiveJobFixtures"

const DESTINATION = { uuid: null, name: "My Drive" }

beforeEach(() => {
	useDriveJobsStore.setState({ jobs: {}, cancelPromptId: null, passwordPromptId: null, reportJobId: null })
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
})

function lastOptions(): ExternalToast | undefined {
	return toastCustom.mock.calls.at(-1)?.[1]
}

describe("job toast", () => {
	it("shows one persistent toast per job and marks its card visible", () => {
		useDriveJobsStore.getState().put(createCopyJob("a", DESTINATION, 1))

		showJobToast("a")
		showJobToast("a")

		expect(toastCustom).toHaveBeenCalledTimes(2)
		expect(toastCustom.mock.calls[0]?.[1]?.id).toBe(lastOptions()?.id)
		expect(lastOptions()?.id).toMatch(/^copy:a:\d+$/)
		expect(lastOptions()?.duration).toBe(Infinity)
		expect(getDriveJob("a")?.cardVisible).toBe(true)
	})

	it("names each card's toast after its job's kind", () => {
		useDriveJobsStore.getState().put(compressJob({}, "c"))
		useDriveJobsStore.getState().put(extractJob({}, "e"))

		showJobToast("c")

		expect(lastOptions()?.id).toMatch(/^compress:c:\d+$/)

		showJobToast("e")

		expect(lastOptions()?.id).toMatch(/^extract:e:\d+$/)
	})

	it("shows nothing for a job that is gone", () => {
		showJobToast("gone")

		expect(toastCustom).not.toHaveBeenCalled()
	})

	it("hides the card on dismissal, keeping a running job and dropping a settled one nothing can reopen", () => {
		useDriveJobsStore.getState().put(createCopyJob("running", DESTINATION, 1))
		useDriveJobsStore.getState().put(extractJob({ outcome: { status: "cancelled" } }, "settled"))

		showJobToast("running")
		lastOptions()?.onDismiss?.({ id: "running" })
		showJobToast("settled")
		lastOptions()?.onDismiss?.({ id: "settled" })

		expect(getDriveJob("running")?.cardVisible).toBe(false)
		expect(getDriveJob("settled")).toBeUndefined()
	})

	it("dismisses the showing card through sonner, and nothing when none shows", () => {
		useDriveJobsStore.getState().put(createCopyJob("hidden", DESTINATION, 1))
		hideJobToast("hidden")

		expect(toastDismiss).not.toHaveBeenCalled()

		showJobToast("hidden")
		hideJobToast("hidden")

		expect(toastDismiss).toHaveBeenCalledWith(toastCustom.mock.calls.at(-1)?.[1]?.id)
	})

	// Sonner keeps a leaving toast for its exit animation and merges a same-id toast issued meanwhile into
	// it, so a card reopened right after being hidden would leave with the old one.
	it("reopens a hidden card under a fresh id that the old card's late dismissal leaves showing", () => {
		useDriveJobsStore.getState().put(createCopyJob("reopened", DESTINATION, 1))

		showJobToast("reopened")
		const first = lastOptions()
		hideJobToast("reopened")
		showJobToast("reopened")
		const second = lastOptions()
		first?.onDismiss?.({ id: "reopened" })

		expect(second?.id).not.toBe(first?.id)
		expect(getDriveJob("reopened")?.cardVisible).toBe(true)

		second?.onDismiss?.({ id: "reopened" })

		expect(getDriveJob("reopened")?.cardVisible).toBe(false)
	})

	it("keeps the card while its job runs and times it once the job settles", () => {
		useDriveJobsStore.getState().put(compressJob({}, "a"))
		showJobToast("a")

		expect(lastOptions()?.duration).toBe(Infinity)

		toastCustom.mockClear()
		useDriveJobsStore.getState().update("compress", "a", job => ({ ...job, bytesPerSecond: 10 }))

		expect(toastCustom).not.toHaveBeenCalled()

		useDriveJobsStore.getState().update("compress", "a", job => ({ ...job, outcome: { status: "done" } }))

		expect(toastCustom).toHaveBeenCalledTimes(1)
		expect(lastOptions()?.duration).toBe(4_000)
	})

	// A rerun with a password keeps the job's id and its card.
	it("makes a card sticky again when its job starts running again", () => {
		useDriveJobsStore
			.getState()
			.put(extractJob({ outcome: { status: "failed", error: { species: "plain", message: "x", label: "x" } } }, "a"))
		showJobToast("a")

		expect(lastOptions()?.duration).toBe(8_000)

		useDriveJobsStore.getState().put(extractJob({ cardVisible: true }, "a"))

		expect(lastOptions()?.duration).toBe(Infinity)
	})

	it("forgets a card that hid itself, so a settled job nothing can reopen is dropped", () => {
		useDriveJobsStore.getState().put({ ...createCopyJob("a", DESTINATION, 1), outcome: { status: "done" } })

		showJobToast("a")
		lastOptions()?.onAutoClose?.({ id: "a" })

		expect(getDriveJob("a")).toBeUndefined()
	})
})

describe("archive job toast", () => {
	it("starts a compress and an extract with their cards already showing, passing the password through", () => {
		startCompress.mockImplementation(() => {
			useDriveJobsStore.getState().put(compressJob({}, "c"))

			return "c"
		})
		startExtract.mockImplementation(() => {
			useDriveJobsStore.getState().put(extractJob({}, "e"))

			return "e"
		})

		const compress = {
			source: { kind: "items" as const, items: [] },
			destination: JOB_DESTINATION,
			name: "photos.zip",
			format: { type: "zip" as const, method: { type: "deflate" as const, level: 6 } },
			encrypted: true,
			dispose: null,
			itemCount: 1
		}

		expect(startCompressWithCard(compress, "secret")).toBe("c")
		expect(startCompress).toHaveBeenCalledWith(compress, "secret")
		expect(getDriveJob("c")?.cardVisible).toBe(true)
		expect(lastOptions()?.id).toMatch(/^compress:c:\d+$/)

		const extract = {
			archive: { file: ARCHIVE_FILE, uuid: ARCHIVE_FILE.uuid, name: "photos.zip" },
			destination: JOB_DESTINATION,
			root: { type: "destination" as const },
			rowName: "photos.zip",
			calls: [{ type: "all" as const }],
			skipMacMetadata: true,
			dispose: null,
			basis: { type: "archiveRead" as const },
			formatHint: null,
			glyph: "items" as const
		}

		expect(startExtractWithCard(extract, undefined)).toBe("e")
		expect(startExtract).toHaveBeenCalledWith(extract, undefined)
		expect(getDriveJob("e")?.cardVisible).toBe(true)
		expect(lastOptions()?.id).toMatch(/^extract:e:\d+$/)
	})
})
