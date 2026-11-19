import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CfbFile, cfbBytes, type CfbWriteEntry } from "@filen/office/core/cfb"
import { bytesSource } from "@filen/office/core/opc"
import { DocError, docText, readDoc } from "@filen/office/core/doc"
import { CORPUS_DIR } from "./corpusDir"
import { buildDoc, lists, plc, prl } from "./docFixtures"
import { budget } from "./timing"

// Mutated documents (bytes of the WordDocument and Table streams overwritten, the compound file rebuilt) must read
// or be refused with a DocError, never throw anything else, and never take long. FILEN_OFFICE_DOC_FUZZ (mutants
// per test) and FILEN_OFFICE_DOC_FUZZ_SEED replace the fixed counts and seeds; the nightly fuzz sets the seed.

const ITERATIONS = process.env["FILEN_OFFICE_DOC_FUZZ"] || undefined
const SEED = process.env["FILEN_OFFICE_DOC_FUZZ_SEED"] || undefined

function random(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0

		return state / 0x100000000
	}
}

interface Streams {
	readonly name: string
	readonly entries: readonly { readonly path: string; readonly bytes: Uint8Array }[]
}

async function streams(name: string, bytes: Uint8Array): Promise<Streams> {
	const cfb = await CfbFile.open(bytesSource(bytes))
	const entries: { path: string; bytes: Uint8Array }[] = []

	for (const path of ["WordDocument", "0Table", "1Table", "Data"]) {
		if (cfb.entry([path])?.kind === "stream") entries.push({ path, bytes: await cfb.read(path) })
	}

	return { name, entries }
}

// Overwrites a few bytes, biased to the front of each stream where the Fib, piece table and PLCs live.
function mutate(source: Streams, next: () => number): CfbWriteEntry[] {
	return source.entries.map(entry => {
		const bytes = entry.bytes.slice()

		if (entry.path !== "Data") {
			const count = 1 + Math.floor(next() * 12)

			for (let k = 0; k < count; k++) {
				const span = next() < 0.6 ? Math.min(bytes.length, 1024) : bytes.length
				const at = Math.floor(next() * span)
				const kind = next()

				bytes[at] =
					kind < 0.4
						? Math.floor(next() * 256)
						: kind < 0.7
							? 0xff
							: kind < 0.85
								? 0
								: (bytes[at] ?? 0) ^ (1 << Math.floor(next() * 8))
			}
		}

		return { path: [entry.path], bytes }
	})
}

async function attempt(entries: CfbWriteEntry[]): Promise<{ readonly ms: number; readonly untyped: string | undefined }> {
	const bytes = await cfbBytes(entries)
	const started = performance.now()
	let untyped: string | undefined

	try {
		docText(await readDoc(bytesSource(bytes)))
	} catch (error) {
		if (!(error instanceof DocError)) untyped = error instanceof Error ? (error.stack ?? error.message) : String(error)
	}

	return { ms: performance.now() - started, untyped }
}

async function fuzz(sources: readonly Streams[], iterations: number, seed: number): Promise<{ untyped: string[]; slowest: number }> {
	const next = random(seed)
	const untyped: string[] = []
	let slowest = 0

	for (let k = 0; k < iterations; k++) {
		const source = sources[Math.floor(next() * sources.length)]

		if (source === undefined) continue

		const result = await attempt(mutate(source, next))

		slowest = Math.max(slowest, result.ms)

		if (result.untyped !== undefined) untyped.push(`${source.name} #${k} (seed ${seed}): ${result.untyped}`)
	}

	return { untyped, slowest }
}

describe("mutated Word binary documents", () => {
	it("read or refuse with a typed error (synthetic)", { timeout: 120_000 }, async () => {
		const { plfLst, lstLength, plfLfo } = lists([{ nfc: 0, text: "\u0000." }])
		const bytes = await buildDoc({
			pieces: [
				{ text: "one\u0007two\u0007\u0007" },
				{ text: "\u0013 PAGE \u00141\u0015 list\r", compressed: false },
				{ text: "end\r" }
			],
			runs: [
				{ start: 0, end: 9, grpprl: prl.toggle(0x0835, 1) },
				{ start: 9, end: 10, grpprl: prl.toggle(0x0855, 1) },
				{ start: 10, end: 26, grpprl: [] }
			],
			paragraphs: [
				{ end: 4, grpprl: prl.u8(0x2416, 1) },
				{ end: 8, grpprl: prl.u8(0x2416, 1) },
				{ end: 9, grpprl: [...prl.u8(0x2416, 1), ...prl.u8(0x2417, 1)] },
				{ end: 22, grpprl: prl.u16(0x460b, 1) },
				{ end: 26 }
			],
			structures: {
				plfLst,
				plfLfo,
				plcfFldMom: plc(
					[9, 16, 18, 26],
					[
						[0x13, 33],
						[0x14, 0],
						[0x15, 0]
					]
				),
				plcfSed: plc([0, 26], [[0, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0]])
			},
			lengths: { plfLst: lstLength }
		})
		const seed = Number(SEED ?? "7")
		const { untyped, slowest } = await fuzz([await streams("synthetic", bytes)], Number(ITERATIONS ?? "1500"), seed)

		expect(untyped).toEqual([])
		expect(slowest, `seed ${seed}`).toBeLessThan(budget(1000))
	})

	const files = existsSync(join(CORPUS_DIR, "doc"))
		? readdirSync(join(CORPUS_DIR, "doc"))
				.map(name => join(CORPUS_DIR, "doc", name))
				.filter(path => statSync(path).size < 400_000)
		: []

	it.skipIf(files.length === 0)("read or refuse with a typed error (corpus)", { timeout: 300_000 }, async () => {
		const sources: Streams[] = []

		for (const path of files) {
			const bytes = readFileSync(path)

			try {
				sources.push(await streams(path, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)))
			} catch {
				// Not a compound file.
			}
		}

		const seed = Number(SEED ?? "11")
		const { untyped, slowest } = await fuzz(sources, Number(ITERATIONS ?? "800"), seed)

		expect(untyped).toEqual([])
		expect(slowest, `seed ${seed}`).toBeLessThan(budget(2000))
	})
})
