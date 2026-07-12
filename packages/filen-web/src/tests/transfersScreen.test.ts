// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react"
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
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

// M1 — computeTransfersAggregate/computeTransfersSpeed were already unit-tested as pure functions
// (transfers.test.ts's shouldShowTransfersAggregate describe block), but nothing asserted the JSX
// itself actually renders their output: a refactor that stripped this header block while leaving the
// predicate intact would pass every other persisted test.
describe("TransfersScreen — aggregate readout (M1)", () => {
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

// M5 — confirmCancelAllTransfers (the post-confirm action) was already unit-tested assuming the
// dialog already said yes (transfers.test.ts). Nothing persisted proved the UI actually GATES it
// behind that confirm rather than firing on the header button's own click, unlike the single-row
// Cancel gate (downloads.spec.ts's cancel-mid-flight e2e test).
describe("TransfersScreen — Cancel all confirm gate (M5)", () => {
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
