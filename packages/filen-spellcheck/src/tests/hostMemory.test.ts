import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"
import { SpellcheckHost } from "../host"
import { fakeOrigin, inThreadWorker, tinyAssets } from "./fixtures"

setFlagsFromString("--expose-gc")

const gc = runInNewContext("gc") as () => void
const MiB = 1024 * 1024
const WORDS = 100_000

// The live heap (heap and array buffers) after full collections, with a turn between for buffers freed off the thread.
async function liveHeap(): Promise<number> {
	gc()
	await new Promise(resolve => setImmediate(resolve))
	gc()

	const usage = process.memoryUsage()

	return usage.heapUsed + usage.arrayBuffers
}

// A call of its own, so nothing it made is reachable from the caller's frame once it returns. Each document has
// words of its own.
async function checkDocument(host: SpellcheckHost, name: string): Promise<number> {
	const close = host.open()
	const words = Array.from({ length: WORDS }, (_, index) => `${name}${index.toString(36)}`)

	await host.check("en_US", words)

	const held = await liveHeap()

	expect(host.known("en_US", `${name}0`)).toBe(false)
	close()

	return held
}

// A closed editor holds no dictionary: its verdicts and the workers (with their engines) go with the last document.
it("returns the live heap to its level before a document was checked once it closes", async () => {
	const origin = fakeOrigin()
	const host = new SpellcheckHost({
		assets: tinyAssets(origin),
		createWorker: () => inThreadWorker({ fetch: origin.fetch, caches: undefined })
	})
	// The engine's module and code are compiled once per process: warm them before the baseline.
	await checkDocument(host, "warm")

	const before = await liveHeap()
	const open = await checkDocument(host, "word")
	const after = await liveHeap()

	expect((open - before) / MiB).toBeGreaterThan(3)
	expect((after - before) / MiB).toBeLessThan(0.5)
	host.dispose()
})
