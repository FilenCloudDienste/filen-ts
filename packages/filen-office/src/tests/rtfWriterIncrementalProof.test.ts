import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Checkpoint } from "../core/rtf/checkpoint"
import { readRtf } from "../core/rtf/index"
import { RtfWriteRefusal } from "../core/rtf/write/out"
import { openGroups, openRtfSource, proveWritten, writeRtf, type RtfSource, type RtfWritten } from "../core/rtf/write/writer"
import { parseXml } from "../core/xml/index"
import { CORPUS_DIR } from "./corpusDir"
import { rng, type Rand } from "./fuzz/config"
import { latin1 } from "./rtfWriteFixtures"

// A save proved by re-reading only the span the writing changed must be one the whole file's proof accepts: a
// written file whose state leaks into the kept blocks after the span (or before it) is never proved by the span,
// and the whole file's proof forces or refuses it as before. Saves written with and without the span agree byte
// for byte.

const HEADER =
	"{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1\\fswiss Arial;}}{\\colortbl;\\red255\\green0\\blue0;}"

// Paragraphs that carry their state (no \pard or \plain between them), so a leak shows in those after it.
function carrying(count: number): Uint8Array {
	let body = "\\pard\\plain\\f0\\fs24 "

	for (let k = 0; k < count; k++) body += `Paragraph ${k} of carried text {\\i italic \\u1046?} and more.\\par\n`

	return latin1(`${HEADER}${body}}`)
}

// Paragraphs each spelling out its own state.
function spelled(count: number, rand?: Rand): Uint8Array {
	let body = ""

	for (let k = 0; k < count; k++) {
		const pick = rand === undefined ? k : Math.floor(rand() * 1000)
		const align = ["", "\\qc", "\\qr", "\\qj"][pick % 4] ?? ""

		body += `\\pard\\plain${align}\\f${pick % 2}\\fs${20 + (pick % 5) * 2}${pick % 3 === 0 ? "\\cf1" : ""} Paragraph ${k} with {\\b bold} and {\\i italic \\u1046?} text.\\par\n`
	}

	return latin1(`${HEADER}${body}}`)
}

async function open(bytes: Uint8Array): Promise<RtfSource> {
	const source = await openRtfSource(bytes)

	if (source === undefined) throw new Error("not RTF")

	return source
}

// The translation's body with `text` typed at `at` in the first w:t of top-level paragraph `index`, as the docx
// writer writes an edit (the other blocks byte for byte).
async function typed(source: RtfSource, index: number, text: string, at = 0): Promise<Uint8Array> {
	const bytes = await source.translation.read("word/document.xml")
	const document = parseXml(bytes)
	const root = document.documentElement()
	let body = document.firstChildElement(root)

	while (body >= 0 && document.localName(body) !== "body") body = document.nextSiblingElement(body)

	let paragraph = document.firstChildElement(body)

	for (let k = 0; k < index && paragraph >= 0; k++) paragraph = document.nextSiblingElement(paragraph)

	const stack = [paragraph]
	let found = -1

	while (stack.length > 0 && found < 0) {
		const node = stack.shift() ?? -1

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) === "t") {
				found = child
				break
			}

			stack.push(child)
		}
	}

	if (found < 0) throw new Error(`no text in paragraph ${index}`)

	const insert = Math.min(document.contentStart(found) + at, document.contentEnd(found))
	const add = new TextEncoder().encode(text)
	const out = new Uint8Array(bytes.length + add.length)

	out.set(bytes.subarray(0, insert))
	out.set(add, insert)
	out.set(bytes.subarray(insert), insert + add.length)

	return out
}

function edits(document: Uint8Array): { parts: Map<string, Uint8Array> } {
	return { parts: new Map([["word/document.xml", document]]) }
}

function indexOf(bytes: Uint8Array, text: string, from = 0): number {
	const pattern = latin1(text)

	for (let at = bytes.indexOf(pattern[0] ?? 0, from); at >= 0; at = bytes.indexOf(pattern[0] ?? 0, at + 1))
		if (pattern.every((byte, k) => bytes[at + k] === byte)) return at

	return -1
}

function splice(bytes: Uint8Array, at: number, remove: number, text: string): Uint8Array {
	const add = latin1(text)
	const out = new Uint8Array(bytes.length - remove + add.length)

	out.set(bytes.subarray(0, at))
	out.set(add, at)
	out.set(bytes.subarray(at + remove), at + add.length)

	return out
}

async function attempt(write: () => Promise<RtfWritten>): Promise<Uint8Array | string> {
	try {
		return (await write()).bytes
	} catch (error) {
		if (!(error instanceof RtfWriteRefusal)) throw error

		return `refused: ${error.reason}`
	}
}

describe("RTF writer, span proof", () => {
	it("proves a one-paragraph edit by its span, as the whole file's proof does", async () => {
		const source = await open(spelled(1200))
		const change = edits(await typed(source, 600, "Edited "))
		const written = await writeRtf(source, change)
		const whole = await writeRtf(source, change, { span: false })

		expect(written.written).toBe(1)
		expect(written.path).toBe("span")
		expect(whole.path).toBe("whole")
		expect(written.bytes).toEqual(whole.bytes)
		expect(await proveWritten(source, change, written.bytes)).toEqual({ span: true, whole: "done" })
	})

	it("writes the whole file where the span's writing throws, and reports what it threw", async () => {
		const source = await open(spelled(400))
		const change = edits(await typed(source, 200, "Edited "))
		const checkpoints = source.read.checkpoints
		const injected = new TypeError("injected")
		let thrown = false

		// The span's writer reads the checkpoints first: that first read throws, the whole file's reads go on.
		Object.defineProperty(source.read, "checkpoints", {
			configurable: true,
			get: () => {
				if (thrown) return checkpoints

				thrown = true

				throw injected
			}
		})

		const fallbacks: unknown[] = []
		const written = await writeRtf(source, change, { onFallback: error => fallbacks.push(error) })

		expect(fallbacks).toEqual([injected])
		expect(written.path).toBe("whole")
		expect(written.bytes).toEqual((await writeRtf(source, change, { span: false })).bytes)
	})

	it("reports no fallback where the span's writing refuses", async () => {
		const source = await open(spelled(400))
		const fallbacks: unknown[] = []
		const change = { parts: new Map([...edits(await typed(source, 200, "Edited ")).parts, ["word/settings.xml", latin1("<x/>")]]) }

		await expect(writeRtf(source, change, { onFallback: error => fallbacks.push(error) })).rejects.toThrow(RtfWriteRefusal)
		expect(fallbacks).toEqual([])
	})

	it("proves edits of the first and the last paragraph", async () => {
		const source = await open(spelled(1200))

		for (const index of [0, 1199]) {
			const change = edits(await typed(source, index, "Edited "))
			const written = await writeRtf(source, change)

			expect(written.bytes).toEqual((await writeRtf(source, change, { span: false })).bytes)
			expect(await proveWritten(source, change, written.bytes)).toEqual({ span: true, whole: "done" })
		}
	})

	it("never proves a written file whose state leaks into the kept blocks", async () => {
		const source = await open(carrying(1200))
		const change = edits(await typed(source, 600, "Edited "))
		const written = (await writeRtf(source, change)).bytes

		expect(await proveWritten(source, change, written)).toEqual({ span: true, whole: "done" })

		const edited = indexOf(written, "Edited ")
		// Past the written paragraph and the group it is written in.
		const end = indexOf(written, "\\par", edited) + 4
		const after = written[end] === 0x7d ? end + 1 : end
		const before = written.lastIndexOf(0x5c, edited)
		const far = indexOf(written, "Paragraph 1100 ")
		const leaks: [string, Uint8Array][] = [
			["a stray \\b", splice(written, after, 0, "\\b ")],
			["an unclosed group", splice(written, after, 0, "{")],
			["a group closed early", splice(written, after, 0, "}")],
			["\\uc0", splice(written, after, 0, "\\uc0 ")],
			["\\qc in force", splice(written, after, 0, "\\qc ")],
			["\\plain", splice(written, after, 0, "\\plain ")],
			["a section word", splice(written, after, 0, "\\sectd\\landscape ")],
			["\\sect", splice(written, after, 0, "\\sect ")],
			["a stray \\b before the edit", splice(written, before, 0, "\\b ")],
			["a stray \\i far after the edit", splice(written, far, 0, "\\i ")],
			["a paragraph's end dropped", splice(written, end - 4, 4, "")]
		]

		for (const [name, bytes] of leaks) {
			const verdict = await proveWritten(source, change, bytes)

			expect({ name, ...verdict, whole: verdict.whole === "done" }).toEqual({ name, span: false, whole: false })
		}
	})

	it("is proved by the span only where the whole file's proof agrees", async () => {
		const source = await open(carrying(900))
		const change = edits(await typed(source, 450, "More "))
		const written = (await writeRtf(source, change)).bytes
		const end = indexOf(written, "\\par", indexOf(written, "More ")) + 4
		const after = written[end] === 0x7d ? end + 1 : end

		for (const text of ["\\b0 ", "\\i0 ", "{}", "{\\b}", "\\uc1 ", "\\fs24 ", "\\f0 ", "\\pard ", "\\par ", "x", "\\tab "]) {
			const verdict = await proveWritten(source, change, splice(written, after, 0, text))

			if (verdict.span) expect({ text, whole: verdict.whole }).toEqual({ text, whole: "done" })
		}
	})

	it("reads the same groups open from a checkpoint as from the start", async () => {
		const sources = [carrying(400), spelled(400)]
		const synthetic = sources.length
		const directory = join(CORPUS_DIR, "rtf")

		if (existsSync(directory))
			for (const name of readdirSync(directory)
				.filter(file => file.endsWith(".rtf"))
				.sort()
				.slice(0, 12))
				sources.push(new Uint8Array(readFileSync(join(directory, name))))

		for (const [index, bytes] of sources.entries()) {
			const read = await readRtf(bytes)

			if (index < synthetic) expect(read.ok).toBe(true)

			if (!read.ok) continue

			const checkpoints = (read.checkpoints?.list ?? []).filter(checkpoint => checkpoint.paragraphEnd >= 0 && !checkpoint.end)
			const positions = read.paragraphs.map(paragraph => paragraph.start).filter(start => start >= 0)
			const all = openGroups(bytes, positions)
			let compared = 0

			for (const position of positions) {
				const from = checkpoints.filter(checkpoint => checkpoint.offset <= position).at(-1) as Checkpoint | undefined

				if (from === undefined) continue

				expect(openGroups(bytes, [position], from).get(position)).toEqual(all.get(position))

				compared++
			}

			if (index < synthetic) expect(compared).toBeGreaterThan(0)
		}
	})

	it("writes random edits of random documents alike with and without the span", { timeout: 120_000 }, async () => {
		for (let seed = 1; seed <= 6; seed++) {
			const rand = rng(seed)
			const count = 300 + Math.floor(rand() * 500)
			const source = await open(seed % 2 === 0 ? spelled(count, rand) : carrying(count))

			for (let step = 0; step < 4; step++) {
				const index = Math.floor(rand() * count)
				const text = ["Typed ", "café ", "中文 ", "a\tb ", "x"][Math.floor(rand() * 5)] ?? "x"
				const change = edits(await typed(source, index, text, Math.floor(rand() * 8)))
				const written = await attempt(() => writeRtf(source, change))

				expect(written).toEqual(await attempt(() => writeRtf(source, change, { span: false })))

				if (written instanceof Uint8Array) {
					const verdict = await proveWritten(source, change, written)

					expect(verdict.whole).toBe("done")
				}
			}
		}
	})
})

describe.skipIf(!existsSync(join(CORPUS_DIR, "rtf")))("RTF writer, span proof over the corpus", () => {
	it("writes a typed edit of each file alike with and without the span", { timeout: 1_800_000 }, async () => {
		const directory = join(CORPUS_DIR, "rtf")
		const differ: string[] = []
		let proved = 0

		for (const name of readdirSync(directory)
			.filter(file => file.toLowerCase().endsWith(".rtf"))
			.sort()) {
			const source = await openRtfSource(new Uint8Array(readFileSync(join(directory, name))))

			if (source === undefined) continue

			const blocks = source.read.containers.find(container => container.kind === "body")?.blocks.length ?? 0
			let document: Uint8Array | undefined

			for (let index = Math.floor(blocks / 2); index < blocks && document === undefined; index++) {
				try {
					document = await typed(source, index, "Typed ")
				} catch {
					document = undefined
				}
			}

			if (document === undefined) continue

			const change = edits(document)
			const written = await attempt(() => writeRtf(source, change))
			const whole = await attempt(() => writeRtf(source, change, { span: false }))

			const same =
				typeof written === "string"
					? written === whole
					: whole instanceof Uint8Array && whole.length === written.length && written.every((byte, k) => byte === whole[k])

			if (!same) differ.push(name)

			if (written instanceof Uint8Array) {
				const verdict = await proveWritten(source, change, written)

				if (verdict.span) {
					proved++
					expect({ name, whole: verdict.whole }).toEqual({ name, whole: "done" })
				}
			}
		}

		expect(differ).toEqual([])
		expect(proved).toBeGreaterThan(0)
	})
})
