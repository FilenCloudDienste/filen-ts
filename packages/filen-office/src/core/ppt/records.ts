import { PresentationError } from "../presentation/model"
import { tooLarge } from "../presentation/refusal"

// [MS-PPT] records (§2.3.1 RecordHeader: recVer:4 recInstance:12 recType:16 recLen:32) over one decoded stream, the
// record types the reader uses (§2.13.24), and the reader's hostile-input budgets. A record never reaches past its
// container: a length running over is a malformed file, refused, never read from the next record's bytes.

export const RT = {
	document: 0x03e8,
	documentAtom: 0x03e9,
	endDocumentAtom: 0x03ea,
	slide: 0x03ee,
	slideAtom: 0x03ef,
	notes: 0x03f0,
	notesAtom: 0x03f1,
	environment: 0x03f2,
	slidePersistAtom: 0x03f3,
	mainMaster: 0x03f8,
	slideShowSlideInfoAtom: 0x03f9,
	externalObjectList: 0x0409,
	drawingGroup: 0x040b,
	drawing: 0x040c,
	roundTripTheme12Atom: 0x040e,
	namedShows: 0x0410,
	namedShow: 0x0411,
	namedShowSlidesAtom: 0x0412,
	list: 0x07d0,
	fontCollection: 0x07d5,
	colorSchemeAtom: 0x07f0,
	externalObjectRefAtom: 0x0bc1,
	placeholderAtom: 0x0bc3,
	outlineTextRefAtom: 0x0f9e,
	textHeaderAtom: 0x0f9f,
	textCharsAtom: 0x0fa0,
	styleTextPropAtom: 0x0fa1,
	masterTextPropAtom: 0x0fa2,
	textMasterStyleAtom: 0x0fa3,
	textRulerAtom: 0x0fa6,
	textBytesAtom: 0x0fa8,
	textSpecialInfoAtom: 0x0faa,
	fontEntityAtom: 0x0fb7,
	cString: 0x0fba,
	handout: 0x0fc9,
	externalHyperlinkAtom: 0x0fd3,
	externalHyperlink: 0x0fd7,
	slideNumberMetaCharAtom: 0x0fd8,
	headersFooters: 0x0fd9,
	headersFootersAtom: 0x0fda,
	textInteractiveInfoAtom: 0x0fdf,
	slideListWithText: 0x0ff0,
	interactiveInfo: 0x0ff2,
	interactiveInfoAtom: 0x0ff3,
	userEditAtom: 0x0ff5,
	currentUserAtom: 0x0ff6,
	dateTimeMetaCharAtom: 0x0ff7,
	genericDateMetaCharAtom: 0x0ff8,
	headerMetaCharAtom: 0x0ff9,
	footerMetaCharAtom: 0x0ffa,
	rtfDateTimeMetaCharAtom: 0x1015,
	vbaInfo: 0x03ff,
	vbaInfoAtom: 0x0400,
	externalOleEmbed: 0x0fcc,
	externalOleLink: 0x0fce,
	externalOleControl: 0x0fee,
	externalOleObjectAtom: 0x0fc3,
	externalVideo: 0x1005,
	externalAviMovie: 0x1006,
	externalMciMovie: 0x1007,
	externalMidiAudio: 0x100d,
	externalCdAudio: 0x100e,
	externalWavAudioEmbedded: 0x100f,
	externalWavAudioLink: 0x1010,
	animationInfo: 0x1014,
	progTags: 0x1388,
	persistDirectoryAtom: 0x1772,
	comment10: 0x2ee0,
	cryptSession10Container: 0x2f14
} as const

// §1.12 ppt budgets.
export interface PptBudgets {
	readonly records: number
	readonly persistIds: number
	readonly userEdits: number
	readonly textAtomBytes: number
	readonly shapePropertyBytes: number
}

export const DEFAULT_PPT_BUDGETS: PptBudgets = {
	records: 2_000_000,
	persistIds: 1_000_000,
	userEdits: 10_000,
	textAtomBytes: 16 * 1024 * 1024,
	shapePropertyBytes: 16 * 1024 * 1024
}

// Container nesting the reader follows at most (OfficeArt groups have their own bound).
export const MAX_RECORD_DEPTH = 64

export interface PptRecord {
	readonly type: number
	readonly instance: number
	readonly version: number
	// The record's data: [start, end) of the stream.
	readonly start: number
	readonly end: number
}

export function malformed(message: string): never {
	throw new PresentationError("malformed", message)
}

// Counts records read across the whole file against the budget.
export class RecordCounter {
	private count = 0
	readonly budgets: PptBudgets

	constructor(budgets: PptBudgets = DEFAULT_PPT_BUDGETS) {
		this.budgets = budgets
	}

	add(n: number): void {
		this.count += n

		if (this.count > this.budgets.records) tooLarge("ppt records", this.budgets.records)
	}
}

export function u16(data: Uint8Array, at: number): number {
	return (data[at] ?? 0) | ((data[at + 1] ?? 0) << 8)
}

export function i16(data: Uint8Array, at: number): number {
	return (u16(data, at) << 16) >> 16
}

export function u32(data: Uint8Array, at: number): number {
	return (u16(data, at) | (u16(data, at + 2) << 16)) >>> 0
}

export function i32(data: Uint8Array, at: number): number {
	return u32(data, at) | 0
}

// The record whose header is at `at`, its data within [at + 8, limit); malformed when it runs past `limit`.
export function recordAt(data: Uint8Array, at: number, limit = data.length): PptRecord {
	if (at < 0 || at + 8 > limit) malformed(`a record header at ${String(at)} runs past its container`)

	const head = u16(data, at)
	const length = u32(data, at + 4)
	const start = at + 8

	if (length > limit - start) malformed(`a record at ${String(at)} runs past its container`)

	return { type: u16(data, at + 2), instance: head >> 4, version: head & 0xf, start, end: start + length }
}

// The child records of a container (or of data[start, end)), in order. Trailing bytes too short for a header are
// ignored (writers pad); a child running past the container refuses the file.
export function children(data: Uint8Array, start: number, end: number, counter: RecordCounter): PptRecord[] {
	const out: PptRecord[] = []

	for (let at = start; at + 8 <= end;) {
		const record = recordAt(data, at, end)

		out.push(record)
		at = record.end
	}

	counter.add(out.length)

	return out
}

export function childrenOf(data: Uint8Array, container: PptRecord, counter: RecordCounter): PptRecord[] {
	return children(data, container.start, container.end, counter)
}

export function find(records: readonly PptRecord[], type: number, instance?: number): PptRecord | undefined {
	return records.find(record => record.type === type && (instance === undefined || record.instance === instance))
}

export function length(record: PptRecord): number {
	return record.end - record.start
}

// UTF-16LE text of [start, end), up to a NUL unless `whole`. An unpaired surrogate reads as U+FFFD, so the text is
// well formed wherever it goes (XML, a URI).
export function utf16Text(data: Uint8Array, start: number, end: number, whole = false): string {
	const parts: string[] = []
	let chunk: number[] = []

	for (let at = start; at + 1 < end; at += 2) {
		let unit = u16(data, at)

		if (unit === 0 && !whole) break

		if (unit >= 0xd800 && unit <= 0xdfff) {
			const next = at + 3 < end ? u16(data, at + 2) : 0

			if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
				chunk.push(unit)
				unit = next
				at += 2
			} else {
				unit = 0xfffd
			}
		}

		chunk.push(unit)

		if (chunk.length === 4096) {
			parts.push(String.fromCharCode(...chunk))
			chunk = []
		}
	}

	parts.push(String.fromCharCode(...chunk))

	return parts.join("")
}
