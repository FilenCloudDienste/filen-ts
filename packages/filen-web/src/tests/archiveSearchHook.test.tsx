// @vitest-environment jsdom

import { describe, expect, it, onTestFinished, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { createEntryStore, type EntryStore } from "@/features/archive/lib/entryStore"
import type { ListingSnapshot } from "@/features/archive/lib/listingSession"
import { useArchiveSearch } from "@/features/archive/components/useArchiveSearch"
import { ARCHIVE_SEARCH_DEBOUNCE_MS } from "@/features/archive/lib/archiveBrowser.logic"
import { packEntries } from "@/tests/support/archiveEntries"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

// The browser's search over a listing still streaming in: each notification scans only the newcomers,
// and none throws away a scan under way, so results turn up however often the listing notifies.

function snapshotOf(store: EntryStore, version: number): ListingSnapshot {
	return {
		phase: { type: "reading", bytesRead: 0, archiveBytes: 0, entries: store.entryCount, bytesPerSecond: null, etaMs: null },
		store,
		version,
		info: null
	}
}

function streamOf(paths: string[], flushAt: number) {
	const store = createEntryStore()
	const batches = packEntries(paths, flushAt)
	const name = vi.spyOn(store, "name")
	let version = 0

	return {
		store,
		reads: () => name.mock.calls.length,
		// Appends the next batch and returns the snapshot its notification carries.
		next: (): ListingSnapshot => {
			const batch = batches.shift()

			if (batch !== undefined) {
				store.append(batch)
			}

			version += 1

			return snapshotOf(store, version)
		}
	}
}

function render(initial: ListingSnapshot) {
	return renderHook(({ snapshot, query }: { snapshot: ListingSnapshot; query: string }) => useArchiveSearch(snapshot, 0, query), {
		initialProps: { snapshot: initial, query: "hit" }
	})
}

describe("useArchiveSearch", () => {
	it("adds what each notification brings, scanning only that", async () => {
		const stream = streamOf(
			Array.from({ length: 30 }, (_, i) => `file ${String(i)}${i % 5 === 0 ? " hit" : ""}`),
			10
		)
		const hook = render(stream.next())

		await waitFor(() => {
			expect(hook.result.current.shown?.refs).toHaveLength(2)
		})

		hook.rerender({ snapshot: stream.next(), query: "hit" })

		await waitFor(() => {
			expect(hook.result.current.shown?.refs).toHaveLength(4)
		})

		hook.rerender({ snapshot: stream.next(), query: "hit" })

		await waitFor(() => {
			expect(hook.result.current.shown?.refs).toHaveLength(6)
		})

		expect(hook.result.current.pending).toBe(false)
		// 30 names scanned once each; the rest is ordering the six matches.
		expect(stream.reads()).toBeLessThan(30 + 2 * 6 * 6)
	})

	it("never restarts a scan under way, however often the listing notifies", async () => {
		vi.useFakeTimers()
		onTestFinished(() => {
			vi.useRealTimers()
		})

		const total = 40_000
		const stream = streamOf(
			Array.from({ length: total }, (_, i) => (i === total - 1 ? "last hit" : `file ${String(i)}`)),
			total
		)
		const hook = render(stream.next())

		await act(async () => {
			await vi.advanceTimersByTimeAsync(ARCHIVE_SEARCH_DEBOUNCE_MS - 1)
			// The debounce runs out: the scan starts, then yields after 16384 names.
			await vi.advanceTimersToNextTimerAsync()
		})

		expect(stream.reads()).toBeGreaterThan(0)
		expect(stream.reads()).toBeLessThan(total)

		for (let i = 0; i < 5; i++) {
			hook.rerender({ snapshot: stream.next(), query: "hit" })
		}

		await act(async () => {
			await vi.runAllTimersAsync()
		})

		expect(hook.result.current.shown?.refs).toHaveLength(1)
		expect(stream.reads()).toBeLessThan(total + 10)
	})

	it("starts over for a new query", async () => {
		const stream = streamOf(["a hit", "b miss"], 10)
		const snapshot = stream.next()
		const hook = render(snapshot)

		await waitFor(() => {
			expect(hook.result.current.shown?.query).toBe("hit")
		})

		hook.rerender({ snapshot, query: "miss" })

		expect(hook.result.current.pending).toBe(true)

		await waitFor(() => {
			expect(hook.result.current.shown?.query).toBe("miss")
		})

		expect(hook.result.current.shown?.refs).toHaveLength(1)
	})
})
