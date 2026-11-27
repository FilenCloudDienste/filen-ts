import { describe, expect, it, vi } from "vitest"
import { headTap } from "@/lib/sw/headTap"

// The service worker's pass-through of an inline image body: every byte reaches the consumer as it reads, and the
// first bytes are copied out once for the page.

function sourceOf(chunks: number[][]): { source: ReadableStream<Uint8Array>; pulls: () => number; cancelled: () => boolean } {
	let pulls = 0
	let cancelled = false
	const queue = chunks.map(chunk => new Uint8Array(chunk))
	const source = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				pulls++

				const next = queue.shift()

				if (next === undefined) {
					controller.close()
				} else {
					controller.enqueue(next)
				}
			},
			cancel() {
				cancelled = true
			}
		},
		{ highWaterMark: 0 }
	)

	return { source, pulls: () => pulls, cancelled: () => cancelled }
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<number[]> {
	const out: number[] = []

	for await (const chunk of body) {
		out.push(...chunk)
	}

	return out
}

function handed(onHead: ReturnType<typeof vi.fn>): number[] {
	return [...(onHead.mock.calls[0]?.[0] as Uint8Array)]
}

describe("headTap", () => {
	it("passes every byte through and hands the first `limit` once they have passed", async () => {
		const { source } = sourceOf([[1, 2], [3, 4, 5], [6]])
		const onHead = vi.fn()

		expect(await readAll(headTap(source, 4, onHead))).toEqual([1, 2, 3, 4, 5, 6])
		expect(onHead).toHaveBeenCalledTimes(1)
		expect(handed(onHead)).toEqual([1, 2, 3, 4])
	})

	it("hands a body shorter than the limit whole once it ends", async () => {
		const { source } = sourceOf([[1, 2]])
		const onHead = vi.fn()

		await readAll(headTap(source, 8, onHead))
		expect(handed(onHead)).toEqual([1, 2])
	})

	it("reads nothing ahead of its consumer", async () => {
		const { source, pulls } = sourceOf([[1], [2], [3]])
		const reader = headTap(source, 2, () => undefined).getReader()

		await Promise.resolve()
		expect(pulls()).toBe(0)
		await reader.read()
		expect(pulls()).toBe(1)
	})

	it("hands nothing for a body cancelled first, and cancels its source", async () => {
		const { source, cancelled } = sourceOf([[1], [2], [3]])
		const onHead = vi.fn()
		const reader = headTap(source, 3, onHead).getReader()

		await reader.read()
		await reader.cancel()
		expect(onHead).not.toHaveBeenCalled()
		expect(cancelled()).toBe(true)
	})
})
