import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildDocxModel, openDocxPackage } from "@filen/office/core/docx"
import { bytesSource } from "@filen/office/core/opc"
import { readRtf } from "../core/rtf/index"
import { CORPUS_DIR } from "./corpusDir"
import { budget } from "./timing"

// Mutated RTF (control words, parameters, braces, \bin lengths, hex data, truncation, splices): the reader
// answers each with a document or a refusal, never a throw, within a time bound, and the docx engine opens
// what it writes.

const MUTANTS = Number(process.env["FILEN_OFFICE_RTF_FUZZ"] || "1500")
const SEED = Number(process.env["FILEN_OFFICE_RTF_FUZZ_SEED"] || "722")
// Per file: read and open the model. Generous for a loaded machine; typical is a few ms.
const BOUND_MS = 1_500

class Random {
	private state: number

	constructor(seed: number) {
		this.state = seed || 1
	}

	next(): number {
		this.state ^= this.state << 13
		this.state ^= this.state >>> 17
		this.state ^= this.state << 5

		return this.state >>> 0
	}

	below(limit: number): number {
		return limit <= 0 ? 0 : this.next() % limit
	}

	pick<T>(items: readonly T[]): T {
		return items[this.below(items.length)] as T
	}
}

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, character => character.charCodeAt(0) & 0xff)

const SYNTHETIC = [
	"{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fcharset0 Arial;}{\\f1\\fcharset2 Symbol;}{\\f2\\fcharset128 MS Mincho;}}{\\colortbl;\\red255\\green0\\blue0;}" +
		"{\\stylesheet{\\s0 Normal;}{\\s1\\sbasedon0\\snext0\\b heading 1;}{\\*\\cs2 \\additive Char;}}" +
		"{\\*\\listtable{\\list\\listtemplateid1{\\listlevel\\levelnfc0\\levelstartat1{\\leveltext\\'02\\'00.;}{\\levelnumbers\\'01;}\\fi-360\\li720}\\listid1}}" +
		"{\\*\\listoverridetable{\\listoverride\\listid1\\listoverridecount0\\ls1}}" +
		'\\sectd{\\header \\pard head\\par}\\pard\\s1 Title\\par{\\listtext 1.\\tab}\\pard\\ls1 item {\\field{\\*\\fldinst HYPERLINK "x"}{\\fldrslt link}}\\par' +
		"\\trowd\\cellx1000\\clmgf\\cellx2000\\clmrg\\cellx3000\\pard\\intbl a\\cell b\\cell c\\cell\\row" +
		"\\pard\\intbl\\itap2 n\\nestcell{\\*\\nesttableprops\\trowd\\cellx500\\nestrow}\\pard\\intbl o\\cell\\row" +
		"\\pard x{\\super\\chftn}{\\footnote \\pard\\chftn  note}\\f2 \\'82\\'a0\\f1 \\'b7\\uc1\\u945 ?{\\pict\\pngblip\\picw1\\pich1 89504e47}\\sect\\sectd\\lndscpsxn end\\par}",
	"{\\rtf1{\\*\\revtbl{Unknown;}{A;}}{\\revised\\revauth1 in}{\\deleted\\revauthdel1 out}{\\*\\atrfstart 1}c{\\*\\atrfend 1}{\\*\\atnauthor A}\\chatn{\\*\\annotation{\\*\\atnref 1}x}" +
		"{\\shp{\\*\\shpinst\\shpleft0\\shptop0\\shpright100\\shpbottom100{\\sp{\\sn pib}{\\sv {\\pict\\wmetafile8 0100090000030000}}}{\\shptxt t}}{\\shprslt r}}" +
		"{\\*\\do\\dptxbx{\\dptxbxtext\\pard box\\par}\\dpx1\\dpy1}\\pard\\phpg\\posx10 framed\\par{\\upr{a}{\\*\\ud{b}}}{\\info{\\title t}{\\creatim\\yr2020}}\\bin4 {}}x}"
]

function seeds(): Uint8Array[] {
	const out = SYNTHETIC.map(latin1)
	const directory = join(CORPUS_DIR, "rtf")

	if (existsSync(directory)) {
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name)

			if (name.endsWith(".rtf") && statSync(path).size <= 200_000) out.push(new Uint8Array(readFileSync(path)))
		}
	}

	return out
}

const WORDS = [
	"\\par",
	"\\cell",
	"\\row",
	"\\nestcell",
	"\\nestrow",
	"\\trowd",
	"\\cellx",
	"\\itap",
	"\\intbl",
	"\\sect",
	"\\sectd",
	"\\pard",
	"\\plain",
	"\\uc",
	"\\u",
	"\\bin",
	"\\'",
	"\\*",
	"\\fldinst",
	"\\fldrslt",
	"\\field",
	"\\footnote",
	"\\header",
	"\\pict",
	"\\shp",
	"\\ls",
	"\\s",
	"\\f",
	"\\fs",
	"\\upr",
	"\\do",
	"\\posx",
	"\\clmrg",
	"\\clvmgf",
	"{",
	"}",
	"\\"
]

const NUMBERS = ["", "0", "1", "-1", "2", "9", "32767", "-32768", "65535", "2147483647", "99999999999", "-4064"]

function mutate(seed: Uint8Array, random: Random): Uint8Array {
	let bytes = seed.slice()

	for (let count = 1 + random.below(6); count > 0; count--) {
		const at = random.below(bytes.length + 1)

		switch (random.below(6)) {
			case 0: {
				// A control word with an interesting parameter.
				const insert = latin1(`${random.pick(WORDS)}${random.pick(NUMBERS)}${random.below(2) === 0 ? " " : ""}`)
				const next = new Uint8Array(bytes.length + insert.length)

				next.set(bytes.subarray(0, at))
				next.set(insert, at)
				next.set(bytes.subarray(at), at + insert.length)
				bytes = next
				break
			}
			case 1:
				// A byte flipped (braces, backslashes, digits become something else).
				if (at < bytes.length) bytes[at] = random.pick([0x7b, 0x7d, 0x5c, 0x30, 0x39, 0x2d, 0x27, 0x20, 0x0a, random.next() & 0xff])
				break
			case 2:
				// Truncation.
				bytes = bytes.slice(0, at)
				break
			case 3: {
				// A slice removed.
				const end = Math.min(bytes.length, at + random.below(400))
				const next = new Uint8Array(bytes.length - (end - at))

				next.set(bytes.subarray(0, at))
				next.set(bytes.subarray(end), at)
				bytes = next
				break
			}
			case 4: {
				// A slice of the file spliced elsewhere (groups out of their context).
				const from = random.below(bytes.length)
				const piece = bytes.slice(from, Math.min(bytes.length, from + random.below(600)))
				const next = new Uint8Array(bytes.length + piece.length)

				next.set(bytes.subarray(0, at))
				next.set(piece, at)
				next.set(bytes.subarray(at), at + piece.length)
				bytes = next
				break
			}
			default: {
				// Deep nesting.
				const depth = random.below(2_000)
				const insert = latin1(`${"{".repeat(depth)}x${"}".repeat(random.below(depth + 1))}`)
				const next = new Uint8Array(bytes.length + insert.length)

				next.set(bytes.subarray(0, at))
				next.set(insert, at)
				next.set(bytes.subarray(at), at + insert.length)
				bytes = next
			}
		}
	}

	return bytes
}

describe("RTF reader fuzzing", () => {
	it("reads every mutant without throwing, in bounded time, into a package the docx engine opens", { timeout: 900_000 }, async () => {
		const sources = seeds()
		const random = new Random(SEED)
		const slow: string[] = []
		let read = 0

		for (let k = 0; k < MUTANTS; k++) {
			const seedIndex = random.below(sources.length)
			const bytes = mutate(sources[seedIndex] as Uint8Array, random)
			const started = performance.now()
			let failure: string | undefined

			try {
				const result = await readRtf(bytes)

				if (result.ok) {
					read++

					const opened = await openDocxPackage(bytesSource(result.docx))

					if (!opened.ok) failure = `package: ${opened.reason}`
					else {
						const model = await buildDocxModel(opened.package)

						if (model.malformed) failure = `malformed: ${model.malformedParts.join(", ")}`
					}
				}
			} catch (error) {
				failure = `threw: ${String(error)}`
			}

			const elapsed = performance.now() - started

			expect(failure, `mutant ${k} of source ${seedIndex} (seed ${SEED})`).toBeUndefined()

			if (elapsed > budget(BOUND_MS)) slow.push(`mutant ${k} of source ${seedIndex} (seed ${SEED}): ${Math.round(elapsed)} ms`)
		}

		expect(slow).toEqual([])
		expect(read).toBeGreaterThan(MUTANTS / 2)
	})
})
