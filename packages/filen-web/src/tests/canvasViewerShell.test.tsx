// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { CanvasViewerShell } from "@/features/preview/components/canvasViewerShell"
import {
	backingSize,
	coalesceInput,
	nextDisplay,
	type CanvasInput,
	type ShellToWorker
} from "@/features/preview/components/canvasViewerShell.logic"
import "@/lib/i18n"

// The worker's side is a fake port: the test reads what the shell posts and answers as a worker would.
class FakePort {
	public readonly sent: ShellToWorker[] = []
	public onmessage: ((event: MessageEvent) => void) | null = null
	public readonly close = vi.fn()

	public postMessage(message: ShellToWorker): void {
		this.sent.push(message)
	}

	public answer(data: unknown): void {
		act(() => {
			this.onmessage?.({ data } as MessageEvent)
		})
	}

	public ofType<T extends ShellToWorker["type"]>(type: T): Extract<ShellToWorker, { type: T }>[] {
		return this.sent.filter((message): message is Extract<ShellToWorker, { type: T }> => message.type === type)
	}
}

let ports: FakePort[] = []
let frames: FrameRequestCallback[] = []

function runFrames(): void {
	act(() => {
		for (const callback of frames.splice(0)) {
			callback(0)
		}
	})
}

beforeEach(() => {
	ports = []
	frames = []
	vi.stubGlobal(
		"MessageChannel",
		class {
			public readonly port1 = new FakePort()
			public readonly port2 = { worker: true }

			public constructor() {
				ports.push(this.port1)
			}
		}
	)
	vi.stubGlobal(
		"ResizeObserver",
		class {
			public observe(): void {
				// sizes are read on demand
			}

			public disconnect(): void {
				// nothing held
			}
		}
	)
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback))
	vi.stubGlobal("cancelAnimationFrame", vi.fn())
	HTMLCanvasElement.prototype.transferControlToOffscreen = function transfer() {
		return { offscreenOf: this } as unknown as OffscreenCanvas
	}
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

function shell(session = 1, extra: Partial<Parameters<typeof CanvasViewerShell>[0]> = {}) {
	const connect = vi.fn()
	const onReload = vi.fn()
	const element = (value: number) => (
		<CanvasViewerShell
			session={value}
			connect={connect}
			label="Model"
			onReload={onReload}
			{...extra}
		/>
	)
	const view = render(element(session))

	return {
		connect,
		onReload,
		rerender: (value: number) => {
			view.rerender(element(value))
		},
		view
	}
}

describe("CanvasViewerShell", () => {
	it("hands the worker its port, then the canvas over it", () => {
		const { connect } = shell()

		expect(connect).toHaveBeenCalledWith({ worker: true })
		expect(ports[0]?.ofType("canvas")).toHaveLength(1)
		expect(ports[0]?.ofType("canvas")[0]).toMatchObject({ hidden: false, width: 1, height: 1 })
		expect(screen.getByLabelText("Model").tagName).toBe("CANVAS")
	})

	it("mints a fresh canvas and port for a new worker session", () => {
		const { connect, rerender } = shell(1)
		const first = screen.getByLabelText("Model")

		rerender(2)

		expect(first.isConnected).toBe(false)
		expect(screen.getByLabelText("Model")).not.toBe(first)
		expect(ports[0]?.close).toHaveBeenCalledTimes(1)
		expect(ports[1]?.ofType("canvas")).toHaveLength(1)
		expect(connect).toHaveBeenCalledTimes(2)
	})

	it("shows the reset while the context is lost and hides it once restored", () => {
		shell()

		ports[0]?.answer({ type: "contextLost" })
		expect(screen.getByText("Display reset — restoring…")).toBeTruthy()

		ports[0]?.answer({ type: "contextRestored" })
		expect(screen.queryByText("Display reset — restoring…")).toBeNull()
	})

	it("gives the same worker a fresh canvas when the context does not come back, then the failed card", () => {
		vi.useFakeTimers()

		const { onReload } = shell()
		const first = screen.getByLabelText("Model")

		ports[0]?.answer({ type: "contextLost" })
		act(() => {
			vi.advanceTimersByTime(5000)
		})

		expect(ports).toHaveLength(1)
		expect(ports[0]?.ofType("canvas")).toHaveLength(2)
		expect(screen.getByLabelText("Model")).not.toBe(first)
		expect(screen.getByText("Display reset — restoring…")).toBeTruthy()

		act(() => {
			vi.advanceTimersByTime(5000)
		})

		// No Download: this host offers none.
		expect(screen.queryByRole("button", { name: /download/i })).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Reload viewer" }))
		expect(onReload).toHaveBeenCalledTimes(1)
	})

	it("fails at once when the worker cannot build a renderer on the fresh canvas", () => {
		shell()

		ports[0]?.answer({ type: "contextFailed" })

		expect(screen.getByRole("button", { name: "Reload viewer" })).toBeTruthy()
	})

	it("posts input once per frame, moves coalesced", () => {
		shell()

		const canvas = screen.getByLabelText("Model")

		canvas.setPointerCapture = vi.fn()
		fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 1, clientY: 1 })
		fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 2, clientY: 2 })
		fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 3, clientY: 3 })
		runFrames()

		const inputs = ports[0]?.ofType("input") ?? []

		expect(inputs).toHaveLength(1)
		expect(inputs[0]?.events.map(event => (event.type === "pointer" ? event.phase : event.type))).toEqual(["down", "move"])
	})

	it("keeps arrow keys from the pager while the canvas has focus, and lets the rest through", () => {
		shell()

		const canvas = screen.getByLabelText("Model")
		const seen = vi.fn()

		document.addEventListener("keydown", seen)
		fireEvent.keyDown(canvas, { key: "ArrowLeft" })
		fireEvent.keyDown(canvas, { key: "Escape" })
		document.removeEventListener("keydown", seen)

		expect(seen).toHaveBeenCalledTimes(1)
		expect((seen.mock.calls[0]?.[0] as KeyboardEvent).key).toBe("Escape")
	})

	it("forwards the worker's status and notices", () => {
		const onStatus = vi.fn()
		const onNotice = vi.fn()

		shell(1, { onStatus, onNotice })
		ports[0]?.answer({ type: "status", status: "ready" })
		ports[0]?.answer({ type: "notice", notice: { missing: 2 } })

		expect(onStatus).toHaveBeenCalledWith("ready")
		expect(onNotice).toHaveBeenCalledWith({ missing: 2 })
	})

	it("renders its toolbar, notice and side-panel slots", () => {
		shell(1, { toolbar: <button type="button">Fit</button>, notice: <span>2 missing</span>, sidePanel: <p>Info</p> })

		expect(screen.getByRole("button", { name: "Fit" })).toBeTruthy()
		expect(screen.getByText("2 missing")).toBeTruthy()
		expect(screen.getByText("Info")).toBeTruthy()
	})
})

describe("backingSize", () => {
	it("caps the pixel ratio at 2 and each side at the texture limit, keeping the aspect", () => {
		expect(backingSize(500, 250, 3, null)).toEqual({ width: 1000, height: 500, pixelRatio: 2 })
		expect(backingSize(4000, 1000, 2, null)).toEqual({ width: 4096, height: 1024, pixelRatio: 1.024 })
		expect(backingSize(4000, 1000, 1, 2048)).toEqual({ width: 2048, height: 512, pixelRatio: 0.512 })
		expect(backingSize(0, 0, 1, null)).toEqual({ width: 1, height: 1, pixelRatio: 1 })
	})
})

describe("coalesceInput", () => {
	it("keeps the latest move of a pointer and sums wheel turns, never dropping presses", () => {
		const queue: CanvasInput[] = []
		const move = (x: number) => ({ type: "pointer", phase: "move", id: 1, pointerType: "mouse", x, y: 0, buttons: 1 }) as const
		const wheel = (deltaY: number) => ({ type: "wheel", x: 0, y: 0, deltaX: 0, deltaY, ctrlKey: false }) as const

		coalesceInput(queue, move(1))
		coalesceInput(queue, move(2))
		coalesceInput(queue, { ...move(3), phase: "up" })
		coalesceInput(queue, wheel(5))
		coalesceInput(queue, wheel(7))

		expect(queue).toEqual([move(2), { ...move(3), phase: "up" }, wheel(12)])
	})
})

describe("nextDisplay", () => {
	it("walks loss, replacement and failure", () => {
		expect(nextDisplay("live", "lost")).toBe("restoring")
		expect(nextDisplay("restoring", "timeout")).toBe("replacing")
		expect(nextDisplay("replacing", "restored")).toBe("live")
		expect(nextDisplay("replacing", "timeout")).toBe("failed")
		expect(nextDisplay("live", "failed")).toBe("failed")
		expect(nextDisplay("failed", "restored")).toBe("failed")
		expect(nextDisplay("live", "timeout")).toBe("live")
	})
})
