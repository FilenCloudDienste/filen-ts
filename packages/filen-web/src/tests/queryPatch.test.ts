import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"

// A bare client: the helper only needs real cache and observer mechanics, never the production
// client's persistence.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient } from "@/queries/client"
import { patchQuery } from "@/queries/patch"

const KEY = ["test", "list"] as const

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined
	const promise = new Promise<T>(res => {
		resolve = res
	})

	return { promise, resolve }
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

// Mounts the query the way a rendered list does, with `read` as its queryFn.
function mount(read: () => Promise<string[]>): () => void {
	const observer = new QueryObserver(queryClient, { queryKey: KEY, queryFn: read, staleTime: Infinity })

	return observer.subscribe(() => undefined)
}

beforeEach(() => {
	queryClient.clear()
})

afterEach(() => {
	queryClient.clear()
})

describe("patchQuery", () => {
	it("patches an idle, fresh query without reading or marking it stale", async () => {
		const read = vi.fn(() => Promise.resolve(["server"]))
		queryClient.setQueryData(KEY, ["a"])
		const unmount = mount(read)
		await settle()

		patchQuery<string[]>(KEY, prev => [...(prev ?? []), "b"])
		await settle()

		expect(read).not.toHaveBeenCalled()
		expect(queryClient.getQueryData(KEY)).toEqual(["a", "b"])
		expect(queryClient.getQueryState(KEY)?.isInvalidated).toBe(false)
		unmount()
	})

	it("cancels a refetch the patch overtakes, then reads again at once while mounted", async () => {
		const stale = deferred<string[]>()
		const read = vi.fn<() => Promise<string[]>>().mockReturnValueOnce(stale.promise).mockResolvedValue(["a", "b", "server"])
		queryClient.setQueryData(KEY, ["a"])
		const unmount = mount(read)
		void queryClient.refetchQueries({ queryKey: KEY })
		await settle()

		patchQuery<string[]>(KEY, prev => [...(prev ?? []), "b"])
		// Answered before the write: it must never land over the patch.
		stale.resolve(["a"])
		await settle()

		expect(read).toHaveBeenCalledTimes(2)
		expect(queryClient.getQueryData(KEY)).toEqual(["a", "b", "server"])
		unmount()
	})

	it("keeps an initial fetch alive, and replaces it with a read that starts after the patch", async () => {
		const initial = deferred<string[]>()
		const read = vi.fn<() => Promise<string[]>>().mockReturnValueOnce(initial.promise).mockResolvedValue(["server", "b"])
		const unmount = mount(read)
		await settle()

		patchQuery<string[]>(KEY, prev => [...(prev ?? []), "b"])
		expect(queryClient.getQueryData(KEY)).toEqual(["b"])
		initial.resolve([])
		await settle()

		expect(read).toHaveBeenCalledTimes(2)
		expect(queryClient.getQueryData(KEY)).toEqual(["server", "b"])
		unmount()
	})

	it("keeps an unmounted query's pending refresh for its next mount, without reading now", async () => {
		const read = vi.fn(() => Promise.resolve(["server"]))
		queryClient.setQueryData(KEY, ["a"])
		await queryClient.invalidateQueries({ queryKey: KEY, refetchType: "none" })

		patchQuery<string[]>(KEY, prev => [...(prev ?? []), "b"])
		await settle()

		expect(read).not.toHaveBeenCalled()
		expect(queryClient.getQueryState(KEY)?.isInvalidated).toBe(true)

		const unmount = mount(read)
		await settle()

		expect(read).toHaveBeenCalledTimes(1)
		unmount()
	})

	it("never scans the query cache", () => {
		queryClient.setQueryData(KEY, ["a"])

		for (let i = 0; i < 20; i++) {
			queryClient.setQueryData(["other", i], i)
		}

		const scan = vi.spyOn(queryClient.getQueryCache(), "getAll")

		patchQuery<string[]>(KEY, prev => [...(prev ?? []), "b"])

		expect(scan).not.toHaveBeenCalled()
	})
})
