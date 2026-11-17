import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { serveTextWorker } from "@filen/office/dom/sheet/text"
import type { SheetEvent } from "@filen/office/core/sheet"

// The sheet workers, in-process: a page side that talks like a Worker, wired to the real worker entry's server.
const { workers } = vi.hoisted(() => ({ workers: [] as { terminated: boolean; fail: () => void }[] }))

class FakeWorker {
	terminated = false
	private readonly page = new Set<(event: { data?: unknown; message?: string }) => void>()
	private readonly errors = new Set<(event: { message?: string }) => void>()
	private server: ((data: unknown) => void) | null = null

	constructor() {
		serveTextWorker({
			post: message => {
				setTimeout(() => {
					for (const listener of this.page) listener({ data: message })
				}, 0)
			},
			listen: onMessage => {
				this.server = onMessage
			}
		})
		workers.push(this)
	}

	postMessage(message: unknown): void {
		setTimeout(() => this.server?.(message), 0)
	}

	addEventListener(type: "message" | "error", listener: (event: { data?: unknown; message?: string }) => void): void {
		if (type === "message") this.page.add(listener)
		else this.errors.add(listener)
	}

	terminate(): void {
		this.terminated = true
	}

	fail(): void {
		for (const listener of this.errors) listener({ message: "worker died" })
	}
}

vi.mock("@/features/spreadsheet/workers/sheetText.worker.ts?worker", () => ({ default: FakeWorker }))
vi.mock("@/features/spreadsheet/workers/sheetWorkbook.worker.ts?worker", () => ({ default: FakeWorker }))
vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild: vi.fn() }))

// The module graph's first load (its transform: @filen/office's sheet host and text worker from source) happens here,
// while the file is collected, where no hook timeout applies. Under a full parallel run that load waits on the shared
// transform with every other file: in the first beforeEach it overran the 10 s hook timeout, and the next test's
// resetModules then raced the import still in flight, failing it too. Each beforeEach below only evaluates the
// already-transformed graph again (milliseconds), for a fresh worker pool per test.
let { openSheet } = await import("@/features/spreadsheet/lib/sheetHosts")

function csv(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

async function opened(text: string, events: SheetEvent[] = []) {
	const result = await openSheet(csv(text), { kind: "csv" }, event => events.push(event))

	if (result.kind !== "opened") throw new Error(`not opened: ${result.kind}`)

	return result
}

describe("sheet worker hosts", () => {
	// A fresh module per test: its worker pool is module state.
	beforeEach(async () => {
		workers.length = 0
		vi.resetModules()
		;({ openSheet } = await import("@/features/spreadsheet/lib/sheetHosts"))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("opens text files in one worker, held until the last session closes and then a while longer", async () => {
		const first = await opened("a,b\r\n1,2\r\n")
		const second = await opened("x\r\n")

		expect(workers).toHaveLength(1)
		expect(first.info.kind).toBe("csv")

		vi.useFakeTimers()
		first.session.close()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(workers[0]?.terminated).toBe(false)

		second.session.close()
		await vi.advanceTimersByTimeAsync(29_000)
		expect(workers[0]?.terminated).toBe(false)
		await vi.advanceTimersByTimeAsync(2_000)
		expect(workers[0]?.terminated).toBe(true)

		vi.useRealTimers()
		await opened("y\r\n")
		expect(workers).toHaveLength(2)
	})

	it("closing a session twice releases its worker once", async () => {
		const first = await opened("a\r\n")
		const second = await opened("b\r\n")

		vi.useFakeTimers()
		first.session.close()
		first.session.close()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(workers[0]?.terminated).toBe(false)
		second.session.close()
		await vi.advanceTimersByTimeAsync(31_000)
		expect(workers[0]?.terminated).toBe(true)
	})

	it("replaces a worker that died: its sessions hear it failed, the next file gets a new one", async () => {
		const events: SheetEvent[] = []
		const first = await opened("a\r\n", events)

		workers[0]?.fail()
		expect(events.at(-1)).toMatchObject({ type: "failed" })
		await expect(first.session.layout(first.info.activeSheet)).rejects.toThrow()

		const second = await opened("b\r\n")

		expect(workers).toHaveLength(2)
		first.session.close()
		expect(workers[0]?.terminated).toBe(true)
		second.session.close()
	})

	it("answers cells through the worker", async () => {
		const { session, info } = await opened("Name,Qty\r\nApples,3\r\n")
		const { tiles } = await session.tiles(info.activeSheet, Uint32Array.of(0, 0))
		const tile = tiles[0]

		expect(tile?.strings).toEqual(expect.arrayContaining(["Name", "Qty", "Apples", "3"]))
		session.close()
	})

	it("detects a text file's separator as the browser's locale breaks a tie, as the grid then reads it", async () => {
		const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE"])

		try {
			const { session, info } = await opened("1,5;2,5\r\n3,25;4,75\r\n")
			const { tiles } = await session.tiles(info.activeSheet, Uint32Array.of(0, 0))

			expect(tiles[0]?.strings).toEqual(expect.arrayContaining(["1,5", "2,5", "3,25", "4,75"]))
			session.close()
		} finally {
			languages.mockRestore()
		}
	})
})
