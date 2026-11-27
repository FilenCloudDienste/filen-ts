// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { mockViewportHeight } from "@/tests/support/viewport"
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
const { useDriveJobsStore } = await import("@/features/transfers/store/useDriveJobsStore")
const { createCopyJob } = await import("@/features/drive/lib/copy.logic")
const { TransfersScreen } = await import("@/features/transfers/screens/transfers")
const { registerAllActions } = await import("@/lib/keymap/actions")

// The screen binds the transfers keys.
registerAllActions()

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

// The list is 600px tall.
function mockListViewport(): void {
	mockViewportHeight(element => element.classList.contains("overflow-y-auto"), 600)
}

beforeEach(() => {
	vi.clearAllMocks()
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
	useDriveJobsStore.setState({ jobs: {}, cancelPromptId: null })
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

		// 1_000_000 bytes over the 1s window, with its decimal kept, rendered as text rather than just the
		// pure computeTransfersSpeed number.
		// The speed last: the one figure that keeps changing length, with nothing after it to push.
		// Below sm only the percent shows; the count and speed are sm and up.
		expect(header.getByText("50%", { exact: false }).textContent).toBe("1 active · 50% · 976.6 KiB/s")
		expect(Array.from(container.querySelectorAll("header p span"), span => span.className)).toEqual([
			"hidden sm:inline",
			"hidden sm:inline"
		])
	})

	it("names every kind of transfer, archive jobs included, while the list is empty", () => {
		render(createElement(TransfersScreen))

		expect(screen.getByText("Uploads, downloads, copies and archive jobs appear here.")).toBeTruthy()
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

	it("closes once the last active transfer settles, and stays closed when a new one starts", () => {
		useTransfersStore.setState({ transfers: [transfer({ id: "a", status: "uploading" })] })

		render(createElement(TransfersScreen))

		fireEvent.click(screen.getByRole("button", { name: "Cancel all" }))

		expect(screen.getByRole("alertdialog", { name: "Cancel all transfers?" })).toBeTruthy()

		act(() => {
			useTransfersStore.getState().settle("a", "done")
		})

		expect(screen.queryByRole("alertdialog", { name: "Cancel all transfers?" })).toBeNull()

		act(() => {
			useTransfersStore.setState({
				transfers: [...useTransfersStore.getState().transfers, transfer({ id: "b", status: "uploading" })]
			})
		})

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
		useDriveJobsStore.setState({
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
		useDriveJobsStore.setState({ jobs: { c: createCopyJob("c", destination, 1) } })
		useTransfersStore.setState({ transfers: [transfer({ id: "c", direction: "copy", status: "copying" })] })

		render(createElement(TransfersScreen))

		expect(button("Pause all").disabled).toBe(false)
		expect(button("Cancel all").disabled).toBe(false)

		act(() => {
			useDriveJobsStore.getState().update("copy", "c", job => ({ ...job, outcome: { status: "cancelled" }, cancelRequest: "trash" }))
		})

		expect(button("Pause all").disabled).toBe(true)
		expect(button("Resume all").disabled).toBe(true)
		expect(button("Cancel all").disabled).toBe(true)
	})
})

// Each kind asks in the job's own prompt, mounted at the root, never in the screen's plain confirm.
describe("TransfersScreen — a drive job row's Cancel", () => {
	it.each([
		["copy", "copying"],
		["compress", "compressing"],
		["extract", "extracting"]
	] as const)("opens the job's prompt for a %s", (direction, status) => {
		mockListViewport()
		useTransfersStore.setState({ transfers: [transfer({ id: "j", name: "job", direction, status })] })

		render(createElement(TransfersScreen))
		fireEvent.click(within(screen.getByRole("listitem", { name: "job" })).getByRole("button", { name: "Cancel" }))

		expect(useDriveJobsStore.getState().cancelPromptId).toBe("j")
		expect(screen.queryByRole("alertdialog")).toBeNull()
		expect(sdkCancel).not.toHaveBeenCalled()
	})
})

// A dropped directory adds a row per file up front, and every progress tick re-renders the screen.
describe("TransfersScreen — a large batch", () => {
	it("mounts only the rows in view, not one per transfer", () => {
		mockListViewport()
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

// Rows go by state (active, queued, paused, failed, done), each state in start order; a row that changes state moves at
// once, sliding from where it stood unless the user asked for reduced motion.
describe("TransfersScreen — order by state", () => {
	const ROW_HEIGHT = 58

	function rowNames(container: HTMLElement): string[] {
		return [...container.querySelectorAll("li[aria-label]")].map(row => row.getAttribute("aria-label") ?? "")
	}

	// jsdom lays nothing out: each row stands one row height below the one before it.
	function mockRowOffsets(): void {
		const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")

		Object.defineProperty(HTMLElement.prototype, "offsetTop", {
			configurable: true,
			get(this: HTMLElement) {
				return [...document.querySelectorAll("[data-order-id]")].indexOf(this) * ROW_HEIGHT
			}
		})
		onTestFinished(() => {
			if (original === undefined) {
				Reflect.deleteProperty(HTMLElement.prototype, "offsetTop")
			} else {
				Object.defineProperty(HTMLElement.prototype, "offsetTop", original)
			}
		})
	}

	function mockAnimate(): ReturnType<typeof vi.fn> {
		const animate = vi.fn()

		Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: animate })
		onTestFinished(() => {
			Reflect.deleteProperty(HTMLElement.prototype, "animate")
		})

		return animate
	}

	function mockReducedMotion(reduced: boolean): void {
		vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce") }))
		onTestFinished(() => {
			vi.unstubAllGlobals()
		})
	}

	const ROWS = [
		transfer({ id: "done", name: "done.txt", status: "done", startedAt: 1 }),
		transfer({ id: "moving", name: "moving.txt", status: "uploading", startedAt: 2 }),
		transfer({ id: "paused", name: "paused.txt", status: "uploading", paused: true, startedAt: 3 }),
		transfer({ id: "failed", name: "failed.txt", status: "error", startedAt: 4 }),
		transfer({ id: "waiting", name: "waiting.txt", status: "downloading", waitingForSlot: true, startedAt: 5 }),
		transfer({ id: "second", name: "second.txt", status: "downloading", startedAt: 6 })
	]

	it("lists active, queued, paused, failed then done, each in start order", () => {
		mockListViewport()
		useTransfersStore.setState({ transfers: ROWS })

		const { container } = render(createElement(TransfersScreen))

		expect(rowNames(container)).toEqual(["moving.txt", "second.txt", "waiting.txt", "paused.txt", "failed.txt", "done.txt"])
	})

	it("does not reorder or animate on a progress tick", () => {
		mockListViewport()
		mockRowOffsets()
		mockReducedMotion(false)

		const animate = mockAnimate()

		useTransfersStore.setState({ transfers: ROWS })

		const { container } = render(createElement(TransfersScreen))
		const before = rowNames(container)

		act(() => {
			useTransfersStore.getState().setProgress("moving", 60)
			useTransfersStore.getState().setProgress("second", 30)
		})

		expect(rowNames(container)).toEqual(before)
		expect(animate).not.toHaveBeenCalled()
	})

	it("moves a row that changes state at once, sliding only that row from where it stood", () => {
		mockListViewport()
		mockRowOffsets()
		mockReducedMotion(false)

		const animate = mockAnimate()

		useTransfersStore.setState({ transfers: ROWS })

		const { container } = render(createElement(TransfersScreen))

		act(() => {
			useTransfersStore.getState().setPaused("moving", true)
		})

		expect(rowNames(container)).toEqual(["second.txt", "waiting.txt", "moving.txt", "paused.txt", "failed.txt", "done.txt"])
		expect(animate).toHaveBeenCalledTimes(1)
		expect(animate.mock.contexts[0]).toBe(container.querySelector('li[aria-label="moving.txt"]'))
		// From the top row down to the third: it starts two rows up.
		expect(animate.mock.calls[0]?.[0]).toEqual([{ transform: `translate(0px, ${String(-2 * ROW_HEIGHT)}px)` }, { transform: "none" }])
	})

	it("moves the row without sliding it under reduced motion", () => {
		mockListViewport()
		mockRowOffsets()
		mockReducedMotion(true)

		const animate = mockAnimate()

		useTransfersStore.setState({ transfers: ROWS })

		const { container } = render(createElement(TransfersScreen))

		act(() => {
			useTransfersStore.getState().settle("moving", "done")
		})

		expect(rowNames(container)).toEqual(["second.txt", "waiting.txt", "paused.txt", "failed.txt", "done.txt", "moving.txt"])
		expect(animate).not.toHaveBeenCalled()
	})
})
