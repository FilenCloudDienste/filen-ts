// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { StrictMode, createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"

const { wrap, recoverIfNewerBuild } = vi.hoisted(() => ({ wrap: vi.fn(), recoverIfNewerBuild: vi.fn() }))

vi.mock("comlink", async importOriginal => ({ ...(await importOriginal<typeof import("comlink")>()), wrap }))
vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild }))

const { releaseProxy } = await import("comlink")
const { useOwnedWorker, releaseAllPreviewWorkers } = await import("@/lib/workers/ownedWorker")

class FakeWorker extends EventTarget {
	public readonly terminate = vi.fn()
}

const workers: FakeWorker[] = []

function create(): Worker {
	const worker = new FakeWorker()

	workers.push(worker)

	return worker as unknown as Worker
}

wrap.mockImplementation(() => ({ [releaseProxy]: vi.fn() }))

function strict({ children }: { children: ReactNode }) {
	return createElement(StrictMode, null, children)
}

afterEach(() => {
	releaseAllPreviewWorkers()
	workers.length = 0
})

describe("useOwnedWorker", () => {
	// Whether the test renderer double-runs effects or not, every worker but the one left ready is terminated.
	it("under StrictMode, one worker is left ready and every other is terminated", async () => {
		const { result, unmount } = renderHook(() => useOwnedWorker(create, "file-a", "geo"), { wrapper: strict })

		await waitFor(() => {
			expect(result.current.status).toBe("ready")
		})

		const live = workers.filter(worker => worker.terminate.mock.calls.length === 0)

		expect(live).toHaveLength(1)
		expect(workers.every(worker => worker.terminate.mock.calls.length <= 1)).toBe(true)

		unmount()

		expect(live[0]?.terminate).toHaveBeenCalledTimes(1)
	})

	it("a remount (StrictMode's double run) terminates the first worker and recreates", async () => {
		const first = renderHook(() => useOwnedWorker(create, "a", "geo"))

		await waitFor(() => {
			expect(first.result.current.status).toBe("ready")
		})
		first.unmount()

		const second = renderHook(() => useOwnedWorker(create, "a", "geo"))

		await waitFor(() => {
			expect(second.result.current.status).toBe("ready")
		})
		expect(workers[0]?.terminate).toHaveBeenCalledTimes(1)
		expect(workers[1]?.terminate).not.toHaveBeenCalled()
		second.unmount()
	})

	it("a new key terminates the old worker and is starting until the new one is published", async () => {
		const { result, rerender } = renderHook(({ key }) => useOwnedWorker(create, key, "geo"), { initialProps: { key: "a" } })

		await waitFor(() => {
			expect(result.current.status).toBe("ready")
		})

		rerender({ key: "b" })

		expect(result.current.status).toBe("starting")
		expect(workers[0]?.terminate).toHaveBeenCalledTimes(1)

		await waitFor(() => {
			expect(result.current).toMatchObject({ status: "ready", generation: 2 })
		})
	})

	it("reports a failure and restarts on request", async () => {
		const { result } = renderHook(() => useOwnedWorker(create, "a", "geo"))

		await waitFor(() => {
			expect(result.current.status).toBe("ready")
		})

		act(() => {
			workers[0]?.dispatchEvent(new Event("error"))
		})

		await waitFor(() => {
			expect(result.current.status).toBe("failed")
		})

		const failed = result.current

		act(() => {
			if (failed.status === "failed") {
				failed.restart()
			}
		})

		await waitFor(() => {
			expect(result.current).toMatchObject({ status: "ready", generation: 2 })
		})
		expect(workers).toHaveLength(2)
	})
})
