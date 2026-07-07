import { describe, expect, it, vi } from "vitest"
import { runBulk } from "@/lib/drive/bulk"

describe("runBulk", () => {
	it("resolves empty on empty input without calling perItem", async () => {
		const perItem = vi.fn<(item: string) => Promise<void>>()

		const result = await runBulk([], perItem)

		expect(result).toEqual({ succeeded: [], failed: [] })
		expect(perItem).not.toHaveBeenCalled()
	})

	it("collects every item as succeeded when perItem resolves for all", async () => {
		const perItem = vi.fn<(item: string) => Promise<void>>().mockResolvedValue(undefined)

		const result = await runBulk(["a", "b", "c"], perItem)

		expect(result).toEqual({ succeeded: ["a", "b", "c"], failed: [] })
		expect(perItem).toHaveBeenCalledTimes(3)
	})

	it("collects every item as failed, with its thrown value, when perItem rejects for all — never rejects itself", async () => {
		const errorA = new Error("boom a")
		const errorB = new Error("boom b")
		const perItem = vi.fn<(item: string) => Promise<void>>().mockRejectedValueOnce(errorA).mockRejectedValueOnce(errorB)

		const result = await runBulk(["a", "b"], perItem)

		expect(result.succeeded).toEqual([])
		expect(result.failed).toEqual([
			{ item: "a", error: errorA },
			{ item: "b", error: errorB }
		])
	})

	it("splits succeeded/failed on a mixed batch — one rejection does not abort or drop the rest", async () => {
		const error = new Error("item 2 failed")
		const perItem = vi
			.fn<(item: string) => Promise<void>>()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(error)
			.mockResolvedValueOnce(undefined)

		const result = await runBulk(["a", "b", "c"], perItem)

		expect(result.succeeded).toEqual(["a", "c"])
		expect(result.failed).toEqual([{ item: "b", error }])
	})

	it("preserves whatever was thrown verbatim (no normalization) — stays agnostic of any particular error shape", async () => {
		const dto = { species: "sdk", label: "Some Label", message: "some message" }
		const perItem = vi.fn<(item: string) => Promise<void>>().mockRejectedValueOnce(dto)

		const result = await runBulk(["a"], perItem)

		expect(result.failed).toEqual([{ item: "a", error: dto }])
	})

	it("dispatches every item concurrently rather than one at a time", async () => {
		const callOrder: string[] = []
		const resolvers: (() => void)[] = []

		const perItem = vi.fn(async (item: string) => {
			callOrder.push(`called:${item}`)
			await new Promise<void>(resolve => {
				resolvers.push(resolve)
			})
			callOrder.push(`resolved:${item}`)
		})

		const bulkPromise = runBulk(["a", "b"], perItem)

		// Flush microtasks so both dispatches start before either settles.
		await Promise.resolve()
		await Promise.resolve()

		expect(callOrder).toEqual(["called:a", "called:b"])

		resolvers.forEach(resolve => {
			resolve()
		})
		await bulkPromise

		expect(callOrder).toEqual(["called:a", "called:b", "resolved:a", "resolved:b"])
	})

	it("keeps succeeded/failed in input order regardless of resolution order", async () => {
		const error = new Error("slow one fails")
		const perItem = vi.fn(async (item: string) => {
			if (item === "slow") {
				await new Promise(resolve => setTimeout(resolve, 10))
				throw error
			}
		})

		const result = await runBulk(["slow", "fast"], perItem)

		expect(result.failed).toEqual([{ item: "slow", error }])
		expect(result.succeeded).toEqual(["fast"])
	})
})
