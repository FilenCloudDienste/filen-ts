import { describe, expect, it } from "vitest"
import {
	SAVE_PORT_CHUNK,
	SAVE_PORT_IN_FLIGHT,
	SavePortAbortedError,
	savePortReader,
	savePortWriter,
	type SavePortEnd
} from "../dom/presentation/savePort"

// The save stream's pull protocol between the presentation worker (writer) and the SDK worker's upload (reader),
// over a real MessageChannel: chunk size and in-flight bounds, backpressure, commit and abort from either side.

const MiB = 1024 * 1024

function channel(): { writerEnd: SavePortEnd; readerEnd: SavePortEnd; pulls: () => number; chunks: () => number } {
	const { port1, port2 } = new MessageChannel()
	let pulls = 0
	let chunks = 0
	const writerEnd = port1 as unknown as SavePortEnd
	const readerEnd = port2 as unknown as SavePortEnd
	const writerPost = port1.postMessage.bind(port1)
	const readerPost = port2.postMessage.bind(port2)

	writerEnd.postMessage = (message: unknown, transfer?: readonly unknown[]) => {
		if ((message as Record<string, unknown>)["filen.savePort"] === "chunk") chunks++

		writerPost(message, (transfer ?? []) as never)
	}
	readerEnd.postMessage = (message: unknown, transfer?: readonly unknown[]) => {
		if ((message as Record<string, unknown>)["filen.savePort"] === "pull") pulls++

		readerPost(message, (transfer ?? []) as never)
	}

	return { writerEnd, readerEnd, pulls: () => pulls, chunks: () => chunks }
}

function pattern(length: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(length)

	for (let i = 0; i < length; i++) bytes[i] = (i * 31 + seed) & 0xff

	return bytes
}

async function drain(reader: ReturnType<typeof savePortReader>): Promise<Uint8Array> {
	const parts: Uint8Array[] = []

	for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) parts.push(chunk)

	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

function same(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false

	return true
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe("save port pull protocol", () => {
	it("streams the written bytes in chunks of at most 1 MiB and ends only on commit", async () => {
		const { writerEnd, readerEnd } = channel()
		const writer = savePortWriter(writerEnd)
		const reader = savePortReader(readerEnd)
		const source = pattern(5 * MiB + 12_345, 7)
		const sizes: number[] = []
		const received = (async () => {
			const parts: Uint8Array[] = []

			for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) {
				sizes.push(chunk.length)
				parts.push(chunk)
			}

			return parts
		})()

		// Mixed write sizes, as the zip writer makes them (64 KiB batches, 4 MiB copies, small headers).
		await writer.write(source.subarray(0, 30))
		await writer.write(source.subarray(30, 4 * MiB + 30))
		await writer.write(source.subarray(4 * MiB + 30))
		await writer.close()
		writer.commit()

		const parts = await received

		reader.settled(true)
		expect(await writer.uploaded).toBe(true)
		const joined = new Uint8Array(source.length)
		let at = 0

		for (const part of parts) {
			joined.set(part, at)
			at += part.length
		}

		expect(same(joined, source)).toBe(true)
		expect(Math.max(...sizes)).toBeLessThanOrEqual(SAVE_PORT_CHUNK)
		expect(writer.sent).toBe(source.length)
		expect(reader.received).toBe(source.length)
	})

	it("never detaches a buffer the writer was handed", async () => {
		const { writerEnd, readerEnd } = channel()
		const writer = savePortWriter(writerEnd)
		const reader = savePortReader(readerEnd)
		const deck = pattern(3 * SAVE_PORT_CHUNK, 3)
		const done = drain(reader)

		await writer.write(deck.subarray(SAVE_PORT_CHUNK, 2 * SAVE_PORT_CHUNK))
		await writer.write(deck)
		await writer.close()
		writer.commit()
		await done

		expect(deck.buffer.byteLength).toBe(3 * SAVE_PORT_CHUNK)
		expect(deck[5]).toBe((5 * 31 + 3) & 0xff)
	})

	it("keeps at most 4 chunks asked or unread, and the writer waits while the reader does not read", async () => {
		const { writerEnd, readerEnd, pulls, chunks } = channel()
		const writer = savePortWriter(writerEnd)
		const reader = savePortReader(readerEnd)
		let written = 0
		const writing = (async () => {
			for (let k = 0; k < 20; k++) {
				await writer.write(pattern(SAVE_PORT_CHUNK, k))
				written++
			}

			await writer.close()
		})()

		await settle()
		// Nothing read: four chunks asked and sent, the fifth write still waiting for a request (its buffer full).
		expect(pulls()).toBe(SAVE_PORT_IN_FLIGHT)
		expect(chunks()).toBe(SAVE_PORT_IN_FLIGHT)
		expect(written).toBe(SAVE_PORT_IN_FLIGHT)

		await reader.read()
		await settle()
		expect(pulls()).toBe(SAVE_PORT_IN_FLIGHT + 1)
		expect(chunks()).toBe(SAVE_PORT_IN_FLIGHT + 1)
		expect(written).toBe(SAVE_PORT_IN_FLIGHT + 1)

		for (let k = 1; k < 20; k++) {
			await reader.read()
			expect(pulls() - (k + 1)).toBeLessThanOrEqual(SAVE_PORT_IN_FLIGHT)
		}

		await writing
		writer.commit()
		expect(await reader.read()).toBeUndefined()
	})

	it("ends the upload without a file when the writer aborts, before or after the last byte", async () => {
		for (const late of [false, true]) {
			const { writerEnd, readerEnd } = channel()
			const writer = savePortWriter(writerEnd)
			const reader = savePortReader(readerEnd)
			const done = drain(reader)

			await writer.write(pattern(2 * MiB, 1))

			if (late) await writer.close()

			writer.abort("refused")

			await expect(done).rejects.toEqual(new SavePortAbortedError("refused"))
			// Nothing more goes out once aborted.
			await expect(writer.write(pattern(10, 1))).rejects.toBeInstanceOf(SavePortAbortedError)
			expect(() => {
				writer.commit()
			}).toThrow(SavePortAbortedError)
		}
	})

	it("fails the writer's next write when the reader aborts (the upload failed or was cancelled)", async () => {
		const { writerEnd, readerEnd } = channel()
		const writer = savePortWriter(writerEnd)
		const reader = savePortReader(readerEnd)

		const writing = (async () => {
			for (;;) await writer.write(pattern(SAVE_PORT_CHUNK, 2))
		})()

		await settle()
		reader.abort("upload")

		await expect(writing).rejects.toEqual(new SavePortAbortedError("upload"))
		expect(await writer.aborted).toBe("upload")
		await expect(reader.read()).rejects.toEqual(new SavePortAbortedError("upload"))
	})

	it("aborts a reader whose writer went quiet", async () => {
		const { writerEnd, readerEnd } = channel()

		savePortWriter(writerEnd)

		const reader = savePortReader(readerEnd, { stallMs: 30 })

		await expect(reader.read()).rejects.toEqual(new SavePortAbortedError("closed"))
	})

	it("keeps the upload open while a live writer prepares for longer than the stall, then streams its bytes", async () => {
		const { writerEnd, readerEnd } = channel()
		const writer = savePortWriter(writerEnd, { aliveMs: 10 })
		const reader = savePortReader(readerEnd, { stallMs: 40 })
		const source = pattern(MiB + 5, 3)
		const received = drain(reader)

		// The writer checks its package whole before the first byte (four stalls long).
		await new Promise(resolve => setTimeout(resolve, 160))
		await writer.write(source)
		await writer.close()
		writer.commit()

		expect(same(await received, source)).toBe(true)
	})

	it("keeps an aborting end open until the other side acknowledges the abort, then closes both", async () => {
		for (const side of ["writer", "reader"] as const) {
			const { writerEnd, readerEnd } = channel()
			const closed: string[] = []
			const watch = (end: SavePortEnd, name: string): void => {
				const close = end.close.bind(end)

				end.close = () => {
					closed.push(name)
					close()
				}
			}

			watch(writerEnd, "writer")
			watch(readerEnd, "reader")

			const writer = savePortWriter(writerEnd)

			// The other end is still on its way (posted to a worker that has not taken it): nothing may close yet.
			if (side === "writer") writer.abort("unchanged")

			expect(closed).toEqual([])

			const reader = savePortReader(readerEnd)

			if (side === "reader") reader.abort("upload")

			const failure = side === "writer" ? reader.read() : writer.aborted

			await (side === "writer"
				? expect(failure).rejects.toEqual(new SavePortAbortedError("unchanged"))
				: expect(failure).resolves.toBe("upload"))
			await settle()
			expect(closed.sort()).toEqual(["reader", "writer"])
		}
	})

	it("closes an aborting end whose other side never answers after the linger time", async () => {
		const { writerEnd } = channel()
		let closed = false
		const close = writerEnd.close.bind(writerEnd)

		writerEnd.close = () => {
			closed = true
			close()
		}

		savePortWriter(writerEnd, { lingerMs: 30 }).abort("refused")
		expect(closed).toBe(false)
		await new Promise(resolve => setTimeout(resolve, 60))
		expect(closed).toBe(true)
	})

	it("refuses an end whose size is not what arrived", async () => {
		const { port1, port2 } = new MessageChannel()
		const reader = savePortReader(port2 as unknown as SavePortEnd)

		port1.postMessage({ "filen.savePort": "chunk", bytes: new Uint8Array(10) })
		port1.postMessage({ "filen.savePort": "end", size: 11 })

		await expect(drain(reader)).rejects.toEqual(new SavePortAbortedError("failed"))
		port1.close()
	})

	it("tells the writer when the upload failed after the last byte", async () => {
		const { writerEnd, readerEnd } = channel()
		const writer = savePortWriter(writerEnd)
		const reader = savePortReader(readerEnd)
		const done = drain(reader)

		await writer.write(pattern(100, 4))
		await writer.close()
		writer.commit()
		await done
		reader.abort("upload")

		expect(await writer.uploaded).toBe(false)
	})

	it("gives up on an upload that never answers after the last byte", async () => {
		const { writerEnd, readerEnd } = channel()
		const writer = savePortWriter(writerEnd, { settleMs: 30 })
		const done = drain(savePortReader(readerEnd))

		await writer.close()
		writer.commit()
		await done

		expect(await writer.uploaded).toBe(false)
	})

	it("resolves uploaded false for a save aborted before its end", async () => {
		const { writerEnd, readerEnd } = channel()
		const writer = savePortWriter(writerEnd)

		savePortReader(readerEnd)
		writer.abort("refused")

		expect(await writer.uploaded).toBe(false)
	})

	it("commits an empty stream", async () => {
		const { writerEnd, readerEnd } = channel()
		const writer = savePortWriter(writerEnd)
		const reader = savePortReader(readerEnd)

		await writer.close()
		writer.commit()

		expect(await drain(reader)).toEqual(new Uint8Array(0))
	})
})
