// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, cleanup, fireEvent, within } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import type { Transfer } from "@/features/transfers/store/useTransfersStore"

// Same mock boundary as transfersControl.test.ts's own: the real sdk client module touches a Vite
// `?worker`, unresolvable/unwanted under this node/jsdom vitest run — TransfersScreen's Cancel-all
// button reaches it transitively through features/transfers/lib/control.ts's cancelTransfer.
const { cancelUpload, cancelDownload } = vi.hoisted(() => ({
	cancelUpload: vi.fn(),
	cancelDownload: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { cancelUpload, cancelDownload, pauseUpload: vi.fn(), pauseDownload: vi.fn(), resumeUpload: vi.fn(), resumeDownload: vi.fn() }
}))

const { useTransfersStore } = await import("@/features/transfers/store/useTransfersStore")
const { useCopyJobsStore } = await import("@/features/transfers/store/useCopyJobsStore")
const { createCopyJob } = await import("@/features/drive/lib/copy.logic")
const { TransfersScreen } = await import("@/features/transfers/screens/transfers")

function transfer(overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: "t1",
		direction: "upload",
		name: "file.txt",
		size: 100,
		bytesTransferred: 0,
		status: "uploading",
		paused: false,
		parentUuid: null,
		startedAt: 0,
		...overrides
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
	useCopyJobsStore.setState({ jobs: {}, cancelPromptId: null })
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

// computeTransfersAggregate/computeTransfersSpeed were already unit-tested as pure functions
// (transfers.test.ts's shouldShowTransfersAggregate describe block), but nothing asserted the JSX
// itself actually renders their output: a refactor that stripped this header block while leaving the
// predicate intact would pass every other persisted test.
describe("TransfersScreen — aggregate readout", () => {
	it("renders the live speed + progress bar once at least one transfer is active", () => {
		useTransfersStore.setState({
			transfers: [transfer({ id: "a", status: "uploading", bytesTransferred: 50, size: 100 })],
			speedSamples: [
				{ timestamp: 0, totalBytes: 0 },
				{ timestamp: 1000, totalBytes: 1_000_000 }
			]
		})
		vi.useFakeTimers()
		vi.setSystemTime(1000)

		render(createElement(TransfersScreen))

		const progress = screen.getByRole("progressbar", { name: "Overall transfer progress" })
		expect(progress.getAttribute("aria-valuenow")).toBe("50")
		// transfersAggregateSpeed's own "{{speed}}/s" shape — formatBytes(1_000_000 bytes over the 1s
		// window) rendered as text, not just the pure computeTransfersSpeed number.
		expect(screen.getByText(/\/s$/)).toBeTruthy()
	})

	it("renders neither the aggregate speed nor its progress bar while nothing is active", () => {
		useTransfersStore.setState({ transfers: [transfer({ id: "a", status: "done" })], speedSamples: [] })

		render(createElement(TransfersScreen))

		expect(screen.queryByRole("progressbar", { name: "Overall transfer progress" })).toBeNull()
	})
})

// confirmCancelAllTransfers (the post-confirm action) was already unit-tested assuming the
// dialog already said yes (transfers.test.ts). Nothing persisted proved the UI actually GATES it
// behind that confirm rather than firing on the header button's own click, unlike the single-row
// Cancel gate (downloads.spec.ts's cancel-mid-flight e2e test).
describe("TransfersScreen — Cancel all confirm gate", () => {
	it("opens the confirm dialog on click, without cancelling anything yet", () => {
		useTransfersStore.setState({ transfers: [transfer({ id: "a", status: "uploading" }), transfer({ id: "b", status: "done" })] })

		render(createElement(TransfersScreen))

		fireEvent.click(screen.getByRole("button", { name: "Cancel all" }))

		expect(screen.getByRole("alertdialog", { name: "Cancel all transfers?" })).toBeTruthy()
		expect(cancelUpload).not.toHaveBeenCalled()
		expect(cancelDownload).not.toHaveBeenCalled()
	})

	it("cancels every active transfer only once the dialog is confirmed", () => {
		useTransfersStore.setState({
			transfers: [
				transfer({ id: "a", direction: "upload", status: "uploading" }),
				transfer({ id: "b", direction: "download", status: "downloading" }),
				transfer({ id: "c", status: "done" })
			]
		})

		render(createElement(TransfersScreen))

		fireEvent.click(screen.getByRole("button", { name: "Cancel all" }))

		const dialog = screen.getByRole("alertdialog", { name: "Cancel all transfers?" })
		// Base UI's modal AlertDialog hides the rest of the page from the accessibility tree while open
		// (aria-hide-others — same behavior downloads.spec.ts's own e2e cancel test relies on), so this
		// scoped query can't accidentally hit the header's own "Cancel all" trigger button underneath.
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel all" }))

		expect(cancelUpload).toHaveBeenCalledWith("a")
		expect(cancelDownload).toHaveBeenCalledWith("b")
	})

	it("dismissing the dialog (Keep transferring) cancels nothing", () => {
		useTransfersStore.setState({ transfers: [transfer({ id: "a", status: "uploading" })] })

		render(createElement(TransfersScreen))

		fireEvent.click(screen.getByRole("button", { name: "Cancel all" }))
		fireEvent.click(screen.getByRole("button", { name: "Keep transferring" }))

		expect(screen.queryByRole("alertdialog", { name: "Cancel all transfers?" })).toBeNull()
		expect(cancelUpload).not.toHaveBeenCalled()
	})
})

// Its row stays active while the copies it made move to the trash, which can be neither paused nor
// stopped.
describe("TransfersScreen — a copy whose job has ended", () => {
	const destination = { uuid: null, name: "Cloud Drive" }

	function button(name: string): HTMLButtonElement {
		const found = screen.getByRole("button", { name })

		if (!(found instanceof HTMLButtonElement)) {
			throw new Error(`${name} is not a button`)
		}

		return found
	}

	it("counts in Cancel all only the transfers it stops", () => {
		useCopyJobsStore.setState({
			jobs: { c: { ...createCopyJob("c", destination, 1), outcome: { status: "cancelled" }, cancelRequest: "trash" } }
		})
		useTransfersStore.setState({
			transfers: [
				transfer({ id: "a", status: "uploading" }),
				transfer({ id: "c", direction: "copy", status: "copying", paused: true })
			]
		})

		render(createElement(TransfersScreen))

		expect(button("Resume all").disabled).toBe(true)

		fireEvent.click(button("Cancel all"))

		expect(screen.getByText("1 active transfer will stop. This can't be undone.")).toBeTruthy()
	})

	it("disables every bulk action once the job ends, while its row is still active", () => {
		useCopyJobsStore.setState({ jobs: { c: createCopyJob("c", destination, 1) } })
		useTransfersStore.setState({ transfers: [transfer({ id: "c", direction: "copy", status: "copying" })] })

		render(createElement(TransfersScreen))

		expect(button("Pause all").disabled).toBe(false)
		expect(button("Cancel all").disabled).toBe(false)

		act(() => {
			useCopyJobsStore.getState().update("c", job => ({ ...job, outcome: { status: "cancelled" }, cancelRequest: "trash" }))
		})

		expect(button("Pause all").disabled).toBe(true)
		expect(button("Resume all").disabled).toBe(true)
		expect(button("Cancel all").disabled).toBe(true)
	})
})
