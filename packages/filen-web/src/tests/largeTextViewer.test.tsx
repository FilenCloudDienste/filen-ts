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
	before: () => Promise.resolve([]),
	lines: () => Promise.resolve({ lines: 1, complete: false, frontier: 0 }),
	stop: () => Promise.resolve()
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
vi.mock("@/features/preview/workers/textPager.worker.ts?worker", () => ({ default: vi.fn() }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { cancelPreviewDownload: () => Promise.resolve() } }))
vi.mock("@/features/preview/lib/origin/rangeSource", () => ({
	openOriginRangeSource: () => {
		state.opens++

		return Promise.resolve({
			size: SIZE,
			reader: {},
			port: () => Promise.resolve(new MessageChannel().port1),
			close: () => {
				state.closes++
			}
		})
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
	workers.clear()
	state.failLocate = false
	state.opens = 0
	state.closes = 0
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

	it("refuses an archive entry its reader can only decode whole", async () => {
		await renderViewer({ kind: "entry", reader: "r", entry: 0 as never, size: SIZE, access: "whole", anon: false, cacheKey: "a#0" })

		expect(await screen.findByText("This file is too large to show as text.")).toBeTruthy()
		expect(state.opens).toBe(0)
	})
})
