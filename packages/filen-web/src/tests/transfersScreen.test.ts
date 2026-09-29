// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { act, render, screen, cleanup, fireEvent, within } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import type { Transfer } from "@/features/transfers/store/useTransfersStore"

// Same mock boundary as transfersControl.test.ts's own: the real sdk client module touches a Vite
// `?worker`, unresolvable/unwanted under this node/jsdom vitest run — TransfersScreen's Cancel-all
// button reaches it transitively through features/transfers/lib/control.ts's cancelTransfer.
const { sdkCancel } = vi.hoisted(() => ({ sdkCancel: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { cancelTransfer: sdkCancel, pauseTransfer: vi.fn(), resumeTransfer: vi.fn() }
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
	it("summarizes the active count, live speed and overall percent once at least one transfer is active", () => {
		useTransfersStore.setState({
			transfers: [transfer({ id: "a", status: "uploading", bytesTransferred: 50, size: 100 })],
			speedSamples: [
				{ timestamp: 0, totalBytes: 0 },
				{ timestamp: 1000, totalBytes: 1_000_000 }
			]
		})
		vi.useFakeTimers()
		vi.setSystemTime(1000)

		const { container } = render(createElement(TransfersScreen))
		const header = within(container.querySelector("header") ?? container)

		// transfersAggregateSpeed's own "{{speed}}/s" shape — 1_000_000 bytes over the 1s window, with
		// its decimal kept — rendered as text, not just the pure computeTransfersSpeed number.
		// The speed last: the one figure that keeps changing length, with nothing after it to push.
		expect(header.getByText("1 active · 50% · 976.6 KiB/s")).toBeTruthy()
	})

	it("renders no summary while nothing is active", () => {
		useTransfersStore.setState({ transfers: [transfer({ id: "a", status: "done" })], speedSamples: [] })

		render(createElement(TransfersScreen))

		expect(screen.queryByText(/ active$/)).toBeNull()
	})
})

// Cancel all must be gated behind the confirm dialog, not fire on the header button's own click.
describe("TransfersScreen — Cancel all confirm gate", () => {
	it("opens the confirm dialog on click, without cancelling anything yet", () => {
		useTransfersStore.setState({ transfers: [transfer({ id: "a", status: "uploading" }), transfer({ id: "b", status: "done" })] })

		render(createElement(TransfersScreen))

		fireEvent.click(screen.getByRole("button", { name: "Cancel all" }))

		expect(screen.getByRole("alertdialog", { name: "Cancel all transfers?" })).toBeTruthy()
		expect(sdkCancel).not.toHaveBeenCalled()
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

		expect(sdkCancel.mock.calls).toEqual([["a"], ["b"]])
	})

	it("dismissing the dialog (Keep transferring) cancels nothing", () => {
		useTransfersStore.setState({ transfers: [transfer({ id: "a", status: "uploading" })] })

		render(createElement(TransfersScreen))

		fireEvent.click(screen.getByRole("button", { name: "Cancel all" }))
		fireEvent.click(screen.getByRole("button", { name: "Keep transferring" }))

		expect(screen.queryByRole("alertdialog", { name: "Cancel all transfers?" })).toBeNull()
		expect(sdkCancel).not.toHaveBeenCalled()
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

// A dropped directory adds a row per file up front, and every progress tick re-renders the screen.
describe("TransfersScreen — a large batch", () => {
	it("mounts only the rows in view, not one per transfer", () => {
		// The virtualizer sizes its viewport off offsetHeight, which jsdom leaves at 0: a 600px list.
		const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")

		Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
			configurable: true,
			get(this: HTMLElement) {
				return this.classList.contains("overflow-y-auto") ? 600 : 0
			}
		})
		onTestFinished(() => {
			if (original === undefined) {
				Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight")
			} else {
				Object.defineProperty(HTMLElement.prototype, "offsetHeight", original)
			}
		})

		useTransfersStore.setState({
			transfers: Array.from({ length: 2_000 }, (_, index) =>
				transfer({ id: `t${String(index)}`, name: `file${String(index)}.txt`, startedAt: index })
			)
		})

		const { container } = render(createElement(TransfersScreen))
		const rows = container.querySelectorAll("li")

		expect(rows.length).toBeGreaterThan(0)
		expect(rows.length).toBeLessThan(50)
		expect(screen.getByText("file0.txt")).toBeTruthy()
		expect(screen.getByText("Active")).toBeTruthy()
	})
})
