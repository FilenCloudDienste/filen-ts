// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { File, UuidStr } from "@filen/sdk-rs"
import type { DesktopBridge, DesktopDragOutcome, DesktopDragPrepared, DesktopDragState } from "@filen/shared/desktop"
import { narrowItem } from "@/features/drive/lib/item"
import {
	cancelPointerDrag,
	pointerDragChip,
	pressPointerDrag,
	registerDropTarget,
	setPointerDragHooks,
	type DropTargetHandlers
} from "@/features/drive/lib/pointerDrag"

const { toast, startNativeDownloads } = vi.hoisted(() => ({
	toast: vi.fn(),
	startNativeDownloads: vi.fn((_items: unknown[], _options?: { ask?: boolean }) => Promise.resolve())
}))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/features/transfers/lib/nativeHost", () => ({ startNativeDownloads }))
vi.mock("@/features/transfers/lib/nativeTransfers.logic", () => ({
	downloadItemOf: (item: { data: { uuid: string } }) => ({ uuid: item.data.uuid })
}))

import { dragOutActive, installDragOut } from "@/features/drive/lib/dragOut"
import { isFileDrag } from "@/features/drive/lib/uploadDrop"
import { onlineManager } from "@tanstack/react-query"

const ITEM = narrowItem({
	uuid: "report-0000-0000-0000-000000000000" as UuidStr,
	stableUUID: undefined,
	parent: "home-0000-0000-0000-000000000000" as UuidStr,
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "report.txt", mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
} satisfies File)

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

interface Deferred<T> {
	promise: Promise<T>
	resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => undefined
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

function fakeDrag() {
	const listeners = new Set<(state: DesktopDragState) => void>()
	const prepares: Deferred<DesktopDragPrepared>[] = []
	const begins: Deferred<DesktopDragOutcome>[] = []
	const calls: string[] = []
	const drag = {
		prepare: vi.fn(() => {
			calls.push("prepare")

			const next = deferred<DesktopDragPrepared>()

			prepares.push(next)

			return next.promise
		}),
		begin: vi.fn(() => {
			const next = deferred<DesktopDragOutcome>()

			begins.push(next)

			return next.promise
		}),
		release: vi.fn(),
		onState: vi.fn((callback: (state: DesktopDragState) => void) => {
			calls.push("onState")
			listeners.add(callback)

			return () => {
				listeners.delete(callback)
			}
		})
	} satisfies DesktopBridge["drag"]

	return {
		drag,
		calls,
		prepares,
		begins,
		emit: (state: DesktopDragState) => {
			for (const listener of listeners) {
				listener(state)
			}
		}
	}
}

function chip(): HTMLCanvasElement {
	const canvas = document.createElement("canvas")

	canvas.width = 120
	canvas.height = 60
	canvas.style.width = "60px"
	canvas.style.height = "30px"
	canvas.toBlob = callback => {
		callback(new Blob([PNG], { type: "image/png" }))
	}

	return canvas
}

const end = vi.fn()

function press(): void {
	pressPointerDrag(
		{ pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true, clientX: 10, clientY: 10, altKey: false, ctrlKey: false },
		{ start: () => [ITEM], chip, end }
	)
}

function move(x: number, y: number, buttons = 1): void {
	window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: x, clientY: y, buttons }))
}

function up(x: number, y: number): void {
	window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: x, clientY: y, buttons: 0 }))
}

// Lets the bridge's promises and the chip's encoding settle.
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise(resolve => {
			setTimeout(resolve, 0)
		})
	}
}

function target(): { element: HTMLElement; handlers: DropTargetHandlers } {
	const element = document.createElement("div")
	const handlers = { accepts: vi.fn(() => true), springs: vi.fn(() => false), update: vi.fn(), drop: vi.fn() }

	document.body.appendChild(element)
	cleanups.push(registerDropTarget(element, handlers))

	return { element, handlers }
}

// A drag dragged in from the OS, as the dropzone sees it.
const FILES = { types: ["Files"] } as unknown as DataTransfer

let cleanups: (() => void)[] = []
let hit: Element | null = null

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "Date"] })
	vi.setSystemTime(0)
	document.elementFromPoint = () => hit
	onlineManager.setOnline(true)
})

afterEach(() => {
	cancelPointerDrag()

	for (const cleanup of cleanups) {
		cleanup()
	}

	cleanups = []
	hit = null
	// Past any quiet second a test left behind.
	vi.setSystemTime(60_000)
	document.body.replaceChildren()
	vi.useRealTimers()
})

function install(): ReturnType<typeof fakeDrag> {
	const fake = fakeDrag()

	cleanups.push(installDragOut({ drag: fake.drag }))

	return fake
}

describe("drag-out hand-off", () => {
	it("an in-app drag never calls prepare", () => {
		const fake = install()
		const { element, handlers } = target()

		hit = element
		press()
		move(30, 30)
		move(40, 40)
		up(40, 40)

		expect(handlers.drop).toHaveBeenCalledOnce()
		expect(fake.drag.prepare).not.toHaveBeenCalled()
		expect(fake.drag.release).not.toHaveBeenCalled()
	})

	it("listens for states before it prepares, and prepares once, on the first move outside", () => {
		const fake = install()

		press()
		move(30, 30)
		expect(fake.drag.prepare).not.toHaveBeenCalled()

		move(-5, 30)
		move(-6, 30)
		move(-7, 30)

		expect(fake.drag.prepare).toHaveBeenCalledExactlyOnceWith({ items: [{ uuid: ITEM.data.uuid }] })
		expect(fake.calls).toEqual(["onState", "prepare"])
		expect(dragOutActive()).toBe(true)
	})

	it("returns handedOff as soon as begin is issued", async () => {
		const fake = install()

		press()
		move(-5, 30)
		fake.prepares[0]?.resolve({ id: "d1" })
		await settle()
		expect(fake.drag.begin).not.toHaveBeenCalled()

		move(-6, 30)
		expect(fake.drag.begin).toHaveBeenCalledExactlyOnceWith({ id: "d1", image: { png: PNG, width: 60, height: 30, scale: 2 } })
		// The engine stopped the in-app drag at once: its chip is hidden.
		expect(pointerDragChip()?.style.display).toBe("none")

		fake.begins[0]?.resolve("dropped")
		await settle()
		expect(end).toHaveBeenCalled()
		expect(pointerDragChip()).toBeNull()
		expect(toast).not.toHaveBeenCalled()
	})

	it("does not begin while main is still staging the items", async () => {
		const fake = install()

		press()
		move(-5, 30)
		fake.emit({ id: "d1", state: "staging", bytes: 0, total: 10 })
		fake.prepares[0]?.resolve({ id: "d1" })
		await settle()
		move(-6, 30)
		expect(fake.drag.begin).not.toHaveBeenCalled()

		fake.emit({ id: "d1", state: "ready" })
		move(-7, 30)
		expect(fake.drag.begin).toHaveBeenCalledOnce()
	})

	it("notReady with the button held resumes the in-app drag and retries on the next outside move without a timer", async () => {
		const fake = install()

		press()
		move(-5, 30)
		fake.prepares[0]?.resolve({ id: "d1" })
		await settle()
		move(-6, 30)
		fake.begins[0]?.resolve("notReady")
		await settle()

		expect(pointerDragChip()?.style.display).toBe("")
		vi.advanceTimersToNextFrame()
		expect(vi.getTimerCount()).toBe(0)
		expect(fake.drag.begin).toHaveBeenCalledOnce()

		move(-7, 30)
		expect(fake.drag.begin).toHaveBeenCalledTimes(2)
		expect(fake.drag.prepare).toHaveBeenCalledOnce()
	})

	it("notReady after release shows Still preparing with Download to…", async () => {
		const fake = install()

		press()
		move(-5, 30)
		fake.prepares[0]?.resolve({ id: "d1" })
		await settle()
		move(-6, 30)
		up(-6, 30)
		fake.begins[0]?.resolve("notReady")
		await settle()

		expect(toast).toHaveBeenCalledOnce()
		expect(toast.mock.calls[0]?.[0]).toBe("Still preparing…")
		expect(fake.drag.release).toHaveBeenCalledExactlyOnceWith("d1")
	})

	it("a release outside before the items are ready shows Still preparing and releases the id", async () => {
		const fake = install()

		press()
		move(-5, 30)
		up(-5, 30)
		fake.prepares[0]?.resolve({ id: "d1" })
		await settle()

		expect(toast.mock.calls[0]?.[0]).toBe("Still preparing…")
		expect(fake.drag.release).toHaveBeenCalledExactlyOnceWith("d1")
		expect(fake.drag.begin).not.toHaveBeenCalled()
	})

	it("shows the refusal toast once with Download to…, which asks for a directory", async () => {
		const fake = install()

		press()
		move(-5, 30)
		fake.prepares[0]?.resolve({ refused: { reason: "tooLarge", bytes: 2, limit: 1 } })
		await settle()

		// The in-app drag ended with the refusal.
		expect(pointerDragChip()).toBeNull()
		move(-6, 30)
		expect(fake.drag.prepare).toHaveBeenCalledOnce()
		expect(toast).toHaveBeenCalledOnce()

		const [message, options] = toast.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }]

		expect(message).toBe("Too large to drag out. Use Download to… instead.")
		expect(options.action.label).toBe("Download to…")

		options.action.onClick()
		expect(startNativeDownloads).toHaveBeenCalledExactlyOnceWith([ITEM], { ask: true })
	})

	it("refuses offline without asking main", () => {
		const fake = install()

		onlineManager.setOnline(false)
		press()
		move(-5, 30)

		expect(fake.drag.prepare).not.toHaveBeenCalled()
		expect(toast.mock.calls[0]?.[0]).toBe("You're offline.")
		expect(pointerDragChip()).toBeNull()
	})

	it("a failed begin ends the drag with the unavailable toast", async () => {
		const fake = install()

		press()
		move(-5, 30)
		fake.prepares[0]?.resolve({ id: "d1" })
		await settle()
		move(-6, 30)
		fake.begins[0]?.resolve("failed")
		await settle()

		expect(pointerDragChip()).toBeNull()
		expect(toast.mock.calls[0]?.[0]).toBe("Dragging out isn't available right now.")
	})

	it("releases a prepared id on an in-app drop", async () => {
		const fake = install()
		const { element, handlers } = target()

		press()
		move(-5, 30)
		fake.prepares[0]?.resolve({ id: "d1" })
		await settle()
		hit = element
		move(30, 30)
		up(30, 30)

		expect(handlers.drop).toHaveBeenCalledOnce()
		expect(fake.drag.release).toHaveBeenCalledExactlyOnceWith("d1")
		expect(toast).not.toHaveBeenCalled()
	})

	it("releases an id that arrives after an in-app drop, quietly", async () => {
		const fake = install()
		const { element } = target()

		press()
		move(-5, 30)
		hit = element
		move(30, 30)
		up(30, 30)
		fake.prepares[0]?.resolve({ id: "d1" })
		await settle()

		expect(fake.drag.release).toHaveBeenCalledExactlyOnceWith("d1")
		expect(toast).not.toHaveBeenCalled()
	})

	it("Escape outside cancels quietly", async () => {
		const fake = install()

		press()
		move(-5, 30)
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
		fake.prepares[0]?.resolve({ id: "d1" })
		await settle()

		expect(fake.drag.release).toHaveBeenCalledExactlyOnceWith("d1")
		expect(toast).not.toHaveBeenCalled()
	})

	it("the dropzone, rows and tree ignore OS drops while drag-out is active and for 1 s after", async () => {
		const fake = install()

		expect(isFileDrag(FILES)).toBe(true)
		press()
		move(-5, 30)
		expect(isFileDrag(FILES)).toBe(false)

		fake.prepares[0]?.resolve({ id: "d1" })
		await settle()
		move(-6, 30)
		expect(isFileDrag(FILES)).toBe(false)

		fake.begins[0]?.resolve("cancelled")
		await settle()
		vi.setSystemTime(999)
		expect(isFileDrag(FILES)).toBe(false)

		vi.setSystemTime(1_001)
		expect(isFileDrag(FILES)).toBe(true)
	})

	it("a browser build never touches the bridge: an outside drag stays in the page", () => {
		const fake = fakeDrag()

		setPointerDragHooks(null)
		press()
		move(-5, 30)

		expect(fake.drag.onState).not.toHaveBeenCalled()
		expect(fake.drag.prepare).not.toHaveBeenCalled()
		expect(pointerDragChip()?.style.display).toBe("")
		expect(dragOutActive()).toBe(false)
	})

	it("uninstalling removes the hooks and the state listener", () => {
		const fake = fakeDrag()
		const uninstall = installDragOut({ drag: fake.drag })

		uninstall()
		press()
		move(-5, 30)

		expect(fake.drag.prepare).not.toHaveBeenCalled()
	})
})
