import type { SliceClock } from "../../slicing"
import { parseXml, transcodeUtf16, XmlError } from "../../xml/index"
import { POOL_ENTRIES, SharedStrings } from "../model/sharedStrings"
import type { XlsxRichRun } from "../model/types"
import { XlsxReadError } from "./errors"
import type { XlsxLimits } from "./limits"
import { BANG, GT, LT, QUESTION, SLASH, Scanner, bytesAre, localIs, nameEnd, parseUint } from "./scan"
import { childByLocal, childElements, readFont } from "./styleRecords"

// The shared string table (ECMA-376 Part 1 §18.4.8 sst): each entry's text (its <t>, or its runs' <t>, phonetic
// runs left out), pooled. A rich entry's <si> is copied into one shared byte pool so its runs parse when asked for.

// Entries read between two looks at the clock.
const ENTRIES_PER_STEP = 4096

export async function readSharedStrings(
	input: Uint8Array,
	part: string,
	limits: XlsxLimits,
	clock: SliceClock | undefined
): Promise<SharedStrings> {
	const utf16 =
		(input[0] === 0xff && input[1] === 0xfe) ||
		(input[0] === 0xfe && input[1] === 0xff) ||
		(input[0] === 0x3c && input[1] === 0) ||
		(input[0] === 0 && input[1] === 0x3c)
	const bytes = utf16 ? transcodeUtf16(input, input[0] === 0xff || input[0] === 0xfe ? 2 : 0, input[0] === 0xff || input[1] === 0) : input
	const scanner = new Scanner(bytes, part)
	const rootStart = scanner.rootStart(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0)
	const rootName = nameEnd(bytes, rootStart + 1)
	const rootOpenEnd = scanner.tagEnd(rootStart)
	let count = -1

	if (!localIs(bytes, rootStart + 1, rootName, "sst")) scanner.fail("The shared strings part has no sst root", rootStart)

	scanner.attributes(rootStart, rootOpenEnd, (nameStart, nameStop, valueStart, valueEnd) => {
		if (bytesAre(bytes, nameStart, nameStop, "count")) count = parseUint(bytes, valueStart, valueEnd)
	})

	const pools: string[] = []
	let richPool = new Uint8Array(0)
	let richIndexes = new Uint32Array(0)
	let richEnds = new Uint32Array(0)
	let richLength = 0
	let richBytes = 0
	let starts = new Uint32Array(1024)
	let pieces: string[] = []
	let poolLength = 0
	let length = 0
	let at = rootOpenEnd

	// Entries come in index order, so the indexes stay ascending.
	const keepRich = (si: Uint8Array): void => {
		if (richLength === richIndexes.length) {
			const indexes = new Uint32Array(Math.max(64, richLength * 2))
			const ends = new Uint32Array(indexes.length)

			indexes.set(richIndexes)
			ends.set(richEnds)
			richIndexes = indexes
			richEnds = ends
		}

		if (richBytes + si.length > richPool.length) {
			const pool = new Uint8Array(Math.max(4096, richPool.length * 2, richBytes + si.length))

			pool.set(richPool.subarray(0, richBytes))
			richPool = pool
		}

		richPool.set(si, richBytes)
		richBytes += si.length
		richIndexes[richLength] = length
		richEnds[richLength++] = richBytes
	}

	const push = (text: string): void => {
		if (length === starts.length) {
			const grown = new Uint32Array(starts.length * 2)

			grown.set(starts)
			starts = grown
		}

		starts[length++] = poolLength
		pieces.push(text)
		poolLength += text.length

		if (length % POOL_ENTRIES === 0) {
			pools.push(pieces.join(""))
			pieces = []
			poolLength = 0
		}
	}

	if (!scanner.selfClosing) {
		for (;;) {
			const lt = bytes.indexOf(LT, at)

			if (lt < 0) scanner.fail("The sst element is not closed", rootStart)

			const next = bytes[lt + 1]

			if (next === SLASH) break

			if (next === BANG || next === QUESTION) {
				at = scanner.markupEnd(lt)

				continue
			}

			const name = nameEnd(bytes, lt + 1)

			if (!localIs(bytes, lt + 1, name, "si")) {
				at = scanner.elementEnd(lt)

				continue
			}

			if (length >= limits.maxSharedStrings) throw new XlsxReadError("tooLarge", "Too many shared strings", part)

			const tagEnd = scanner.tagEnd(lt)

			if (scanner.selfClosing) {
				push("")
				at = tagEnd
			} else {
				const entry = readEntry(scanner, tagEnd)

				if (entry.rich) keepRich(bytes.subarray(lt, entry.end))

				push(entry.text)
				at = entry.end
			}

			if (length % ENTRIES_PER_STEP === 0 && clock?.due === true) await clock.pause()
		}
	}

	if (pieces.length > 0) pools.push(pieces.join(""))

	const rich = {
		pool: richPool.slice(0, richBytes),
		indexes: richIndexes.slice(0, richLength),
		ends: richEnds.slice(0, richLength)
	}

	return new SharedStrings(count, pools, starts.slice(0, length), length, rich, parseRuns)
}

// One <si>'s text, whether it has runs, and where its end tag ends.
function readEntry(scanner: Scanner, contentStart: number): { text: string; rich: boolean; end: number } {
	const bytes = scanner.bytes
	let text = ""
	let rich = false
	let at = contentStart
	let depth = 0

	for (;;) {
		const lt = bytes.indexOf(LT, at)

		if (lt < 0) scanner.fail("A shared string is not closed", contentStart)

		const next = bytes[lt + 1]

		if (next === SLASH) {
			const close = bytes.indexOf(GT, lt)

			if (close < 0) scanner.fail("An end tag is not closed", lt)

			at = close + 1

			if (depth === 0) return { text, rich, end: at }

			depth--

			continue
		}

		if (next === BANG || next === QUESTION) {
			at = scanner.markupEnd(lt)

			continue
		}

		const name = nameEnd(bytes, lt + 1)

		if (localIs(bytes, lt + 1, name, "t")) {
			const tagEnd = scanner.tagEnd(lt)

			if (scanner.selfClosing) {
				at = tagEnd

				continue
			}

			const contentEnd = bytes.indexOf(LT, tagEnd)

			if (contentEnd >= 0 && bytes[contentEnd + 1] === SLASH) {
				text += scanner.characters(tagEnd, contentEnd)

				const close = bytes.indexOf(GT, contentEnd)

				if (close < 0) scanner.fail("An end tag is not closed", contentEnd)

				at = close + 1
			} else {
				text += scanner.text(tagEnd, false)
				at = scanner.textEnd
			}
		} else if (depth === 0 && localIs(bytes, lt + 1, name, "r")) {
			rich = true

			const tagEnd = scanner.tagEnd(lt)

			at = tagEnd

			if (!scanner.selfClosing) depth++
		} else {
			at = scanner.elementEnd(lt)
		}
	}
}

// A rich entry's runs (CT_RElt: rPr and t), from its <si> bytes.
function parseRuns(si: Uint8Array): readonly XlsxRichRun[] | null {
	try {
		const document = parseXml(si)
		const runs: XlsxRichRun[] = []

		for (const run of childElements(document, document.documentElement())) {
			if (document.localName(run) !== "r") continue

			const properties = childByLocal(document, run, "rPr")
			const t = childByLocal(document, run, "t")

			runs.push({ text: t < 0 ? "" : document.textContent(t), font: properties < 0 ? null : readFont(document, properties) })
		}

		return runs.length === 0 ? null : runs
	} catch (error) {
		if (error instanceof XmlError) return null

		throw error
	}
}
