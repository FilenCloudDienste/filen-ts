import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { ExternalToast } from "sonner"

const { toastCustom, toastDismiss, copyItems } = vi.hoisted(() => ({
	toastCustom: vi.fn<(jsx: (id: string | number) => unknown, data?: ExternalToast) => string | number>(),
	toastDismiss: vi.fn(),
	copyItems: vi.fn(() => new Promise(() => undefined))
}))

vi.mock("sonner", () => ({ toast: { custom: toastCustom, dismiss: toastDismiss, success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { copyItems } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { hideCopyToast, showCopyToast, startCopyWithCard } from "@/features/transfers/lib/copyToast"
import { createCopyJob } from "@/features/drive/lib/copy.logic"
import { narrowItem } from "@/features/drive/lib/item"
import { getCopyJob, useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"

const DESTINATION = { uuid: null, name: "My Drive" }

beforeEach(() => {
	useCopyJobsStore.setState({ jobs: {}, cancelPromptId: null })
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
})

function lastOptions(): ExternalToast | undefined {
	return toastCustom.mock.calls.at(-1)?.[1]
}

describe("copy toast", () => {
	it("shows one persistent toast per job and marks its card visible", () => {
		useCopyJobsStore.getState().put(createCopyJob("a", DESTINATION, 1))

		showCopyToast("a")
		showCopyToast("a")

		expect(toastCustom).toHaveBeenCalledTimes(2)
		expect(toastCustom.mock.calls[0]?.[1]?.id).toBe(lastOptions()?.id)
		expect(lastOptions()?.id).toMatch(/^copy:a:\d+$/)
		expect(lastOptions()?.duration).toBe(Infinity)
		expect(getCopyJob("a")?.cardVisible).toBe(true)
	})

	it("shows nothing for a job that is gone", () => {
		showCopyToast("gone")

		expect(toastCustom).not.toHaveBeenCalled()
	})

	it("hides the card on dismissal, keeping a running job and dropping a settled one nothing can reopen", () => {
		useCopyJobsStore.getState().put(createCopyJob("running", DESTINATION, 1))
		useCopyJobsStore.getState().put({ ...createCopyJob("settled", DESTINATION, 1), outcome: { status: "cancelled" } })

		showCopyToast("running")
		lastOptions()?.onDismiss?.({ id: "running" })
		showCopyToast("settled")
		lastOptions()?.onDismiss?.({ id: "settled" })

		expect(getCopyJob("running")?.cardVisible).toBe(false)
		expect(getCopyJob("settled")).toBeUndefined()
	})

	it("dismisses the showing card through sonner, and nothing when none shows", () => {
		useCopyJobsStore.getState().put(createCopyJob("hidden", DESTINATION, 1))
		hideCopyToast("hidden")

		expect(toastDismiss).not.toHaveBeenCalled()

		showCopyToast("hidden")
		hideCopyToast("hidden")

		expect(toastDismiss).toHaveBeenCalledWith(toastCustom.mock.calls.at(-1)?.[1]?.id)
	})

	// Sonner keeps a leaving toast for its exit animation and merges a same-id toast issued meanwhile into
	// it, so a card reopened right after being hidden would leave with the old one.
	it("reopens a hidden card under a fresh id that the old card's late dismissal leaves showing", () => {
		useCopyJobsStore.getState().put(createCopyJob("reopened", DESTINATION, 1))

		showCopyToast("reopened")
		const first = lastOptions()
		hideCopyToast("reopened")
		showCopyToast("reopened")
		const second = lastOptions()
		first?.onDismiss?.({ id: "reopened" })

		expect(second?.id).not.toBe(first?.id)
		expect(getCopyJob("reopened")?.cardVisible).toBe(true)

		second?.onDismiss?.({ id: "reopened" })

		expect(getCopyJob("reopened")?.cardVisible).toBe(false)
	})

	it("starts a copy with its card already showing", () => {
		const id = startCopyWithCard(
			[
				narrowItem({
					uuid: "f-0000-0000-0000-000000000000",
					parent: "p-0000-0000-0000-000000000000",
					color: "default",
					timestamp: 0n,
					favorited: false,
					meta: { type: "decoded", data: { name: "dir" } }
				})
			],
			DESTINATION
		)

		expect(id).not.toBeNull()
		expect(getCopyJob(id ?? "")?.cardVisible).toBe(true)
		expect(lastOptions()?.id).toMatch(new RegExp(`^copy:${id ?? ""}:\\d+$`))
		expect(startCopyWithCard([], DESTINATION)).toBeNull()
	})
})
