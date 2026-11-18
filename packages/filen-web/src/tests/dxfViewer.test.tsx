// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import type { DxfLoad } from "@/features/preview/workers/dxf.worker"
import { linkedFileItem } from "@/tests/fixtures/sdk"

// The CAD viewer's page side: a load that never ends is ended, a display that keeps getting lost restarts the worker a
// limited number of times, and calls to a worker that is gone never reject unhandled.

const { load } = vi.hoisted(() => ({ load: { next: (): Promise<DxfLoad> => new Promise(() => undefined) } }))
const terminated = vi.hoisted(() => ({ count: 0 }))
const owned = vi.hoisted(() => ({
	run: (call: (remote: unknown) => unknown) =>
		call({
			load: () => load.next(),
			// A worker that is gone: what the shell hands it is never taken.
			attach: () => Promise.reject(new Error("worker gone")),
			fit: () => Promise.reject(new Error("worker gone"))
		}),
	terminate: () => {
		terminated.count++
	}
}))

vi.mock("@/lib/workers/ownedWorker", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/workers/ownedWorker")>()),
	// A fresh worker per key, as the hook gives one.
	useOwnedWorker: (_create: unknown, key: string) => worker(key)
}))
vi.mock("@/providers/themeProvider", () => ({ useTheme: () => ({ theme: "light" }), resolveTheme: () => "light" }))
vi.mock("@/features/preview/workers/dxf.worker.ts?worker", () => ({ default: vi.fn() }))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new Uint8Array([1]), refetch: () => undefined })
}))
vi.mock("@/features/preview/components/canvasViewerShell", () => ({
	CanvasViewerShell: ({
		connect,
		onStatus,
		toolbar
	}: {
		connect: (port: MessagePort) => void
		onStatus: (status: "restart") => void
		toolbar?: unknown
	}) => {
		connect(new MessageChannel().port1)

		return (
			<div>
				<button
					onClick={() => {
						onStatus("restart")
					}}
				>
					lose display
				</button>
				{toolbar as never}
			</div>
		)
	}
}))

const workers = new Map<string, object>()

function worker(key: string) {
	let session = workers.get(key)

	if (session === undefined) {
		session = { status: "ready", generation: workers.size + 1, owned: { ...owned } }
		workers.set(key, session)
	}

	return session
}

const READY: DxfLoad = {
	status: "ready",
	layers: [{ name: "0", label: "0", color: "#000000", visible: true }],
	moreLayers: 0,
	missingGlyphs: false,
	skipped: 0
}

beforeAll(async () => {
	await import("@/features/preview/components/dxfViewer")
}, 30_000)

afterEach(() => {
	cleanup()
	vi.useRealTimers()
	workers.clear()
})

async function renderViewer(): Promise<void> {
	const { DxfViewer } = await import("@/features/preview/components/dxfViewer")

	render(<DxfViewer item={linkedFileItem("plan.dxf")} />)
}

describe("DxfViewer", () => {
	it("ends a load still running after its timeout and says the drawing is too complex", async () => {
		const { DXF_LOAD_TIMEOUT_MS } = await import("@/features/preview/components/dxfViewer")
		const pending = Promise.withResolvers<DxfLoad>()

		vi.useFakeTimers()
		load.next = () => pending.promise
		terminated.count = 0
		await renderViewer()
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DXF_LOAD_TIMEOUT_MS)
		})

		expect(terminated.count).toBe(1)

		// The terminated worker's call then rejects.
		await act(async () => {
			pending.reject(new Error("ended"))
			await Promise.resolve()
		})

		expect(screen.getByText("This drawing is too complex to display.")).toBeTruthy()
	})

	it("restarts the worker once for a lost display, then shows the card", async () => {
		const { DXF_MAX_RESTARTS } = await import("@/features/preview/components/dxfViewer")

		load.next = () => Promise.resolve(READY)
		await renderViewer()

		for (let restart = 0; restart < DXF_MAX_RESTARTS; restart++) {
			fireEvent.click(await screen.findByText("lose display"))
		}

		expect(workers.size).toBe(1 + DXF_MAX_RESTARTS)

		fireEvent.click(await screen.findByText("lose display"))

		expect(await screen.findByText("The display couldn't be restored.")).toBeTruthy()
		expect(screen.getByRole("button", { name: "View source" })).toBeTruthy()
		expect(workers.size).toBe(1 + DXF_MAX_RESTARTS)
	})

	it("catches Fit and attach on a worker that is gone", async () => {
		load.next = () => Promise.resolve(READY)
		await renderViewer()

		fireEvent.click(await screen.findByRole("button", { name: "Fit" }))
		// An unhandled rejection would fail the run.
		await act(async () => {
			await Promise.resolve()
		})

		expect(screen.getByRole("button", { name: "Fit" })).toBeTruthy()
	})
})
