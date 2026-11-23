// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import type { PagerOpen, PagerRowView, PagerRows } from "@/features/preview/workers/textPager.worker"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import { PreviewByteOriginProvider } from "@/features/preview/lib/accessMode"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"

// The large text viewer's lifecycle: the bar (size, position, encoding, read-only) over the rows the worker lays out,
// the error state with Try again when a read fails (a lost port), one range source per attempt that unmounting closes,
// and the too-large card for an archive entry decoded only whole.

const MIB = 1024 * 1024
const SIZE = 40 * MIB

interface State {
	opens: number
	closes: number
	failLocate: boolean
	// The open's port-lost callback.
	lost: (() => void) | null
	open: PagerOpen
}

const state = vi.hoisted((): State => ({
	opens: 0,
	closes: 0,
	failLocate: false,
	lost: null,
	open: { text: true, executable: false, unicode: "utf-8", head: null }
}))

// The open a test that swaps state.open gets back after it.
const defaultOpen = state.open

function row(start: number, text: string, line: number | null): PagerRowView {
	return { start, end: start + text.length + 1, text, continuation: false, breaks: true, line }
}

const remote = vi.hoisted(() => ({
	open: (_port: MessagePort, _size: number, onLost: () => void) => {
		state.lost = onLost

		return Promise.resolve(state.open)
	},
	use: () => Promise.resolve({ start: 0 }),
	locate: (): Promise<PagerRows> =>
		state.failLocate
			? Promise.reject(new Error("range port closed"))
			: Promise.resolve({ rows: [row(0, "first line", null), row(11, "second line", null)], focus: 0, column: 0 }),
	after: () => Promise.resolve([]),
	lineOf: () => Promise.resolve({ line: 1, frontier: 100 }),
	before: () => Promise.resolve([]),
	lines: () => Promise.resolve({ lines: 1, complete: false, frontier: 0 }),
	stop: () => Promise.resolve(),
	// Scans settle when a test says so.
	countLines: () => scans.count.promise,
	lineStart: () => scans.lineStart.promise,
	search: (_query: string, _caseSensitive: boolean, _from: number, onProgress: (at: number, count: number, first: number) => void) => {
		scans.searchProgress = onProgress

		return scans.search.promise
	},
	match: () => Promise.resolve({ offset: 11, line: 2 })
}))

const scans = vi.hoisted(() => ({
	count: Promise.withResolvers<{ lines: number; complete: boolean; frontier: number }>(),
	lineStart: Promise.withResolvers<number | null>(),
	search: Promise.withResolvers<{ lines: number; complete: boolean; frontier: number; end: string; count: number; first: number }>(),
	searchProgress: null as ((at: number, count: number, first: number) => void) | null
}))

// One worker per key, as useOwnedWorker starts a new one for a new key (a retry's).
const workers = vi.hoisted(() => new Map<string, object>())

vi.mock("@/lib/workers/ownedWorker", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/workers/ownedWorker")>()),
	useOwnedWorker: (_create: unknown, key: string) => {
		let worker = workers.get(key)

		if (worker === undefined) {
			worker = { status: "ready", generation: workers.size + 1, owned: { run: (call: (api: unknown) => unknown) => call(remote) } }
			workers.set(key, worker)
		}

		return worker
	}
}))
const guesses = vi.hoisted(() => ({ calls: 0 }))

vi.mock("@/features/preview/lib/encodingGuess", () => ({
	guessLegacyEncoding: () => {
		guesses.calls++

		return Promise.resolve("windows-1251")
	}
}))
vi.mock("@/features/preview/workers/textPager.worker.ts?worker", () => ({ default: vi.fn() }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { cancelPreviewDownload: () => Promise.resolve() } }))
vi.mock("@/features/preview/lib/origin/rangeSource", () => ({
	openOriginPorts: () => {
		state.opens++

		return {
			size: SIZE,
			port: () => Promise.resolve(new MessageChannel().port1),
			close: () => {
				state.closes++
			}
		}
	}
}))

beforeAll(async () => {
	const { PREVIEW_ACTIONS } = await import("@/features/preview/lib/keymap")
	const { registerAction } = await import("@/lib/keymap/registry")

	for (const def of PREVIEW_ACTIONS) registerAction(def)

	await import("@/features/preview/components/largeTextViewer")
}, 30_000)

afterEach(() => {
	cleanup()
	scans.count = Promise.withResolvers()
	scans.lineStart = Promise.withResolvers()
	scans.search = Promise.withResolvers()
	scans.searchProgress = null
	workers.clear()
	state.failLocate = false
	state.opens = 0
	state.closes = 0
	state.open = defaultOpen
	guesses.calls = 0
})

async function renderViewer(origin?: ByteOrigin) {
	const { LargeTextViewer } = await import("@/features/preview/components/largeTextViewer")
	const item = linkedFileItem("server.log", { size: BigInt(SIZE) })
	const viewer = (
		<LargeTextViewer
			item={item}
			alt="server.log"
		/>
	)

	return render(origin === undefined ? viewer : <PreviewByteOriginProvider origin={origin}>{viewer}</PreviewByteOriginProvider>)
}

describe("LargeTextViewer", () => {
	it("shows the bar and the rows, read-only", async () => {
		await renderViewer()

		expect(await screen.findByText("first line")).toBeTruthy()
		expect(screen.getByText("second line")).toBeTruthy()
		expect(screen.getByText("Read-only")).toBeTruthy()
		expect(screen.getByText("0%")).toBeTruthy()
		expect(screen.getByRole("button", { name: /Encoding: UTF-8/ })).toBeTruthy()
		expect(screen.getByRole("document", { name: "server.log" })).toBeTruthy()
		expect(state.opens).toBe(1)
	})

	it("shows the error state when a read fails, and Try again opens a new source", async () => {
		state.failLocate = true
		await renderViewer()

		const retry = await screen.findByRole("button", { name: "Try again" })

		state.failLocate = false
		await act(async () => {
			fireEvent.click(retry)
			await Promise.resolve()
		})

		expect(await screen.findByText("first line")).toBeTruthy()
		expect(state.opens).toBe(2)
		// The first attempt's source is closed with it.
		expect(state.closes).toBe(1)
	})

	it("shows the error state as soon as an idle view's port is lost", async () => {
		await renderViewer()
		await screen.findByText("first line")
		act(() => {
			state.lost?.()
		})

		expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy()
	})

	it("closes its range source when it unmounts", async () => {
		const view = await renderViewer()

		await screen.findByText("first line")
		view.unmount()
		expect(state.closes).toBe(1)
	})

	it("reads an archive entry the SDK worker holds whole in ranges, and refuses one past what it holds", async () => {
		const entry = { kind: "entry", reader: "r", entry: 0 as never, access: "whole", anon: false, cacheKey: "a#0" } as const

		await renderViewer({ ...entry, size: SIZE })
		expect(await screen.findByText("first line")).toBeTruthy()
		cleanup()

		await renderViewer({ ...entry, size: 300 * MIB })
		expect(await screen.findByText("This file is too large to show as text.")).toBeTruthy()
		expect(state.opens).toBe(1)
	})

	it("reads held bytes (an attachment) in ranges", async () => {
		await renderViewer({ kind: "bytes", blob: new Blob(["x"]), cacheKey: "mail#att0" })

		expect(await screen.findByText("first line")).toBeTruthy()
	})

	it("keeps a go to line's progress when the count it cut short ends", async () => {
		await renderViewer()
		await screen.findByText("first line")
		fireEvent.click(screen.getByRole("button", { name: "Count lines" }))
		expect(await screen.findByText(/^Counting lines…/)).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Go to line" }))
		fireEvent.change(await screen.findByRole("textbox", { name: "Go to line" }), { target: { value: "5" } })
		fireEvent.click(screen.getByRole("button", { name: "Go" }))

		// The worker stops the count for the go to line; the count's end must not clear the go to line's progress.
		await act(async () => {
			scans.count.resolve({ lines: 3, complete: false, frontier: 100 })
			await Promise.resolve()
		})
		expect(screen.getByText(/^Counting lines…/)).toBeTruthy()
		expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy()

		await act(async () => {
			scans.lineStart.resolve(11)
			await Promise.resolve()
		})
		expect(screen.queryByText(/^Counting lines…/)).toBeNull()
	})

	it("shows a search cut short as partial, not as every match", async () => {
		await renderViewer()
		await screen.findByText("first line")
		fireEvent.click(screen.getByRole("button", { name: "Find" }))
		fireEvent.change(await screen.findByRole("searchbox", { name: "Find" }), { target: { value: "line" } })
		await screen.findByText(/^Searching/, undefined, { timeout: 2000 })

		await act(async () => {
			scans.search.resolve({ lines: 2, complete: false, frontier: 100, end: "stopped", count: 4, first: 0 })
			await Promise.resolve()
		})
		expect(await screen.findByText("1/4+")).toBeTruthy()
	})

	it("ignores a search's progress that arrives after its result", async () => {
		await renderViewer()
		await screen.findByText("first line")
		fireEvent.click(screen.getByRole("button", { name: "Find" }))
		fireEvent.change(await screen.findByRole("searchbox", { name: "Find" }), { target: { value: "line" } })
		await screen.findByText(/^Searching/, undefined, { timeout: 2000 })

		await act(async () => {
			scans.search.resolve({ lines: 2, complete: true, frontier: 100, end: "done", count: 4, first: 0 })
			await Promise.resolve()
		})
		expect(await screen.findByText("1/4")).toBeTruthy()

		// The callback's own port keeps no order with the result's: its report comes in last.
		await act(async () => {
			scans.searchProgress?.(50, 2, 0)
			await Promise.resolve()
		})
		expect(screen.getByText("1/4")).toBeTruthy()
		expect(screen.queryByText(/^Searching/)).toBeNull()
	})

	it("guesses a legacy file's encoding once, from the first block's copy", async () => {
		state.open = { text: true, executable: false, unicode: null, head: new Uint8Array([0xcf, 0xf0, 0xe8]) }
		await renderViewer()

		expect(await screen.findByText("first line")).toBeTruthy()
		expect(screen.getByRole("button", { name: /Encoding: Windows-1251/ })).toBeTruthy()
		expect(guesses.calls).toBe(1)
	})
})
