import { describe, expect, it } from "vitest"
import { heldBackBody } from "@/lib/sw/heldBackBody"

// The service worker's body for a stream the page produces: one chunk behind its source, so a source
// failing after its last byte never hands the browser everything its Content-Length promised.

function controlled(): {
	source: ReadableStream<Uint8Array>
	control: ReadableStreamDefaultController<Uint8Array>
	cancelled: () => unknown
} {
	const controls: ReadableStreamDefaultController<Uint8Array>[] = []
	let cancelReason: unknown = undefined
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controls.push(controller)
		},
		cancel(reason) {
			cancelReason = reason
		}
	})
	const [control] = controls

	if (control === undefined) {
		throw new Error("no controller")
	}

	return { source, control, cancelled: () => cancelReason }
}

function tick(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0))
}

function bytes(...values: number[]): Uint8Array {
	return new Uint8Array(values)
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<{ chunks: number[][]; error: unknown }> {
	const reader = body.getReader()
	const chunks: number[][] = []

	try {
		for (;;) {
			const { done, value } = await reader.read()

			if (done) {
				return { chunks, error: null }
			}

			chunks.push([...value])
		}
	} catch (e) {
		return { chunks, error: e }
	}
}

describe("heldBackBody", () => {
	it("passes every chunk through once the source closes", async () => {
		const { source, control } = controlled()
		const held = heldBackBody(source)

		control.enqueue(bytes(1, 2))
		control.enqueue(bytes(3))
		control.enqueue(bytes(4, 5))
		control.close()

		expect(await readAll(held.body)).toEqual({ chunks: [[1, 2], [3], [4, 5]], error: null })
		expect(await held.ended).toEqual({ type: "done" })
	})

	it("closes an empty source as an empty body", async () => {
		const { source, control } = controlled()
		const held = heldBackBody(source)

		control.close()

		expect(await readAll(held.body)).toEqual({ chunks: [], error: null })
		expect(await held.ended).toEqual({ type: "done" })
	})

	it("keeps the last chunk back from a source that fails after it", async () => {
		const { source, control } = controlled()
		const held = heldBackBody(source)
		const failure = new Error("checksum mismatch")

		const reading = readAll(held.body)

		// An errored stream drops what it still queues, so each chunk is taken before the next step.
		control.enqueue(bytes(1))
		await tick()
		control.enqueue(bytes(2))
		await tick()
		control.error(failure)

		const read = await reading

		expect(read.chunks).toEqual([[1]])
		expect(read.error).toBe(failure)
		expect(await held.ended).toEqual({ type: "failed", error: failure, cancelledByBrowser: false })
	})

	it("holds the first chunk until a second one or the end arrives", async () => {
		const { source, control } = controlled()
		const held = heldBackBody(source)
		const reader = held.body.getReader()
		let first: ReadableStreamReadResult<Uint8Array> | null = null

		void reader.read().then(result => {
			first = result
		})
		control.enqueue(bytes(1))
		await tick()

		expect(first).toBeNull()

		control.enqueue(bytes(2))
		await tick()

		expect(first).toEqual({ done: false, value: bytes(1) })
	})

	it("tells a browser's cancel apart and cancels the source with it", async () => {
		const { source, control, cancelled } = controlled()
		const held = heldBackBody(source)

		control.enqueue(bytes(1))
		await held.body.cancel("user cancelled")

		expect(await held.ended).toEqual({ type: "failed", error: "user cancelled", cancelledByBrowser: true })
		expect(cancelled()).toBe("user cancelled")
	})

	it("fails the body and the source on the page's cancel, settling once", async () => {
		const { source, control, cancelled } = controlled()
		const held = heldBackBody(source)
		const reason = new Error("download cancelled")

		control.enqueue(bytes(1))
		held.fail(reason)
		held.fail(new Error("again"))

		expect((await readAll(held.body)).error).toBe(reason)
		expect(await held.ended).toEqual({ type: "failed", error: reason, cancelledByBrowser: false })
		await tick()
		expect(cancelled()).toBe(reason)
	})
})
