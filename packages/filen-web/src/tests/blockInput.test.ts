import { describe, expect, it, vi } from "vitest"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { MAX_RUN_BLOCKS } from "@/lib/media/blockCache"
import { SOURCE_READ_ERROR } from "@/lib/media/remuxTypes"

const port = vi.hoisted(() => ({
	requests: [] as [number, number][],
	fail: false,
	closed: 0
}))

vi.mock("@/lib/media/rangePort", () => ({
	rangePortReader: () => ({
		readRange: (start: number, end: number) => {
			port.requests.push([start, end])

			return port.fail ? Promise.reject(new Error("offline")) : Promise.resolve(new Uint8Array(end - start).fill(7))
		},
		readChecked: vi.fn(),
		onLost: vi.fn(),
		close: () => {
			port.closed++
		}
	})
}))

const { BLOCK_INPUT_PROFILES, openBlockInput } = await import("@/lib/media/blockInput")

function reset(): void {
	port.requests.length = 0
	port.fail = false
	port.closed = 0
}

const SIZE = 40 * BLOCK_BYTES
const fakePort = {} as MessagePort

describe("openBlockInput", () => {
	it("keeps the playback and audio caches as they were", () => {
		expect(BLOCK_INPUT_PROFILES.playback).toEqual({ capacity: 12, readAhead: 3, maxRunBlocks: MAX_RUN_BLOCKS })
		expect(BLOCK_INPUT_PROFILES.audio).toEqual({ capacity: 4, readAhead: 2, maxRunBlocks: MAX_RUN_BLOCKS })
	})

	it("reads long runs in the export profile, and keeps little resident", () => {
		const { export: exportProfile, playback } = BLOCK_INPUT_PROFILES

		expect(exportProfile.maxRunBlocks).toBeGreaterThan(playback.maxRunBlocks)
		expect(exportProfile.readAhead).toBeGreaterThan(playback.readAhead)
		expect(exportProfile.capacity).toBeLessThanOrEqual(playback.capacity)
		// Read-ahead must fit, or it would be evicted before the reader reaches it.
		expect(exportProfile.capacity).toBeGreaterThan(exportProfile.readAhead)
	})

	it("fetches an export read in runs of the export size", async () => {
		reset()

		const opened = openBlockInput(fakePort, SIZE, "export")

		await opened.cache.read(0, 16 * BLOCK_BYTES)

		expect(port.requests).toEqual([
			[0, 8 * BLOCK_BYTES],
			[8 * BLOCK_BYTES, 16 * BLOCK_BYTES]
		])

		opened.close()
	})

	it("hands every fresh block to onBlock", async () => {
		reset()

		const seen: number[] = []
		const opened = openBlockInput(fakePort, SIZE, "playback", { onBlock: index => seen.push(index) })

		await opened.cache.read(0, 3 * BLOCK_BYTES)
		await opened.cache.read(10, 20)

		expect(seen).toEqual([0, 1, 2])

		opened.close()
	})

	it("turns a failed read into a SourceReadError", async () => {
		reset()
		port.fail = true

		const opened = openBlockInput(fakePort, SIZE, "audio")

		await expect(opened.cache.read(0, 10)).rejects.toMatchObject({ name: SOURCE_READ_ERROR })

		opened.close()
	})

	it("closes the port once and refuses reads after close", () => {
		reset()

		const opened = openBlockInput(fakePort, SIZE, "audio")

		opened.close()
		opened.close()

		expect(port.closed).toBe(1)
		expect(() => opened.cache.read(0, 10)).toThrow()
	})
})
