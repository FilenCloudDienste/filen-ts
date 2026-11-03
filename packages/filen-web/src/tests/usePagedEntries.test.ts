// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type { DesktopSyncEntries, DesktopSyncResult } from "@filen/shared/desktop"
import { SYNC_PAGE_SIZE, usePagedEntries } from "@/features/sync/hooks/usePagedEntries"

afterEach(() => {
	cleanup()
})

function list(from: number, to: number): number[] {
	return Array.from({ length: to - from }, (_, index) => from + index)
}

// A list of `total` numbers, each read deferred until `release` runs.
function source(total: number, offsetBy = 0) {
	const pending: (() => void)[] = []
	const load = vi.fn(
		(offset: number, limit: number) =>
			new Promise<DesktopSyncResult<DesktopSyncEntries<number>>>(resolve => {
				pending.push(() => {
					resolve({ ok: true, value: { total, entries: list(offset, Math.min(total, offset + limit)).map(n => n + offsetBy) } })
				})
			})
	)

	return {
		load,
		release: async () => {
			await act(async () => {
				pending.splice(0).forEach(run => {
					run()
				})
				await Promise.resolve()
			})
		}
	}
}

describe("usePagedEntries", () => {
	it("reads a new version again as far as it was loaded, keeping the old entries until it lands", async () => {
		const first = source(250)
		const { result, rerender } = renderHook(({ version, load }) => usePagedEntries("k", load, version), {
			initialProps: { version: "1", load: first.load }
		})

		await first.release()
		act(() => {
			result.current.loadMore()
		})
		await first.release()
		expect(result.current.entries).toHaveLength(2 * SYNC_PAGE_SIZE)

		const second = source(250, 1000)

		rerender({ version: "2", load: second.load })
		expect(result.current.loading).toBe(false)
		expect(result.current.version).toBe("1")
		expect(result.current.entries).toHaveLength(2 * SYNC_PAGE_SIZE)

		await second.release()
		expect(result.current.entries[0]).toBe(0)
		await second.release()
		await waitFor(() => {
			expect(result.current.version).toBe("2")
		})
		expect(result.current.entries).toEqual(list(1000, 1000 + 2 * SYNC_PAGE_SIZE))
		expect(second.load.mock.calls).toEqual([
			[0, SYNC_PAGE_SIZE],
			[SYNC_PAGE_SIZE, SYNC_PAGE_SIZE]
		])
		expect(result.current.hasMore).toBe(true)
	})

	it("stops a new version's read where its list ends, and starts over on a new key", async () => {
		const first = source(150)
		const { result, rerender } = renderHook(({ key, version, load }) => usePagedEntries(key, load, version), {
			initialProps: { key: "k", version: "1", load: first.load }
		})

		await first.release()
		act(() => {
			result.current.loadMore()
		})
		await first.release()

		const shorter = source(30, 500)

		rerender({ key: "k", version: "2", load: shorter.load })
		await shorter.release()
		expect(result.current.entries).toEqual(list(500, 530))
		expect(result.current.total).toBe(30)
		expect(shorter.load).toHaveBeenCalledOnce()

		rerender({ key: "other", version: "2", load: shorter.load })
		expect(result.current.entries).toEqual([])
		expect(result.current.loading).toBe(true)
	})
})
