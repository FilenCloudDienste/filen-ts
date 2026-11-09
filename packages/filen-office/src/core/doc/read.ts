import { CfbError, CfbFile, isCompoundFile } from "../cfb/index"
import { isEncryptedContainer } from "../encryption/container"
import { bytesSource, type ByteSource } from "../opc/io"
import { Bytes, le16, le32, utf16 } from "./bytes"
import { CLEAR_WORD_BYTES, cryptoApiHeaderProblem, type DocCipherScheme, type DocDecryption, docCipherScheme, docKey } from "./decrypt"
import { DocError, corrupt } from "./errors"
import { type DocFib, type FcName, readFib } from "./fib"
import { type FkpRuns, readChpxRuns, readPapxRuns, runCovering } from "./fkp"
import { readFonts } from "./fonts"
import { type DocLists, formatNumber, type ListLabel, ListNumberer, readLists } from "./lists"
import type {
	DocBlock,
	DocBookmark,
	DocComment,
	DocField,
	DocHeaderSet,
	DocIssue,
	DocModel,
	DocNote,
	DocNoteSeparators,
	DocParagraph,
	DocParagraphEnd,
	DocPlaceholder,
	DocRun,
	DocSection,
	DocStory,
	DocStoryKind,
	DocTable,
	DocTableRow,
	DocTextBox
} from "./model"
import { pcdFcAt, pieceAt, piecePrm, type Pieces, pieceText, readPieces } from "./pieces"
import {
	type DocChar,
	type DocPara,
	type DocRow,
	applyChar,
	applyPara,
	applySection,
	applyTable,
	defaultRow,
	defaultSection,
	dttm
} from "./props"
import { forEachPrl, sprmName } from "./sprms"
import { STK_TABLE, StyleResolver, readStyles } from "./styles"
import { readPlc, readSttb, readXst } from "./tables"

// [MS-DOC] reader: compound file → Fib → piece table → FKPs, styles and the Table-stream structures → DocModel.

export interface DocReadOptions {
	// Largest WordDocument/Table/Data stream accepted, in bytes.
	readonly maxStreamBytes?: number
	// The password to open an encrypted file; without it such a file is refused as "encrypted".
	readonly decryption?: DocDecryption
}

const DEFAULT_MAX_STREAM = 512 * 1024 * 1024
const MAX_FIELD_DEPTH = 64
const MAX_TABLE_DEPTH = 64

const STORY_ORDER: readonly DocStoryKind[] = [
	"main",
	"footnotes",
	"headers",
	"macro",
	"comments",
	"endnotes",
	"textboxes",
	"headerTextboxes"
]

interface Context {
	readonly fib: DocFib
	readonly word: Bytes
	readonly table: Bytes
	// sprmPHugePapx targets: PrcData grpprls from the Data stream by offset.
	readonly huge: ReadonlyMap<number, Uint8Array>
	readonly pieces: Pieces
	readonly text: string
	readonly issues: DocIssue[]
	readonly untyped: Map<string, number>
}

function noteUntyped(context: Context): (sprm: number) => void {
	return sprm => {
		const name = sprmName(sprm)

		context.untyped.set(name, (context.untyped.get(name) ?? 0) + 1)
	}
}

function fcLcb(context: Context, name: FcName): readonly [number, number] {
	return context.fib.fcLcb(name)
}

function unreadable(context: Context, name: string): void {
	context.issues.push({ code: "unreadableStructure", message: `${name} could not be read` })
}

// Optional structures fail alone: a corrupt bookmark table must not lose the text.
function optional<T>(context: Context, name: string, fallback: T, read: () => T): T {
	try {
		return read()
	} catch (error) {
		if (error instanceof DocError && error.code === "corrupt") {
			unreadable(context, name)

			return fallback
		}

		throw error
	}
}

async function readStream(cfb: CfbFile, name: string, max: number): Promise<Uint8Array | undefined> {
	const entry = cfb.entry([name])

	if (entry?.kind !== "stream") return undefined

	if (entry.size > max) throw new DocError("tooLarge", `${name} stream is ${entry.size} bytes`)

	return cfb.read(entry)
}

export async function readDoc(source: ByteSource, options: DocReadOptions = {}): Promise<DocModel> {
	return (await readDocFile(source, options)).model
}

// A read document with the streams beyond the text that pictures and embedded objects come from.
export interface DocFile {
	readonly model: DocModel
	// The Data stream (§2.1.3: PICF pictures, huge PAPX, form field data); undefined when the file has none.
	readonly data: Uint8Array | undefined
	// The WordDocument stream (the BLIP store's delay stream, §2.9.172 OfficeArtContent) and the Table stream.
	readonly word: Uint8Array
	readonly table: Uint8Array
	// The streams of the ObjectPool storage "_<objectId>" (an embedded OLE object), by name; undefined when absent.
	objectStreams(objectId: number): Promise<ReadonlyMap<string, Uint8Array> | undefined>
	// How the file was encrypted, when it was opened with its password (the streams above are decrypted).
	readonly encryption: DocCipherScheme | undefined
	// The file holds a VBA project: its Macros storage holds a VBA storage ([MS-DOC] Macros storage, [MS-OVBA]).
	readonly macros: boolean
}

const MAX_OBJECT_STREAMS = 64

export async function readDocFile(source: ByteSource, options: DocReadOptions = {}): Promise<DocFile> {
	const head = await source.read(0, Math.min(8, source.size))

	if (!isCompoundFile(head)) throw new DocError("notWordBinary", "not a compound file")

	let cfb: CfbFile

	try {
		cfb = await CfbFile.open(source)
	} catch (error) {
		if (error instanceof CfbError)
			throw new DocError(error.code === "tooLarge" || error.code === "tooManyEntries" ? "tooLarge" : "corrupt", error.message)

		throw error
	}

	if (isEncryptedContainer(cfb)) throw new DocError("encryptedPackage", "an encrypted OOXML package, not a Word binary document")

	const max = options.maxStreamBytes ?? DEFAULT_MAX_STREAM
	let wordBytes = await readCfb(() => readStream(cfb, "WordDocument", max))

	if (wordBytes === undefined) throw new DocError("notWordBinary", "no WordDocument stream")

	let fib = readFib(new Bytes(wordBytes, "WordDocument"))
	const tableName = fib.fWhichTblStm ? "1Table" : "0Table"
	let tableBytes = await readCfb(() => readStream(cfb, tableName, max))
	let data: Uint8Array | undefined
	let encryption: DocCipherScheme | undefined

	if (fib.fEncrypted) {
		const scheme = docCipherScheme(fib.fObfuscated, tableBytes)
		const damaged = scheme === "cryptoApiRc4" && tableBytes !== undefined ? cryptoApiHeaderProblem(tableBytes, fib.lKey) : undefined

		// A damaged EncryptionHeader is refused as such before any password is asked for (no password reads it).
		if (damaged !== undefined) throw corrupt(damaged)

		if (scheme === "unknown" || options.decryption === undefined)
			throw new DocError("encrypted", `the document is encrypted (${scheme})`, { encryption: scheme })

		if (tableBytes === undefined) throw corrupt(`no ${tableName} stream`)

		const decrypted = await decryptStreams(cfb, scheme, fib.lKey, wordBytes, tableBytes, options.decryption, max)

		wordBytes = decrypted.word
		tableBytes = decrypted.table
		data = decrypted.data
		encryption = scheme
		fib = readFib(new Bytes(wordBytes, "WordDocument"))
	}

	if (tableBytes === undefined) throw corrupt(`no ${tableName} stream`)

	const word = new Bytes(wordBytes, "WordDocument")
	const table = new Bytes(tableBytes, tableName)
	const dataEntry = cfb.entry(["Data"])
	const dataSource =
		encryption !== undefined
			? data === undefined
				? undefined
				: bytesSource(data)
			: dataEntry?.kind === "stream"
				? cfb.stream(dataEntry)
				: undefined
	const model = buildModel(fib, word, table, await readHugePapx(dataSource, word, table, fib))

	data ??= await readCfb(() => readStream(cfb, "Data", max))

	return {
		model,
		data,
		word: wordBytes,
		table: tableBytes,
		encryption,
		macros: cfb.entry(["Macros", "VBA"])?.kind === "storage",
		async objectStreams(objectId: number): Promise<ReadonlyMap<string, Uint8Array> | undefined> {
			const storage = cfb.entry(["ObjectPool", `_${String(objectId >>> 0)}`])

			if (storage?.kind !== "storage") return undefined

			const out = new Map<string, Uint8Array>()

			for (const child of storage.children.slice(0, MAX_OBJECT_STREAMS)) {
				if (child.kind !== "stream") continue
				if (child.size > max) throw new DocError("tooLarge", `${child.name} stream is ${child.size} bytes`)

				out.set(child.name, await readCfb(() => cfb.read(child)))
			}

			return out
		}
	}
}

interface DecryptedStreams {
	readonly word: Uint8Array
	readonly table: Uint8Array
	readonly data: Uint8Array | undefined
}

// The password is checked first ([MS-DOC] §2.2.6); then the WordDocument stream past FibBase, the Table stream past
// its EncryptionHeader (all of it for XOR) and the Data stream are decrypted into new arrays. FibBase in the decrypted
// copy says the document is not encrypted, so the Fib reads on as for any file.
async function decryptStreams(
	cfb: CfbFile,
	scheme: DocCipherScheme,
	lKey: number,
	word: Uint8Array,
	table: Uint8Array,
	decryption: DocDecryption,
	max: number
): Promise<DecryptedStreams> {
	const key = await docKey(scheme, lKey, table, decryption)

	try {
		const clearTable = scheme === "xor" ? 0 : lKey
		const plainWord = await key.decrypt(word, CLEAR_WORD_BYTES)
		const plainTable = await key.decrypt(table, clearTable)
		const data = await readCfb(() => readStream(cfb, "Data", max))
		const plainData = data === undefined ? undefined : await key.decrypt(data, 0)

		// FibBase.fEncrypted and fObfuscated (bits 8 and 15 of the flags at 10), lKey (14).
		plainWord[11] = (plainWord[11] ?? 0) & 0x7e
		plainWord.fill(0, 14, 18)

		return { word: plainWord, table: plainTable, data: plainData }
	} finally {
		key.wipe()
	}
}

// sprmPHugePapx (§2.6.2) moves a paragraph's sprms to a PrcData in the Data stream; only those ranges are read.
async function readHugePapx(data: ByteSource | undefined, word: Bytes, table: Bytes, fib: DocFib): Promise<Map<number, Uint8Array>> {
	const out = new Map<number, Uint8Array>()
	const offsets = new Set<number>()
	let papx: FkpRuns

	try {
		papx = readPapxRuns(word, table, ...fib.fcLcb("plcfBtePapx"))
	} catch {
		return out
	}

	for (let k = 0; k < papx.count; k++) {
		const at = papx.at[k] ?? 0
		const length = papx.length[k] ?? 0

		if (length < 2) continue

		forEachPrl(word.data, at + 2, at + length, (sprm, operand) => {
			if (sprm === SPRM_P_HUGE_PAPX) offsets.add(le32(word.data, operand))
		})
	}

	if (offsets.size === 0 || data === undefined) return out

	for (const offset of offsets) {
		if (offset + 2 > data.size) continue

		const head = await readCfb(() => data.read(offset, 2))
		const cb = le16(head, 0)

		if (offset + 2 + cb <= data.size) out.set(offset, await readCfb(() => data.read(offset + 2, cb)))
	}

	return out
}

const SPRM_P_HUGE_PAPX = 0x6646

async function readCfb<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read()
	} catch (error) {
		if (error instanceof CfbError) throw new DocError(error.code === "tooLarge" ? "tooLarge" : "corrupt", error.message)

		throw error
	}
}

function storiesOf(fib: DocFib, total: number): DocStory[] {
	const lengths = [fib.ccp.text, fib.ccp.ftn, fib.ccp.hdd, 0, fib.ccp.atn, fib.ccp.edn, fib.ccp.txbx, fib.ccp.hdrTxbx]
	const out: DocStory[] = []
	let at = 0

	STORY_ORDER.forEach((kind, k) => {
		const length = lengths[k] ?? 0
		const start = Math.min(at, total)
		const end = Math.min(at + length, total)

		out.push({ kind, start, end })
		at += length
	})

	return out
}

function storyOf(stories: readonly DocStory[], cp: number): DocStoryKind {
	for (const story of stories) if (cp >= story.start && cp < story.end) return story.kind

	return "main"
}

export function buildModel(fib: DocFib, word: Bytes, table: Bytes, huge: ReadonlyMap<number, Uint8Array> = new Map()): DocModel {
	const [fcClx, lcbClx] = fib.fcLcb("clx")
	const pieces = readPieces(table, fcClx, lcbClx, word.length)
	const { text, damagedPieces } = pieceText(word, pieces)
	const context: Context = { fib, word, table, huge, pieces, text, issues: [], untyped: new Map() }

	if (damagedPieces > 0)
		context.issues.push({ code: "damagedText", message: `${damagedPieces} pieces point outside the WordDocument stream` })

	const stories = storiesOf(fib, text.length)
	const styles = optional(context, "STSH", { styles: [], fonts: { ascii: 0, eastAsia: 0, other: 0, bi: 0 } }, () =>
		readStyles(table, ...fcLcb(context, "stshf"))
	)
	const resolver = new StyleResolver(styles)
	const fonts = optional(context, "SttbfFfn", [], () => readFonts(table, ...fcLcb(context, "sttbfFfn")))
	const lists = optional(context, "PlfLst/PlfLfo", { lists: [], instances: [] } satisfies DocLists, () =>
		readLists(table, fcLcb(context, "plfLst"), fcLcb(context, "plfLfo"))
	)
	const chpx = optional(context, "PlcBteChpx", emptyRuns(), () => readChpxRuns(word, table, ...fcLcb(context, "plcfBteChpx")))
	const papx = optional(context, "PlcBtePapx", emptyRuns(), () => readPapxRuns(word, table, ...fcLcb(context, "plcfBtePapx")))
	const sections = optional(context, "PlcfSed", [], () => readSections(context, stories))
	const sectionEnds = new Set(sections.map(section => section.end - 1))
	const paragraphs = readParagraphs(context, papx, resolver, lists, sectionEnds, stories)
	const runs = readRuns(context, chpx, resolver, paragraphs)
	const blocks = new Map<DocStoryKind, readonly DocBlock[]>()

	for (const story of stories) {
		if (story.end > story.start) blocks.set(story.kind, buildBlocks(context, paragraphs, story))
	}

	const headerStory = stories[2] ?? { kind: "headers" as const, start: 0, end: 0 }
	const hdd = optional(context, "PlcfHdd", { separators: noSeparators(), sets: [] as DocHeaderSet[] }, () =>
		readHeaders(context, headerStory)
	)
	const headerSets = inheritHeaderSets(hdd.sets, sections.length)

	return {
		fib,
		text,
		stories,
		paragraphs,
		runs,
		blocks,
		styles,
		fonts,
		lists,
		sections: sections.map((section, k) => ({ ...section, headers: headerSets[k] ?? NO_HEADERS })),
		noteSeparators: hdd.separators,
		footnotes: optional(context, "footnotes", [], () => readNotes(context, "plcffndRef", "plcffndTxt", stories[1], sections, false)),
		endnotes: optional(context, "endnotes", [], () => readNotes(context, "plcfendRef", "plcfendTxt", stories[5], sections, true)),
		comments: optional(context, "comments", [], () => readComments(context, stories[4])),
		fields: readFields(context, stories),
		bookmarks: optional(context, "bookmarks", [], () => readBookmarks(context)),
		revisionAuthors: optional(context, "SttbfRMark", [], () =>
			readSttb(table, ...fcLcb(context, "sttbfRMark")).map(entry => entry.text)
		),
		textBoxes: optional(context, "text boxes", [], () => readTextBoxes(context, stories)),
		placeholders: readPlaceholders(context, runs, stories),
		dop: optional(context, "Dop", new Uint8Array(0), () => table.slice(...fcLcb(context, "dop"), "Dop")),
		defaultChar: resolver.defaultChar,
		untypedSprms: context.untyped,
		issues: context.issues
	}
}

function emptyRuns(): FkpRuns {
	return { fcStart: new Uint32Array(0), fcEnd: new Uint32Array(0), at: new Uint32Array(0), length: new Uint16Array(0), count: 0 }
}

// Walks pieces and the characters of `text` in CP order, tracking the current piece.
class PieceCursor {
	private piece = 0
	private readonly pieces: Pieces

	constructor(pieces: Pieces) {
		this.pieces = pieces
	}

	at(cp: number): number {
		const pieces = this.pieces

		if (this.piece < pieces.count && cp >= (pieces.cps[this.piece] ?? 0) && cp < (pieces.cps[this.piece + 1] ?? 0)) return this.piece

		const found = pieceAt(pieces, cp)

		if (found >= 0) this.piece = found

		return found
	}
}

function readParagraphs(
	context: Context,
	papx: FkpRuns,
	resolver: StyleResolver,
	lists: DocLists,
	sectionEnds: ReadonlySet<number>,
	stories: readonly DocStory[]
): DocParagraph[] {
	const { text, pieces, word, table } = context
	const cursor = new PieceCursor(pieces)
	const out: DocParagraph[] = []
	const numberers = new Map<DocStoryKind, ListNumberer>()
	const cache = new Map<string, DocPara>()
	const untyped = noteUntyped(context)
	let start = 0

	const finish = (end: number, mark: number, run: number, piece: number): void => {
		let istd = 0
		let direct: Uint8Array | undefined

		if (run >= 0) {
			const length = papx.length[run] ?? 0
			const at = papx.at[run] ?? 0

			if (length >= 2) {
				istd = le16(word.data, at)
				direct = word.data.subarray(at + 2, at + length)
			}
		}

		const pieceDirect = piece >= 0 ? piecePrm(table, pieces, piece) : undefined
		// Paragraphs sharing a PAPX and a piece Prm share one property object.
		const key = `${run >= 0 ? (papx.at[run] ?? 0) : -1}:${piece >= 0 ? (pieces.prms[piece] ?? 0) : -1}`
		let props = cache.get(key)

		if (props === undefined) {
			const style = resolver.resolve(istd).para

			props = { ...style, tabs: [...style.tabs], istd }

			if (direct !== undefined) applyPara(props, direct, 0, direct.length, untyped)
			if (pieceDirect !== undefined) applyPara(props, pieceDirect, 0, pieceDirect.length, untyped)

			if (props.hugePapx !== undefined) {
				const huge = context.huge.get(props.hugePapx)

				if (huge !== undefined) applyPara(props, huge, 0, huge.length, untyped)
				else unreadable(context, "sprmPHugePapx grpprl")
			}

			cache.set(key, props)
		}

		if (props.hugePapx !== undefined) direct = context.huge.get(props.hugePapx) ?? direct

		const depth = props.itap > 0 ? props.itap : props.inTable ? 1 : 0
		let ending: DocParagraphEnd = "paragraph"

		if (mark === 0x07) ending = depth >= 1 && props.ttp ? "row" : "cell"
		else if (mark === 0x0d && depth > 1) ending = props.innerTtp ? "row" : props.innerCell ? "cell" : "paragraph"
		else if (mark === 0x0c) ending = "section"
		else if (mark !== 0x0d) ending = "none"

		let row: DocRow | undefined

		if (ending === "row") {
			row = defaultRow()

			const styleIstd = tableStyleOf(direct, pieceDirect)
			const style = styleIstd === undefined ? undefined : resolver.style(styleIstd)

			if (style?.stk === STK_TABLE) {
				const styled = resolver.resolve(styleIstd ?? 0).row

				if (styled !== undefined) row = { ...styled, cells: [], padding: [...styled.padding] }
			}

			if (direct !== undefined) applyTable(row, direct, 0, direct.length, untyped)
			if (pieceDirect !== undefined) applyTable(row, pieceDirect, 0, pieceDirect.length, untyped)
		}

		let list: ListLabel | undefined

		if (props.ilfo > 0 && ending !== "row") {
			const story = storyOf(stories, start)
			let numberer = numberers.get(story)

			if (numberer === undefined) {
				numberer = new ListNumberer(lists)
				numberers.set(story, numberer)
			}

			list = numberer.next(props.ilfo, props.ilvl)

			// §2.4.6.6 part 2 step 3: the list's paragraph properties apply after the direct ones.
			if (list !== undefined && list.level.papx.length > 0) {
				const listKey = `${key}:${props.ilfo}:${props.ilvl}`
				let listed = cache.get(listKey)

				if (listed === undefined) {
					listed = { ...props, tabs: [...props.tabs] }
					applyPara(listed, list.level.papx, 0, list.level.papx.length, untyped)
					cache.set(listKey, listed)
				}

				props = listed
			}
		}

		out.push({ start, end, ending, props, depth: Math.min(depth, MAX_TABLE_DEPTH), row, list, direct, pieceDirect })
		start = end
	}

	for (let cp = 0; cp < text.length; cp++) {
		const code = text.charCodeAt(cp)

		if (code !== 0x0d && code !== 0x07 && code !== 0x0c) continue

		const piece = cursor.at(cp)
		const fc = piece < 0 ? -1 : pcdFcAt(pieces, piece, cp)
		const run = fc < 0 ? -1 : runCovering(papx, fc)

		if (code !== 0x0d) {
			const width = pieces.compressed[piece] === 1 ? 1 : 2
			const boundary = run >= 0 && fc + width === (papx.fcEnd[run] ?? 0)

			if (code === 0x0c && !(boundary || sectionEnds.has(cp))) continue

			if (code === 0x07 && !boundary && !inTable(word, papx, run)) continue
		}

		finish(cp + 1, code, run, piece)
	}

	if (start < text.length) finish(text.length, 0, -1, -1)

	return out
}

function inTable(word: Bytes, papx: FkpRuns, run: number): boolean {
	if (run < 0) return false

	const length = papx.length[run] ?? 0
	const at = papx.at[run] ?? 0
	let found = false

	if (length >= 2) {
		forEachPrl(word.data, at + 2, at + length, (sprm, operand) => {
			if ((sprm === 0x2416 && (word.data[operand] ?? 0) !== 0) || (sprm === 0x6649 && le32(word.data, operand) !== 0)) found = true
		})
	}

	return found
}

function tableStyleOf(direct: Uint8Array | undefined, pieceDirect: Uint8Array | undefined): number | undefined {
	let istd: number | undefined

	for (const grpprl of [direct, pieceDirect]) {
		if (grpprl === undefined) continue

		forEachPrl(grpprl, 0, grpprl.length, (sprm, at) => {
			if (sprm === 0x563a) istd = le16(grpprl, at)
		})
	}

	return istd
}

function charStyleOf(grpprl: Uint8Array | undefined, current: number | undefined): number | undefined {
	let istd = current

	if (grpprl !== undefined) {
		forEachPrl(grpprl, 0, grpprl.length, (sprm, at) => {
			if (sprm === 0x4a30) istd = le16(grpprl, at)
		})
	}

	return istd
}

function readRuns(context: Context, chpx: FkpRuns, resolver: StyleResolver, paragraphs: readonly DocParagraph[]): DocRun[] {
	const { pieces, word, table, text } = context
	const out: DocRun[] = []
	const cache = new Map<string, DocChar>()
	const untyped = noteUntyped(context)
	let paragraph = 0

	const emit = (start: number, end: number, run: number, piece: number): void => {
		// A run never spans paragraphs: split at each paragraph end.
		for (let at = start; at < end;) {
			while (paragraph < paragraphs.length && (paragraphs[paragraph]?.end ?? 0) <= at) paragraph++

			const owner = paragraphs[paragraph]
			const stop = Math.min(end, owner?.end ?? end)
			const paraIstd = owner?.props.istd ?? 0
			const length = run >= 0 ? (chpx.length[run] ?? 0) : 0
			const direct = length > 0 ? word.data.subarray(chpx.at[run] ?? 0, (chpx.at[run] ?? 0) + length) : undefined
			const pieceDirect = piecePrm(table, pieces, piece)
			const key = `${paraIstd}:${run >= 0 && length > 0 ? (chpx.at[run] ?? 0) : -1}:${pieces.prms[piece] ?? 0}`
			let props = cache.get(key)

			if (props === undefined) {
				const charIstd = charStyleOf(pieceDirect, charStyleOf(direct, undefined)) ?? 10
				const base = resolver.charBase(paraIstd, charIstd)
				const next = { ...base }
				const charContext = { style: base, paragraphStyle: resolver.resolve(paraIstd).char, untyped }

				if (direct !== undefined) applyChar(next, direct, 0, direct.length, charContext)
				if (pieceDirect !== undefined) applyChar(next, pieceDirect, 0, pieceDirect.length, charContext)

				props = next
				cache.set(key, props)
			}

			out.push({ start: at, end: stop, props, direct, pieceDirect })
			at = stop
		}
	}

	for (let piece = 0; piece < pieces.count; piece++) {
		const cpStart = Math.min(pieces.cps[piece] ?? 0, text.length)
		const cpEnd = Math.min(pieces.cps[piece + 1] ?? 0, text.length)

		if (cpEnd <= cpStart) continue

		const width = pieces.compressed[piece] === 1 ? 1 : 2
		const fcStart = pieces.fcs[piece] ?? 0
		const fcEnd = fcStart + width * (cpEnd - cpStart)
		let cp = cpStart
		let run = runCovering(chpx, fcStart)

		if (run < 0) {
			// The first run starting inside the piece.
			let low = 0
			let high = chpx.count

			while (low < high) {
				const middle = (low + high) >> 1

				if ((chpx.fcStart[middle] ?? 0) < fcStart) low = middle + 1
				else high = middle
			}

			run = low
		}

		for (; cp < cpEnd && run < chpx.count; run++) {
			const runStart = Math.max(chpx.fcStart[run] ?? 0, fcStart)
			const runEnd = Math.min(chpx.fcEnd[run] ?? 0, fcEnd)

			if (runStart >= fcEnd) break
			if (runEnd <= runStart) continue

			const from = cpStart + Math.floor((runStart - fcStart) / width)
			const to = cpStart + Math.ceil((runEnd - fcStart) / width)

			// Text not covered by any Chpx keeps the style's properties.
			if (from > cp) emit(cp, from, -1, piece)

			if (to > Math.max(cp, from)) emit(Math.max(cp, from), to, run, piece)

			cp = Math.max(cp, to)
		}

		if (cp < cpEnd) emit(cp, cpEnd, -1, piece)
	}

	return out
}

// Nests a story's paragraphs into tables by depth (§2.4.3): iterative, depth capped.
function buildBlocks(context: Context, paragraphs: readonly DocParagraph[], story: DocStory): DocBlock[] {
	interface OpenTable {
		readonly depth: number
		readonly rows: DocTableRow[]
		cells: DocBlock[][]
		cell: DocBlock[]
	}

	const root: DocBlock[] = []
	const stack: OpenTable[] = []
	const target = (): DocBlock[] => stack.at(-1)?.cell ?? root

	const close = (): void => {
		const open = stack.pop()

		if (open === undefined) return

		if (open.cell.length > 0 || open.cells.length > 0) {
			context.issues.push({ code: "unbalancedTable", message: `a table at depth ${open.depth} ends inside a row` })

			if (open.cell.length > 0) open.cells.push(open.cell)

			open.rows.push({ mark: -1, cells: open.cells })
		}

		const table: DocTable = { kind: "table", depth: open.depth, rows: open.rows }

		target().push(table)
	}

	for (let index = 0; index < paragraphs.length; index++) {
		const paragraph = paragraphs[index]

		if (paragraph === undefined || paragraph.end <= story.start) continue
		if (paragraph.start >= story.end) break

		const depth = paragraph.depth

		while (stack.length > depth) close()

		while (stack.length < depth) stack.push({ depth: stack.length + 1, rows: [], cells: [], cell: [] })

		const open = stack.at(-1)

		if (open === undefined) {
			root.push({ kind: "paragraph", index })
			continue
		}

		if (paragraph.ending === "row") {
			if (open.cell.length > 0) open.cells.push(open.cell)

			open.rows.push({ mark: index, cells: open.cells })
			open.cells = []
			open.cell = []
			continue
		}

		open.cell.push({ kind: "paragraph", index })

		if (paragraph.ending === "cell") {
			open.cells.push(open.cell)
			open.cell = []
		}
	}

	while (stack.length > 0) close()

	return root
}

function readSections(context: Context, stories: readonly DocStory[]): Omit<DocSection, "headers">[] {
	const { table, word } = context
	const [fc, lcb] = fcLcb(context, "plcfSed")
	const main = stories[0]
	const mainEnd = main?.end ?? 0

	if (lcb === 0) return [{ start: 0, end: mainEnd, props: defaultSection(), direct: undefined }]

	const plc = readPlc(table, fc, lcb, 12)

	if (plc === undefined) throw corrupt("PlcfSed size is invalid")

	const out: Omit<DocSection, "headers">[] = []
	const untyped = noteUntyped(context)

	for (let k = 0; k < plc.count; k++) {
		const start = Math.min(plc.cps[k] ?? 0, mainEnd)
		const end = Math.min(plc.cps[k + 1] ?? 0, mainEnd)
		const fcSepx = table.u32(plc.dataAt + 12 * k + 2)
		const props = defaultSection()
		let direct: Uint8Array | undefined

		if (fcSepx !== 0xffffffff && word.has(fcSepx, 2)) {
			const cb = word.i16(fcSepx)

			if (cb > 0 && word.has(fcSepx + 2, cb)) {
				direct = word.data.subarray(fcSepx + 2, fcSepx + 2 + cb)
				applySection(props, direct, 0, direct.length, untyped)
			}
		}

		if (end > start || out.length === 0) out.push({ start, end, props, direct })
	}

	return out
}

function noSeparators(): DocNoteSeparators {
	return {
		footnoteSeparator: undefined,
		footnoteContinuationSeparator: undefined,
		footnoteContinuationNotice: undefined,
		endnoteSeparator: undefined,
		endnoteContinuationSeparator: undefined,
		endnoteContinuationNotice: undefined
	}
}

// Plcfhdd (§2.8.20): six note separator stories, then six stories per section (even/odd header, even/odd footer,
// first header, first footer). An empty story means "same as the previous section".
function readHeaders(context: Context, story: DocStory): { separators: DocNoteSeparators; sets: DocHeaderSet[] } {
	const [fc, lcb] = fcLcb(context, "plcfHdd")
	const plc = readPlc(context.table, fc, lcb, 0)

	if (plc === undefined) {
		if (lcb !== 0) throw corrupt("Plcfhdd size is invalid")

		return { separators: noSeparators(), sets: [] }
	}

	// All but the last two CPs start stories.
	const count = Math.max(0, plc.count - 1)
	const at = (k: number): DocStory | undefined => {
		if (k >= count) return undefined

		const start = story.start + (plc.cps[k] ?? 0)
		const end = story.start + (plc.cps[k + 1] ?? 0)

		return end > start && end <= story.end ? { kind: "headers", start, end } : undefined
	}
	const sets: DocHeaderSet[] = []

	for (let base = 6; base < count; base += 6) {
		sets.push({
			evenHeader: at(base),
			oddHeader: at(base + 1),
			evenFooter: at(base + 2),
			oddFooter: at(base + 3),
			firstHeader: at(base + 4),
			firstFooter: at(base + 5)
		})
	}

	return {
		separators: {
			footnoteSeparator: at(0),
			footnoteContinuationSeparator: at(1),
			footnoteContinuationNotice: at(2),
			endnoteSeparator: at(3),
			endnoteContinuationSeparator: at(4),
			endnoteContinuationNotice: at(5)
		},
		sets
	}
}

const NO_HEADERS: DocHeaderSet = {
	evenHeader: undefined,
	oddHeader: undefined,
	evenFooter: undefined,
	oddFooter: undefined,
	firstHeader: undefined,
	firstFooter: undefined
}

// Each header kind falls back to the nearest earlier section that has one (one pass over all sections).
function inheritHeaderSets(sets: readonly DocHeaderSet[], count: number): DocHeaderSet[] {
	const out: DocHeaderSet[] = []
	let current = NO_HEADERS

	for (let k = 0; k < count; k++) {
		const own = sets[k]

		if (own !== undefined) {
			current = {
				evenHeader: own.evenHeader ?? current.evenHeader,
				oddHeader: own.oddHeader ?? current.oddHeader,
				evenFooter: own.evenFooter ?? current.evenFooter,
				oddFooter: own.oddFooter ?? current.oddFooter,
				firstHeader: own.firstHeader ?? current.firstHeader,
				firstFooter: own.firstFooter ?? current.firstFooter
			}
		}

		out.push(current)
	}

	return out
}

function readNotes(
	context: Context,
	refName: FcName,
	textName: FcName,
	story: DocStory | undefined,
	sections: readonly Omit<DocSection, "headers">[],
	endnotes: boolean
): DocNote[] {
	const refs = readPlc(context.table, ...fcLcb(context, refName), 2)
	const texts = readPlc(context.table, ...fcLcb(context, textName), 0)

	if (refs === undefined || texts === undefined || story === undefined) return []

	const out: DocNote[] = []
	let section = -1
	let number = 1

	for (let k = 0; k < refs.count && k + 1 < texts.cps.length; k++) {
		const start = story.start + (texts.cps[k] ?? 0)
		const end = Math.min(story.end, story.start + (texts.cps[k + 1] ?? 0))
		const reference = refs.cps[k] ?? 0
		const auto = context.table.i16(refs.dataAt + 2 * k) > 0
		let owner = Math.max(0, section)

		while (owner + 1 < sections.length && reference >= (sections[owner + 1]?.start ?? Infinity)) owner++

		const props = sections[owner]?.props

		if (owner !== section) {
			const restart = endnotes ? props?.endnoteRestart : props?.footnoteRestart
			const first = endnotes ? props?.endnoteStart : props?.footnoteStart

			// rnc 1: restart each section (§2.6.4 sprmSRncFtn); the first section starts at its own start value.
			if (section < 0 || restart === 1) number = first ?? 1

			section = owner
		}

		const format = (endnotes ? props?.endnoteFormat : props?.footnoteFormat) ?? (endnotes ? 2 : 0)

		// With rnc 2 (restart on each page) the shown number depends on layout; the label counts on through the section.
		out.push({
			reference,
			auto,
			label: auto ? formatNumber(number, format) : undefined,
			text: { kind: story.kind, start, end: Math.max(start, end) }
		})

		if (auto) number++
	}

	return out
}

function readComments(context: Context, story: DocStory | undefined): DocComment[] {
	const { table } = context
	const refs = readPlc(table, ...fcLcb(context, "plcfandRef"), 30)
	const texts = readPlc(table, ...fcLcb(context, "plcfandTxt"), 0)

	if (refs === undefined || texts === undefined || story === undefined) return []

	const [fcOwners, lcbOwners] = fcLcb(context, "grpXstAtnOwners")
	const owners: string[] = []

	if (lcbOwners > 0 && table.has(fcOwners, lcbOwners)) {
		for (let at = fcOwners; at + 2 <= fcOwners + lcbOwners;) {
			const [name, next] = readXst(table, at)

			owners.push(name)
			at = next
		}
	}

	// Comment ranges: SttbfAtnBkmk entries carry ATNBE.lTag; PlcfAtnBkf/Bkl give the CPs.
	const ranges = new Map<number, readonly [number, number]>()
	const tags = optional(context, "SttbfAtnBkmk", [], () => readSttb(table, ...fcLcb(context, "sttbfAtnBkmk")))
	const starts = readPlc(table, ...fcLcb(context, "plcfAtnBkf"), 4)
	const ends = readPlc(table, ...fcLcb(context, "plcfAtnBkl"), 0)

	if (starts !== undefined && ends !== undefined) {
		tags.forEach((entry, k) => {
			if (entry.extra.length < 6 || k >= starts.count) return

			const tag = le32(entry.extra, 2)
			const ibkl = table.u16(starts.dataAt + 4 * k)
			const end = ends.cps[ibkl]

			if (end !== undefined && ibkl < ends.count) ranges.set(tag, [starts.cps[k] ?? 0, end])
		})
	}

	// AtrdExtra: 18-byte ATRDPost10s parallel to the ATRDPre10s, dttm first; absent before Word 2002.
	const [fcExtra, lcbExtra] = fcLcb(context, "atrdExtra")
	const dated = lcbExtra >= 18 && table.has(fcExtra, lcbExtra) ? Math.floor(lcbExtra / 18) : 0
	const out: DocComment[] = []

	for (let k = 0; k < refs.count && k + 1 < texts.cps.length; k++) {
		const at = refs.dataAt + 30 * k
		const cch = Math.min(9, table.u16(at))
		const initials = utf16(table.data, at + 2, cch)
		const ibst = table.i16(at + 20)
		const range = ranges.get(table.u32(at + 26))
		const start = story.start + (texts.cps[k] ?? 0)

		out.push({
			reference: refs.cps[k] ?? 0,
			text: { kind: "comments", start, end: Math.max(start, Math.min(story.end, story.start + (texts.cps[k + 1] ?? 0))) },
			author: owners[ibst] ?? "",
			initials,
			date: k < dated ? dttm(table.u32(fcExtra + 18 * k)) : undefined,
			rangeStart: range?.[0],
			rangeEnd: range?.[1]
		})
	}

	return out
}

const FIELD_PLCS: readonly (readonly [FcName, number])[] = [
	["plcfFldMom", 0],
	["plcfFldFtn", 1],
	["plcfFldHdr", 2],
	["plcfFldAtn", 4],
	["plcfFldEdn", 5],
	["plcfFldTxbx", 6],
	["plcffldHdrTxbx", 7]
]

function readFields(context: Context, stories: readonly DocStory[]): DocField[] {
	const out: DocField[] = []

	for (const [name, storyIndex] of FIELD_PLCS) {
		const story = stories[storyIndex]

		if (story === undefined) continue

		optional(context, name, undefined, () => {
			const plc = readPlc(context.table, ...fcLcb(context, name), 2)

			if (plc === undefined) {
				if (fcLcb(context, name)[1] !== 0) unreadable(context, name)

				return undefined
			}

			const stack: { begin: number; separator: number | undefined; type: number }[] = []

			for (let k = 0; k < plc.count; k++) {
				const cp = story.start + (plc.cps[k] ?? 0)
				const ch = context.table.u8(plc.dataAt + 2 * k) & 0x1f
				const value = context.table.u8(plc.dataAt + 2 * k + 1)

				if (ch === 0x13) {
					if (stack.length >= MAX_FIELD_DEPTH) {
						context.issues.push({ code: "unbalancedField", message: `fields nest deeper than ${MAX_FIELD_DEPTH}` })
						return undefined
					}

					stack.push({ begin: cp, separator: undefined, type: value })
				} else if (ch === 0x14) {
					const open = stack.at(-1)

					if (open === undefined)
						context.issues.push({ code: "unbalancedField", message: `field separator at ${cp} outside a field` })
					else open.separator = cp
				} else if (ch === 0x15) {
					const open = stack.pop()

					if (open === undefined) context.issues.push({ code: "unbalancedField", message: `field end at ${cp} outside a field` })
					else
						out.push({
							begin: open.begin,
							separator: open.separator,
							end: cp,
							type: open.type,
							flags: value,
							story: story.kind
						})
				}
			}

			if (stack.length > 0)
				context.issues.push({ code: "unbalancedField", message: `${stack.length} fields in ${story.kind} never end` })

			return undefined
		})
	}

	return out.sort((a, b) => a.begin - b.begin)
}

function readBookmarks(context: Context): DocBookmark[] {
	const { table } = context
	const names = readSttb(table, ...fcLcb(context, "sttbfBkmk"))
	const starts = readPlc(table, ...fcLcb(context, "plcfBkf"), 4)
	const ends = readPlc(table, ...fcLcb(context, "plcfBkl"), 0)

	if (starts === undefined || ends === undefined) return []

	const out: DocBookmark[] = []

	for (let k = 0; k < starts.count && k < names.length; k++) {
		const ibkl = table.u16(starts.dataAt + 4 * k)
		const bkc = table.u16(starts.dataAt + 4 * k + 2)

		if (ibkl >= ends.count) continue

		const columnar = (bkc & 0x8000) !== 0

		out.push({
			name: names[k]?.text ?? "",
			start: starts.cps[k] ?? 0,
			end: ends.cps[ibkl] ?? 0,
			column: columnar ? bkc & 0x7f : undefined
		})
	}

	return out
}

function readTextBoxes(context: Context, stories: readonly DocStory[]): DocTextBox[] {
	const out: DocTextBox[] = []

	for (const [name, storyIndex, header] of [
		["plcftxbxTxt", 6, false],
		["plcfHdrtxbxTxt", 7, true]
	] as const) {
		const story = stories[storyIndex]
		const plc = readPlc(context.table, ...fcLcb(context, name), 22)

		if (plc === undefined || story === undefined) {
			if (fcLcb(context, name)[1] !== 0) unreadable(context, name)

			continue
		}

		// The last entry is a terminator.
		for (let k = 0; k + 1 < plc.count; k++) {
			const start = story.start + (plc.cps[k] ?? 0)
			const end = Math.min(story.end, story.start + (plc.cps[k + 1] ?? 0))
			const at = plc.dataAt + 22 * k
			const reusable = context.table.i16(at + 8) !== 0

			if (end <= start || reusable) continue

			out.push({ story: { kind: story.kind, start, end }, header, spid: context.table.i32(at + 14) })
		}
	}

	return out
}

function readPlaceholders(context: Context, runs: readonly DocRun[], stories: readonly DocStory[]): DocPlaceholder[] {
	const { text, table } = context
	const out: DocPlaceholder[] = []
	const shapes = new Map<number, DocPlaceholder>()

	for (const [name, storyIndex, header] of [
		["plcSpaMom", 0, false],
		["plcSpaHdr", 2, true]
	] as const) {
		const plc = readPlc(table, ...fcLcb(context, name), 26)
		const story = stories[storyIndex]

		if (plc === undefined || story === undefined) {
			if (fcLcb(context, name)[1] !== 0) unreadable(context, name)

			continue
		}

		for (let k = 0; k < plc.count; k++) {
			const at = plc.dataAt + 26 * k
			const flags = table.u16(at + 20)
			const cp = story.start + (plc.cps[k] ?? 0)

			shapes.set(cp, {
				kind: "shape",
				cp,
				spid: table.i32(at),
				header,
				left: table.i32(at + 4),
				top: table.i32(at + 8),
				right: table.i32(at + 12),
				bottom: table.i32(at + 16),
				relativeH: (flags >> 1) & 3,
				relativeV: (flags >> 3) & 3,
				wrap: (flags >> 5) & 0xf,
				wrapSide: (flags >> 9) & 0xf,
				behindText: (flags & 0x4000) !== 0
			})
		}
	}

	for (const run of runs) {
		if (!run.props.special) continue

		for (let cp = run.start; cp < run.end; cp++) {
			const code = text.charCodeAt(cp)

			if (code === 0x01) {
				if (run.props.data && run.props.picLocation !== undefined)
					out.push({ kind: "formField", cp, dataOffset: run.props.picLocation })
				else if (run.props.ole2 && run.props.picLocation !== undefined)
					out.push({ kind: "ole", cp, objectId: run.props.picLocation })
				else if (run.props.picLocation !== undefined) out.push({ kind: "picture", cp, dataOffset: run.props.picLocation })
				else out.push({ kind: "unresolvedObject", cp, char: code })
			} else if (code === 0x08) {
				out.push(shapes.get(cp) ?? { kind: "unresolvedObject", cp, char: code })
			}
		}
	}

	return out
}
