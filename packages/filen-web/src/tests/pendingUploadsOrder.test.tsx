// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import "@/lib/i18n"

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { cancelTransfer: vi.fn(), pauseTransfer: vi.fn(), resumeTransfer: vi.fn() }
}))

const { useTransfersStore } = await import("@/features/transfers/store/useTransfersStore")
const { PendingUploads } = await import("@/features/drive/components/pendingUploads")
const { makeTransfer } = await import("@/tests/fixtures/transfers")

const DIR = "dir-uuid"
const ROW_HEIGHT = 40

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

function renderBlock(): HTMLElement {
	const { container } = render(
		<PendingUploads
			parentUuid={DIR}
			viewMode="list"
			columns={1}
			blockRef={null}
		/>
	)

	return container
}

beforeEach(() => {
	useTransfersStore.setState({ transfers: [], speedSamples: [], rowSpeedSamples: {}, uploadBatches: {}, batchSpeedSamples: {} })

	const run = { id: "run", parentUuid: DIR }
	const store = useTransfersStore.getState()

	store.startUploadBatch(run)

	for (const id of ["a", "b", "c"]) {
		store.add({ ...makeTransfer({ id, name: `${id}.txt`, size: 1_000 }), batch: run })
	}
})

afterEach(() => {
	cleanup()
})

// The listing's pending rows keep the transfers' order: moving, waiting, paused, then failed.
describe("PendingUploads — order by state", () => {
	it("lists paused uploads after the moving ones, and keeps the order across a progress tick", () => {
		mockRowOffsets()
		mockReducedMotion(false)

		const animate = mockAnimate()

		useTransfersStore.getState().setPaused("a", true)

		const container = renderBlock()

		expect(rowNames(container)).toEqual(["b.txt", "c.txt", "a.txt"])

		act(() => {
			useTransfersStore.getState().setProgress("b", 500)
		})

		expect(rowNames(container)).toEqual(["b.txt", "c.txt", "a.txt"])
		expect(animate).not.toHaveBeenCalled()
	})

	it("moves an upload that pauses, sliding only it from where it stood", () => {
		mockRowOffsets()
		mockReducedMotion(false)

		const animate = mockAnimate()
		const container = renderBlock()

		act(() => {
			useTransfersStore.getState().setPaused("a", true)
		})

		expect(rowNames(container)).toEqual(["b.txt", "c.txt", "a.txt"])
		expect(animate).toHaveBeenCalledTimes(1)
		expect(animate.mock.contexts[0]).toBe(container.querySelector('li[aria-label="a.txt"]'))
		expect(animate.mock.calls[0]?.[0]).toEqual([{ transform: `translate(0px, ${String(-2 * ROW_HEIGHT)}px)` }, { transform: "none" }])
	})

	it("moves it without sliding under reduced motion", () => {
		mockRowOffsets()
		mockReducedMotion(true)

		const animate = mockAnimate()
		const container = renderBlock()

		act(() => {
			useTransfersStore.getState().setPaused("a", true)
		})

		expect(rowNames(container)).toEqual(["b.txt", "c.txt", "a.txt"])
		expect(animate).not.toHaveBeenCalled()
	})
})
