import { existsSync, readFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { crc32, type ByteSource } from "../core/opc/index"
import { pptxSpliceWriter } from "../core/pptx/write/save"
import { SERVICES, type CallContext, type EngineSession } from "../dom/presentation/engine"
import { openPptxCapability, pptxParts } from "../dom/presentation/engine/open/pptx"
import { pptxSaveSource } from "../dom/presentation/engine/save"
import { bindSaveHistory, rebasableSource, saveSession, type SaveHistory } from "../dom/presentation/save"
import { SAVE_PORT_CHUNK, SAVE_PORT_IN_FLIGHT, savePortReader, type SavePortEnd } from "../dom/presentation/savePort"
import { CORPUS_DIR } from "./corpusDir"
import { bigDeck } from "./fixtures/presentation/bigDeck"
import { liveHeap, liveHeapNow } from "./liveHeap"
import { budget, cpuMs } from "./timing"

// Saving the 2 GB generated deck (8 stored videos) after a one-slide edit: the package streams from the range source
// to the upload with the worker's memory bounded by the chunks in flight, never by the package.

const MiB = 1024 * 1024
const MEMORY_BUDGET = 64 * MiB

// The deck file read by range, checksummed on its side as the SDK worker's range server does.
async function fileSource(path: string): Promise<{ readonly source: ByteSource; readonly close: () => Promise<void> }> {
	const handle = await open(path, "r")
	const { size } = await handle.stat()
	const read = async (offset: number, length: number): Promise<Uint8Array> => {
		const bytes = new Uint8Array(length)
		const { bytesRead } = await handle.read(bytes, 0, length, offset)

		return bytesRead === length ? bytes : bytes.subarray(0, bytesRead)
	}

	return {
		source: {
			size,
			read,
			async readChecked(offset, length, crc) {
				const bytes = await read(offset, length)

				return { bytes, crc: crc32(bytes, crc) }
			}
		},
		close: () => handle.close()
	}
}

const SHAPING = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")

// One move on slide 4 of the deck saved in memory from a range-backed session, the upload reading the port: the peak
// live heap above the opened model while the save runs, sampled at reads and at chunks the upload takes.
async function inMemorySave(bytes: Uint8Array): Promise<{ readonly result: unknown; readonly uploaded: number; readonly peak: number }> {
	let peak = 0
	let base = 0
	let sampling = false
	const sample = (): void => {
		if (sampling) peak = Math.max(peak, liveHeapNow() - base)
	}
	// Every read a fresh buffer, as a range port's are; the bytes checksummed where they live.
	let reads = 0
	// Every 16th read samples (each sample is two full collections).
	const read = (offset: number, length: number): Uint8Array => {
		if (reads++ % 16 === 0) sample()

		return bytes.slice(offset, offset + length)
	}
	const remote: ByteSource = {
		size: bytes.length,
		read: (offset, length) => Promise.resolve(read(offset, length)),
		readChecked: (offset, length, crc) => {
			const chunk = read(offset, length)

			return Promise.resolve({ bytes: chunk, crc: crc32(chunk, crc) })
		}
	}
	const outcome = await openPptxCapability.open({
		source: rebasableSource(remote),
		sourceKind: "range",
		options: { format: "pptx", fileName: "deck.pptx" }
	})

	if (outcome.kind !== "opened") throw new Error(outcome.kind)

	const node = await pptxParts(outcome.deck)!.slide(outcome.deck.slides[3]!)
	const shape = node.shapes.find(candidate => candidate.kind === "sp" && candidate.xfrm !== undefined && candidate.lock === undefined)!

	shape.xfrm = { ...shape.xfrm!, x: shape.xfrm!.x + 12700 }
	bindSaveHistory(outcome.deck, {
		revision: 1,
		dirty: true,
		changes: () => ({
			empty: false,
			parts: new Map([[node.part, { change: "changed", shapes: new Map([[shape.id, { kind: "xfrm" }]]) }]]),
			presentation: new Set()
		}),
		savePoint: () => ({ revision: 1 }),
		commit: () => undefined,
		abandon: () => undefined
	})

	const session: EngineSession = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options: { format: "pptx", fileName: "deck.pptx" },
		services: SERVICES,
		rangeSource: undefined,
		schedule: () => undefined,
		emit: () => undefined,
		onClose: () => undefined
	}
	const context: CallContext = {
		session,
		signal: { aborted: false, onAbort: () => undefined },
		lane: "background",
		slicing: { pause: () => Promise.resolve(), sliceMs: 8, now: () => Date.now() }
	}
	const { port1, port2 } = new MessageChannel()
	const uploading = (async () => {
		const reader = savePortReader(port2 as unknown as SavePortEnd)
		let total = 0

		for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) {
			sample()
			total += chunk.length
		}

		reader.settled(true)

		return total
	})()

	base = await liveHeap()
	sampling = true

	const result = await saveSession(
		context,
		{ reason: "user", port: port1 as unknown as SavePortEnd },
		{ savers: { pptx: { writer: pptxSpliceWriter, source: pptxSaveSource } }, rebasers: {} }
	)
	const uploaded = await uploading

	sample()
	sampling = false

	return { result, uploaded, peak }
}

describe("presentation save memory", () => {
	it.skipIf(!existsSync(SHAPING))(
		"holds one copy of the zip and the port's window while a range-backed deck saves in memory",
		async () => {
			const bytes = new Uint8Array(readFileSync(SHAPING))

			// A save first, outside the measurement: the first run of the save path compiles it (its bytecode, feedback
			// and code, ~2 MiB of heap the measured save would otherwise count), which the save does not hold.
			expect((await inMemorySave(bytes)).result).toMatchObject({ kind: "written" })

			const { result, uploaded, peak } = await inMemorySave(bytes)

			expect(result).toMatchObject({ kind: "written" })
			console.info(
				`in-memory save of ${String(Math.round(uploaded / MiB))} MiB: peak ${(peak / MiB).toFixed(2)} MiB above the open model`
			)
			// The zip the session keeps for its rebase (one copy), the save port's window (the chunks in flight, the one
			// being filled and the one being read) and the parts the save parsed; a second copy would add the package again.
			expect(peak).toBeLessThanOrEqual(uploaded + (SAVE_PORT_IN_FLIGHT + 2) * SAVE_PORT_CHUNK + 2 * MiB)
		},
		budget(120_000)
	)

	it(
		"streams the 2 GB deck's save with the worker's memory within 64 MiB above the open model",
		async () => {
			const path = await bigDeck("memory2g")
			const file = await fileSource(path)

			try {
				const outcome = await openPptxCapability.open({
					source: rebasableSource(file.source),
					sourceKind: "range",
					options: { format: "pptx", fileName: "big.pptx" }
				})

				if (outcome.kind !== "opened") throw new Error(outcome.kind)

				// One moved shape on slide 1.
				const node = await pptxParts(outcome.deck)!.slide(outcome.deck.slides[0]!)
				const title = node.shapes.find(shape => shape.id === 2)!

				title.xfrm = { x: 1_234_567, y: 365_125, cx: 10_515_600, cy: 1_325_563, rot: 0, flipH: false, flipV: false }

				const history: SaveHistory = {
					revision: 1,
					dirty: true,
					changes: () => ({
						empty: false,
						parts: new Map([[node.part, { change: "changed", shapes: new Map([[2, { kind: "xfrm" }]]) }]]),
						presentation: new Set()
					}),
					savePoint: () => ({ revision: 1 }),
					commit: () => undefined,
					abandon: () => undefined
				}

				bindSaveHistory(outcome.deck, history)
				const session: EngineSession = {
					s: 1,
					deck: outcome.deck,
					package: outcome.package,
					options: { format: "pptx", fileName: "big.pptx" },
					services: SERVICES,
					rangeSource: undefined,
					schedule: () => undefined,
					emit: () => undefined,
					onClose: () => undefined
				}
				const context: CallContext = {
					session,
					signal: { aborted: false, onAbort: () => undefined },
					lane: "background",
					slicing: { pause: () => new Promise(resolve => setImmediate(resolve)), sliceMs: 8, now: () => Date.now() }
				}
				const base = await liveHeap()
				const cpuStart = cpuMs()
				let peak = 0
				const sampler = setInterval(() => {
					void liveHeap().then(used => {
						peak = Math.max(peak, used - base)
					})
				}, 50)
				const { port1, port2 } = new MessageChannel()
				// The upload side reads and drops every chunk (the SDK encrypts and sends it).
				const uploading = (async () => {
					const reader = savePortReader(port2 as unknown as SavePortEnd)
					let total = 0

					for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) total += chunk.length

					reader.settled(true)

					return total
				})()
				const result = await saveSession(
					context,
					{ reason: "user", port: port1 as unknown as SavePortEnd },
					{
						savers: { pptx: { writer: pptxSpliceWriter, source: pptxSaveSource } },
						rebasers: {}
					}
				)
				const uploaded = await uploading

				clearInterval(sampler)

				const cpu = cpuMs() - cpuStart
				expect(result).toMatchObject({ kind: "written", revision: 1 })
				expect(uploaded).toBeGreaterThan(2000 * MiB)
				console.info(
					`save of ${String(Math.round(uploaded / MiB))} MiB: peak ${String(Math.round(peak / MiB))} MiB above the open model, ${String(Math.round(cpu))} ms CPU (collections included)`
				)
				expect(peak).toBeLessThanOrEqual(MEMORY_BUDGET)
				// Two CRC passes (where the bytes live and where they arrive) and one copy per byte, both sides of the port.
				expect(cpu).toBeLessThanOrEqual(budget(12_000))
			} finally {
				await file.close()
			}
		},
		budget(600_000)
	)
})
