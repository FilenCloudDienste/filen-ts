import { PresentationError } from "../presentation/model"
import { tooLarge } from "../presentation/refusal"
import { i16, i32, malformed, RT, u16, u32, utf16Text, type PptBudgets, type PptRecord } from "./records"

// PowerPoint 97–2003 text ([MS-PPT] §2.9): a body of text (TextHeaderAtom and the records after it), its paragraph
// and character runs (StyleTextPropAtom §2.9.44, with TextPFException §2.9.20 and TextCFException §2.9.14 as their
// masks say), the ruler (§2.9.30), metacharacters (§2.9.47–§2.9.52) and interactive ranges (§2.9.56). Only what a
// record writes is set; everything else inherits from the master's TextMasterStyleAtom (§2.9.35), as the pptx it
// becomes inherits from the master's txStyles.

// §2.12.2 ColorIndexStruct: an sRGB colour (0xFE) or an index into the slide's colour scheme (0–7).
export type PptColor = { readonly rgb: number } | { readonly scheme: number }

export interface CharProps {
	bold?: boolean
	italic?: boolean
	underline?: boolean
	shadow?: boolean
	emboss?: boolean
	font?: number
	eaFont?: number
	ansiFont?: number
	symbolFont?: number
	size?: number
	color?: PptColor
	position?: number
}

export interface TabStop {
	readonly position: number
	readonly type: number
}

export interface ParaProps {
	bullet?: boolean
	bulletHasFont?: boolean
	bulletHasColor?: boolean
	bulletHasSize?: boolean
	bulletChar?: number
	bulletFont?: number
	bulletSize?: number
	bulletColor?: PptColor
	align?: number
	lineSpacing?: number
	spaceBefore?: number
	spaceAfter?: number
	leftMargin?: number
	indent?: number
	defaultTab?: number
	tabs?: readonly TabStop[]
	fontAlign?: number
	wordWrap?: boolean
	charWrap?: boolean
	overflow?: boolean
	direction?: number
}

export interface StyleLevel {
	readonly pf: ParaProps
	readonly cf: CharProps
}

// §2.9.35: per TextTypeEnum (recInstance), up to five levels.
export interface MasterStyle {
	readonly type: number
	readonly levels: readonly (StyleLevel | undefined)[]
	readonly damaged?: boolean
}

// §2.9.30 TextRuler.
export interface Ruler {
	readonly defaultTab?: number
	readonly tabs?: readonly TabStop[]
	readonly levels: readonly { readonly leftMargin?: number; readonly indent?: number }[]
}

// §2.13.32 TextTypeEnum.
export const TEXT_TYPE = {
	title: 0,
	body: 1,
	notes: 2,
	other: 4,
	centerBody: 5,
	centerTitle: 6,
	halfBody: 7,
	quarterBody: 8
} as const

export type FieldKind = "slidenum" | "datetime" | "genericDate" | "header" | "footer" | "rtfDate"

export interface TextField {
	readonly position: number
	readonly kind: FieldKind
	// DateTimeMCAtom.index (§2.9.50), the format of a datetime field.
	readonly format?: number
}

// §2.6.10 InteractiveInfoAtom, as a text range or a shape carries it.
export interface Interaction {
	readonly action: number
	readonly jump: number
	readonly hyperlinkType: number
	readonly hyperlink: number
	// fCustomShowReturn (§2.6.10).
	readonly returns: boolean
	// The OLE verb of an OLE action (§2.6.8 oleVerb).
	readonly oleVerb: number
	// §2.6.11 MacroNameAtom: the macro, program or named show the action names.
	readonly name?: string
}

export interface TextLink {
	readonly start: number
	readonly end: number
	readonly interaction: Interaction
}

export interface TextBlock {
	readonly type: number
	readonly text: string
	readonly pfRuns: readonly { readonly count: number; readonly level: number; readonly pf: ParaProps }[]
	readonly cfRuns: readonly { readonly count: number; readonly cf: CharProps }[]
	// MasterTextPropAtom (§2.9.79): indent levels of a master's text.
	readonly masterLevels?: readonly { readonly count: number; readonly level: number }[]
	readonly ruler?: Ruler
	readonly fields: readonly TextField[]
	readonly links: readonly TextLink[]
	// Part of its formatting could not be read (the text itself is whole).
	readonly damaged?: boolean
}

function color(data: Uint8Array, at: number): PptColor | undefined {
	const index = data[at + 3] ?? 0xff

	if (index === 0xfe) return { rgb: ((data[at] ?? 0) << 16) | ((data[at + 1] ?? 0) << 8) | (data[at + 2] ?? 0) }
	if (index <= 7) return { scheme: index }

	return undefined
}

function tabStops(data: Uint8Array, at: number, end: number): { readonly tabs: TabStop[]; readonly next: number } {
	const count = u16(data, at)
	const next = at + 2 + 4 * count

	if (next > end) malformed("TabStops run past their record")

	const tabs: TabStop[] = []

	for (let k = 0; k < count; k++) tabs.push({ position: i16(data, at + 2 + 4 * k), type: u16(data, at + 4 + 4 * k) })

	return { tabs, next }
}

function need(at: number, size: number, end: number): void {
	if (at + size > end) malformed("a text property runs past its record")
}

// §2.9.20 TextPFException: the fields present in mask order.
export function readPF(data: Uint8Array, start: number, end: number): { readonly pf: ParaProps; readonly next: number } {
	need(start, 4, end)

	const masks = u32(data, start)
	const pf: ParaProps = {}
	let at = start + 4
	const field = (size: number): number => {
		need(at, size, end)

		const here = at

		at += size

		return here
	}

	if ((masks & 0xf) !== 0) {
		const flags = u16(data, field(2))

		if ((masks & 0x1) !== 0) pf.bullet = (flags & 0x1) !== 0
		if ((masks & 0x2) !== 0) pf.bulletHasFont = (flags & 0x2) !== 0
		if ((masks & 0x4) !== 0) pf.bulletHasColor = (flags & 0x4) !== 0
		if ((masks & 0x8) !== 0) pf.bulletHasSize = (flags & 0x8) !== 0
	}

	if ((masks & 0x80) !== 0) pf.bulletChar = u16(data, field(2))
	if ((masks & 0x10) !== 0) pf.bulletFont = u16(data, field(2))
	if ((masks & 0x40) !== 0) pf.bulletSize = i16(data, field(2))
	if ((masks & 0x20) !== 0) {
		const value = color(data, field(4))

		if (value !== undefined) pf.bulletColor = value
	}

	if ((masks & 0x800) !== 0) pf.align = u16(data, field(2))
	if ((masks & 0x1000) !== 0) pf.lineSpacing = i16(data, field(2))
	if ((masks & 0x2000) !== 0) pf.spaceBefore = i16(data, field(2))
	if ((masks & 0x4000) !== 0) pf.spaceAfter = i16(data, field(2))
	if ((masks & 0x100) !== 0) pf.leftMargin = i16(data, field(2))
	if ((masks & 0x400) !== 0) pf.indent = i16(data, field(2))
	if ((masks & 0x8000) !== 0) pf.defaultTab = u16(data, field(2))
	if ((masks & 0x100000) !== 0) {
		need(at, 2, end)

		const stops = tabStops(data, at, end)

		pf.tabs = stops.tabs
		at = stops.next
	}

	if ((masks & 0x10000) !== 0) pf.fontAlign = u16(data, field(2))
	if ((masks & 0xe0000) !== 0) {
		const flags = u16(data, field(2))

		if ((masks & 0x20000) !== 0) pf.charWrap = (flags & 0x1) !== 0
		if ((masks & 0x40000) !== 0) pf.wordWrap = (flags & 0x2) !== 0
		if ((masks & 0x80000) !== 0) pf.overflow = (flags & 0x4) !== 0
	}

	if ((masks & 0x200000) !== 0) pf.direction = u16(data, field(2))

	return { pf, next: at }
}

// §2.9.15 CFMasks: the bits that put a CFStyle (§2.9.16) in the exception.
const STYLE_MASKS = 0x1 | 0x2 | 0x4 | 0x10 | 0x20 | 0x80 | 0x200 | 0x3c00

// §2.9.14 TextCFException.
export function readCF(data: Uint8Array, start: number, end: number): { readonly cf: CharProps; readonly next: number } {
	need(start, 4, end)

	const masks = u32(data, start)
	const cf: CharProps = {}
	let at = start + 4
	const field = (size: number): number => {
		need(at, size, end)

		const here = at

		at += size

		return here
	}

	if ((masks & STYLE_MASKS) !== 0) {
		const style = u16(data, field(2))

		if ((masks & 0x1) !== 0) cf.bold = (style & 0x1) !== 0
		if ((masks & 0x2) !== 0) cf.italic = (style & 0x2) !== 0
		if ((masks & 0x4) !== 0) cf.underline = (style & 0x4) !== 0
		if ((masks & 0x10) !== 0) cf.shadow = (style & 0x10) !== 0
		if ((masks & 0x200) !== 0) cf.emboss = (style & 0x200) !== 0
	}

	if ((masks & 0x10000) !== 0) cf.font = u16(data, field(2))
	if ((masks & 0x200000) !== 0) cf.eaFont = u16(data, field(2))
	if ((masks & 0x400000) !== 0) cf.ansiFont = u16(data, field(2))
	if ((masks & 0x800000) !== 0) cf.symbolFont = u16(data, field(2))
	if ((masks & 0x20000) !== 0) cf.size = i16(data, field(2))
	if ((masks & 0x40000) !== 0) {
		const value = color(data, field(4))

		if (value !== undefined) cf.color = value
	}

	if ((masks & 0x80000) !== 0) cf.position = i16(data, field(2))
	// A run exception that carries the PowerPoint 2000 run id anyway (TextCFException9 fields).
	if ((masks & 0x100000) !== 0) field(4)

	return { cf, next: at }
}

// §2.9.35 TextMasterStyleAtom.
export function readMasterStyle(data: Uint8Array, record: PptRecord): MasterStyle {
	const levels: (StyleLevel | undefined)[] = []
	const count = Math.min(5, u16(data, record.start))
	let at = record.start + 2

	try {
		for (let k = 0; k < count; k++) {
			let level = k

			if (record.instance >= 5) {
				need(at, 2, record.end)
				level = u16(data, at)
				at += 2
			}

			const pf = readPF(data, at, record.end)
			const cf = readCF(data, pf.next, record.end)

			at = cf.next

			if (level < 5) levels[level] = { pf: pf.pf, cf: cf.cf }
		}
	} catch (error) {
		if (!(error instanceof PresentationError) || error.reason !== "malformed") throw error

		// The levels read before the damage are kept; the rest inherit.
		return { type: record.instance, levels, damaged: true }
	}

	return { type: record.instance, levels }
}

// §2.9.30 TextRuler.
export function readRuler(data: Uint8Array, start: number, end: number): Ruler {
	need(start, 4, end)

	const masks = u32(data, start)
	let at = start + 4
	const field = (size: number): number => {
		need(at, size, end)

		const here = at

		at += size

		return here
	}
	let defaultTab: number | undefined
	let tabs: TabStop[] | undefined

	if ((masks & 0x2) !== 0) field(2)
	if ((masks & 0x1) !== 0) defaultTab = u16(data, field(2))
	if ((masks & 0x4) !== 0) {
		need(at, 2, end)

		const stops = tabStops(data, at, end)

		tabs = stops.tabs
		at = stops.next
	}

	const levels: { leftMargin?: number; indent?: number }[] = []

	for (let k = 0; k < 5; k++) {
		const level: { leftMargin?: number; indent?: number } = {}

		if ((masks & (0x8 << k)) !== 0) level.leftMargin = i16(data, field(2))
		if ((masks & (0x100 << k)) !== 0) level.indent = i16(data, field(2))

		levels.push(level)
	}

	return { ...(defaultTab === undefined ? {} : { defaultTab }), ...(tabs === undefined ? {} : { tabs }), levels }
}

// §2.6.10 InteractiveInfoAtom (16 bytes).
export function readInteraction(data: Uint8Array, record: PptRecord): Interaction | undefined {
	if (record.end - record.start < 16) return undefined

	return {
		hyperlink: u32(data, record.start + 4),
		action: data[record.start + 8] ?? 0,
		oleVerb: data[record.start + 9] ?? 0,
		jump: data[record.start + 10] ?? 0,
		returns: ((data[record.start + 11] ?? 0) & 0x4) !== 0,
		hyperlinkType: data[record.start + 12] ?? 0
	}
}

// The InteractiveInfoAtom inside an InteractiveInfo container (§2.6.7).
export function interactionOf(
	data: Uint8Array,
	container: PptRecord,
	kids: (record: PptRecord) => readonly PptRecord[]
): Interaction | undefined {
	const records = kids(container)
	const atom = records.find(record => record.type === RT.interactiveInfoAtom)
	const name = records.find(record => record.type === RT.cString && record.instance === 2)
	const interaction = atom === undefined ? undefined : readInteraction(data, atom)

	if (interaction === undefined || name === undefined) return interaction

	return { ...interaction, name: utf16Text(data, name.start, name.end) }
}

const FIELD_TYPES: ReadonlyMap<number, FieldKind> = new Map([
	[RT.slideNumberMetaCharAtom, "slidenum"],
	[RT.dateTimeMetaCharAtom, "datetime"],
	[RT.genericDateMetaCharAtom, "genericDate"],
	[RT.headerMetaCharAtom, "header"],
	[RT.footerMetaCharAtom, "footer"],
	[RT.rtfDateTimeMetaCharAtom, "rtfDate"]
])

function readText(data: Uint8Array, record: PptRecord, budgets: PptBudgets): string {
	const size = record.end - record.start

	if (size > budgets.textAtomBytes) tooLarge("ppt text atom bytes", budgets.textAtomBytes)

	if (record.type === RT.textCharsAtom) return utf16Text(data, record.start, record.end - ((record.end - record.start) & 1), true)

	// §2.9.43 TextBytesAtom: each byte is the low byte of a UTF-16 code unit.
	const parts: string[] = []

	for (let at = record.start; at < record.end; at += 4096) {
		parts.push(String.fromCharCode(...data.subarray(at, Math.min(record.end, at + 4096))))
	}

	return parts.join("")
}

// §2.9.44 StyleTextPropAtom: paragraph runs, then character runs, each covering `length` + 1 characters (the body's
// final paragraph mark). A run list stops where the record does.
function readStyle(
	data: Uint8Array,
	record: PptRecord,
	length: number,
	runsPerBody: number
): Pick<TextBlock, "pfRuns" | "cfRuns" | "damaged"> {
	const pfRuns: { count: number; level: number; pf: ParaProps }[] = []
	const cfRuns: { count: number; cf: CharProps }[] = []

	try {
		readRuns(data, record, length, pfRuns, cfRuns, runsPerBody)
	} catch (error) {
		if (!(error instanceof PresentationError) || error.reason !== "malformed") throw error

		// The runs read before the damage are kept; the rest of the body inherits its formatting.
		return { pfRuns, cfRuns, damaged: true }
	}

	return { pfRuns, cfRuns }
}

function readRuns(
	data: Uint8Array,
	record: PptRecord,
	length: number,
	pfRuns: { count: number; level: number; pf: ParaProps }[],
	cfRuns: { count: number; cf: CharProps }[],
	runsPerBody: number
): void {
	let at = record.start

	for (let covered = 0; covered < length + 1 && at + 6 <= record.end;) {
		const count = u32(data, at)
		const level = u16(data, at + 4)
		const pf = readPF(data, at + 6, record.end)

		if (pfRuns.length >= runsPerBody) tooLarge("paragraph runs per body", runsPerBody)

		pfRuns.push({ count, level: Math.min(level, 8), pf: pf.pf })
		covered += count
		at = pf.next

		if (count === 0) break
	}

	for (let covered = 0; covered < length + 1 && at + 4 <= record.end;) {
		const count = u32(data, at)
		const cf = readCF(data, at + 4, record.end)

		if (cfRuns.length >= runsPerBody) tooLarge("character runs per body", runsPerBody)

		cfRuns.push({ count, cf: cf.cf })
		covered += count
		at = cf.next

		if (count === 0) break
	}
}

// The bodies of text in `records` (a SlideListWithText slice, or a shape's OfficeArtClientTextbox): each starts at a
// TextHeaderAtom.
export function readTextBlocks(
	data: Uint8Array,
	records: readonly PptRecord[],
	budgets: PptBudgets,
	kids: (record: PptRecord) => readonly PptRecord[],
	// The §1.12 runs-per-body budget, held by each run list (paragraph, character and master levels).
	runsPerBody: number
): TextBlock[] {
	const out: TextBlock[] = []
	let current:
		| {
				type: number
				text: string
				style?: PptRecord
				masterLevels?: { count: number; level: number }[]
				ruler?: Ruler
				fields: TextField[]
				links: TextLink[]
				pending: Interaction | undefined
				rulerDamaged?: boolean
		  }
		| undefined

	const finish = (): void => {
		if (current === undefined) return

		const style =
			current.style === undefined ? { pfRuns: [], cfRuns: [] } : readStyle(data, current.style, current.text.length, runsPerBody)

		out.push({
			type: current.type,
			text: current.text,
			...style,
			...(current.masterLevels === undefined ? {} : { masterLevels: current.masterLevels }),
			...(current.ruler === undefined ? {} : { ruler: current.ruler }),
			fields: current.fields,
			links: current.links,
			...(current.rulerDamaged === true ? { damaged: true } : {})
		})
		current = undefined
	}

	for (const record of records) {
		if (record.type === RT.textHeaderAtom) {
			finish()
			current = {
				type: record.end - record.start >= 4 ? u32(data, record.start) : TEXT_TYPE.other,
				text: "",
				fields: [],
				links: [],
				pending: undefined
			}
			continue
		}

		if (current === undefined) continue

		switch (record.type) {
			case RT.textCharsAtom:
			case RT.textBytesAtom:
				current.text = readText(data, record, budgets)
				break
			case RT.styleTextPropAtom:
				current.style = record
				break
			case RT.masterTextPropAtom: {
				const levels: { count: number; level: number }[] = []

				if ((record.end - record.start) / 6 > runsPerBody) tooLarge("master text runs per body", runsPerBody)

				for (let at = record.start; at + 6 <= record.end; at += 6) levels.push({ count: u32(data, at), level: u16(data, at + 4) })

				current.masterLevels = levels
				break
			}
			case RT.textRulerAtom:
				try {
					current.ruler = readRuler(data, record.start, record.end)
				} catch (error) {
					if (!(error instanceof PresentationError) || error.reason !== "malformed") throw error

					current.rulerDamaged = true
				}

				break
			case RT.interactiveInfo: {
				const interaction = interactionOf(data, record, kids)

				if (interaction !== undefined) current.pending = interaction
				break
			}
			case RT.textInteractiveInfoAtom:
				if (current.pending !== undefined && record.end - record.start >= 8) {
					current.links.push({ start: i32(data, record.start), end: i32(data, record.start + 4), interaction: current.pending })
					current.pending = undefined
				}
				break
			default: {
				const kind = FIELD_TYPES.get(record.type)

				if (kind !== undefined && record.end - record.start >= 4) {
					current.fields.push({
						position: i32(data, record.start),
						kind,
						...(record.type === RT.dateTimeMetaCharAtom && record.end - record.start >= 5
							? { format: data[record.start + 4] ?? 0 }
							: {})
					})
				}
			}
		}
	}

	finish()

	return out
}

// --- Paragraphs ---

export interface TextRun {
	readonly text: string
	readonly cf: CharProps
	// Index of the run's first character in the body's text.
	readonly start: number
	readonly field?: TextField
	readonly link?: Interaction
	// A vertical tab (0x0B): a line break inside the paragraph.
	readonly lineBreak?: boolean
}

export interface TextParagraph {
	readonly level: number
	readonly pf: ParaProps
	readonly runs: readonly TextRun[]
	// The character properties of the paragraph mark (the run covering its terminator).
	readonly end: CharProps
}

// The run covering a character, for indices asked in ascending order (a paragraph walk): the cursor only moves
// forward, so a body costs runs + lookups, not their product. An index before the cursor's run starts it over.
class RunCursor<T extends { readonly count: number }> {
	private readonly runs: readonly T[]
	private index = 0
	// The first character of runs[index].
	private start = 0

	constructor(runs: readonly T[]) {
		this.runs = runs
	}

	at(character: number): T | undefined {
		if (character < this.start) {
			this.index = 0
			this.start = 0
		}

		while (this.index < this.runs.length) {
			const count = this.runs[this.index]?.count ?? 0

			if (character < this.start + count) return this.runs[this.index]

			this.start += count
			this.index++
		}

		return this.runs[this.runs.length - 1]
	}
}

// The first link (in body order) covering a character, for indices asked in ascending order: links enter a min-heap
// of their order as the walk reaches their start and leave it lazily once it passes their end.
class LinkCursor {
	private readonly links: readonly TextLink[]
	private readonly byStart: readonly number[]
	private next = 0
	private readonly heap: number[] = []
	private last = -Infinity

	constructor(links: readonly TextLink[]) {
		this.links = links
		this.byStart = links.map((_, k) => k).sort((a, b) => (links[a]?.start ?? 0) - (links[b]?.start ?? 0) || a - b)
	}

	at(character: number): Interaction | undefined {
		if (character < this.last) {
			this.next = 0
			this.heap.length = 0
		}

		this.last = character

		for (; this.next < this.byStart.length; this.next++) {
			const k = this.byStart[this.next] ?? 0

			if ((this.links[k]?.start ?? 0) > character) break

			this.push(k)
		}

		while (this.heap.length > 0) {
			const top = this.links[this.heap[0] ?? 0]

			if (top !== undefined && character < top.end) return top.interaction

			this.pop()
		}

		return undefined
	}

	private push(value: number): void {
		const heap = this.heap
		let at = heap.length

		heap.push(value)

		while (at > 0) {
			const parent = (at - 1) >> 1

			if ((heap[parent] ?? 0) <= value) break

			heap[at] = heap[parent] ?? 0
			at = parent
		}

		heap[at] = value
	}

	private pop(): void {
		const heap = this.heap
		const last = heap.pop() ?? 0

		if (heap.length === 0) return

		let at = 0

		for (;;) {
			const left = 2 * at + 1

			if (left >= heap.length) break

			const right = left + 1
			const child = right < heap.length && (heap[right] ?? 0) < (heap[left] ?? 0) ? right : left

			if ((heap[child] ?? 0) >= last) break

			heap[at] = heap[child] ?? 0
			at = child
		}

		heap[at] = last
	}
}

// The body's paragraphs ("\r" ends one, "\v" breaks a line), each split where its character runs, fields or links
// change.
export function paragraphsOf(block: TextBlock): TextParagraph[] {
	const text = block.text
	const out: TextParagraph[] = []
	const fields = new Map(block.fields.map(field => [field.position, field]))
	// Run boundaries: every character run's start, plus each field's position and the one after it.
	const cuts = new Set<number>()
	let covered = 0

	for (const run of block.cfRuns) {
		cuts.add(covered)
		covered += run.count
	}

	for (const field of block.fields) {
		cuts.add(field.position)
		cuts.add(field.position + 1)
	}

	for (const link of block.links) {
		cuts.add(link.start)
		cuts.add(link.end)
	}

	const links = new LinkCursor(block.links)
	const pfRuns = new RunCursor(block.pfRuns)
	const cfRuns = new RunCursor(block.cfRuns)
	const masterLevels = new RunCursor(block.masterLevels ?? [])

	let start = 0

	while (start <= text.length) {
		let stop = text.indexOf("\r", start)

		if (stop < 0) stop = text.length

		const pfRun = pfRuns.at(start)
		const level = masterLevels.at(start)?.level ?? pfRun?.level ?? 0
		const runs: TextRun[] = []
		let from = start
		const flush = (end: number): void => {
			if (end <= from) return

			const field = fields.get(from)
			const link = links.at(from)

			runs.push({
				text: text.slice(from, end),
				cf: cfRuns.at(from)?.cf ?? {},
				start: from,
				...(field === undefined ? {} : { field }),
				...(link === undefined ? {} : { link })
			})
		}

		for (let at = start; at < stop; at++) {
			if (text.charCodeAt(at) === 0x0b) {
				flush(at)
				runs.push({ text: "", cf: cfRuns.at(at)?.cf ?? {}, start: at, lineBreak: true })
				from = at + 1
			} else if (at > from && cuts.has(at)) {
				flush(at)
				from = at
			}
		}

		flush(stop)

		out.push({ level: Math.min(level, 4), pf: pfRun?.pf ?? {}, runs, end: cfRuns.at(stop)?.cf ?? {} })

		if (stop >= text.length) break

		start = stop + 1
	}

	return out
}

// --- DrawingML ---

export interface TextEmitContext {
	readonly fonts: readonly ({ readonly name: string } | undefined)[]
	// The colour scheme text colours resolve through.
	readonly scheme: readonly number[]
	// The merged master style of a text type at a level: the document's, then the master's (§2.9.35).
	style(type: number, level: number): StyleLevel
	// Write colours that would otherwise be inherited (a slide whose colour scheme is not its master's).
	readonly explicitColors: boolean
	// The slide number a slide-number field shows; undefined on a master ("‹#›").
	readonly slideNumber: number | undefined
	readonly footer: string | undefined
	readonly header: string | undefined
	readonly date: string | undefined
	// The a:hlinkClick of an interaction, or "" when it has none this deck can carry.
	link(interaction: Interaction): string
}

const ALIGN = ["l", "ctr", "r", "just", "dist", "thaiDist", "justLow"]
const FONT_ALIGN = ["base", "t", "ctr", "auto"]
const TAB_ALIGN = ["l", "ctr", "r", "dec"]
const EMU_PER_MASTER_UNIT = 914400 / 576

function emuOf(units: number): number {
	return Math.round(units * EMU_PER_MASTER_UNIT)
}

function escapeXml(text: string): string {
	let out = ""

	for (let k = 0; k < text.length; k++) {
		const code = text.charCodeAt(k)

		if (code === 0x26) out += "&amp;"
		else if (code === 0x3c) out += "&lt;"
		else if (code === 0x3e) out += "&gt;"
		else if (code === 0x22) out += "&quot;"
		// XML 1.0 has no control characters but tab, line feed and carriage return; surrogates stay paired.
		else if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0xfffe || code === 0xffff) out += ""
		else out += text[k]
	}

	return out
}

export function xmlText(text: string): string {
	return escapeXml(text)
}

function colorOf(color: PptColor | undefined, scheme: readonly number[]): number | undefined {
	if (color === undefined) return undefined
	if ("rgb" in color) return color.rgb

	return scheme[color.scheme]
}

function srgb(rgb: number): string {
	return `<a:srgbClr val="${(rgb & 0xffffff).toString(16).toUpperCase().padStart(6, "0")}"/>`
}

function fontName(context: TextEmitContext, index: number | undefined): string | undefined {
	if (index === undefined) return undefined

	const name = context.fonts[index]?.name

	return name === undefined || name === "" ? undefined : name
}

function spacing(name: string, value: number | undefined): string {
	if (value === undefined) return ""

	// §2.2.20 ParaSpacing: a percentage of the line, or (negative) master units = 1/8 pt.
	return value >= 0
		? `<a:${name}><a:spcPct val="${String(Math.min(13200, value) * 1000)}"/></a:${name}>`
		: `<a:${name}><a:spcPts val="${String(Math.min(158400, Math.round(-value * 12.5)))}"/></a:${name}>`
}

// a:rPr (or a:defRPr / a:endParaRPr) of `cf`; `inherited` fills a colour the run does not set when the context asks.
export function runPropsXml(
	element: string,
	cf: CharProps,
	context: TextEmitContext,
	inherited: CharProps | undefined,
	extra = ""
): string {
	let attributes = ""

	if (cf.size !== undefined && cf.size > 0) attributes += ` sz="${String(Math.min(400000, Math.max(100, cf.size * 100)))}"`
	if (cf.bold !== undefined) attributes += ` b="${cf.bold ? "1" : "0"}"`
	if (cf.italic !== undefined) attributes += ` i="${cf.italic ? "1" : "0"}"`
	if (cf.underline !== undefined) attributes += ` u="${cf.underline ? "sng" : "none"}"`
	if (cf.position !== undefined && cf.position !== 0)
		attributes += ` baseline="${String(Math.max(-100, Math.min(100, cf.position)) * 1000)}"`

	let children = ""
	const color = colorOf(cf.color ?? (context.explicitColors ? inherited?.color : undefined), context.scheme)

	if (color !== undefined) children += `<a:solidFill>${srgb(color)}</a:solidFill>`
	if (cf.shadow === true || cf.emboss === true) {
		children +=
			'<a:effectLst><a:outerShdw blurRad="38100" dist="38100" dir="2700000" algn="tl"><a:srgbClr val="000000"><a:alpha val="43137"/></a:srgbClr></a:outerShdw></a:effectLst>'
	}

	const latin = fontName(context, cf.font)
	const ea = fontName(context, cf.eaFont)
	const symbol = fontName(context, cf.symbolFont)

	if (latin !== undefined) children += `<a:latin typeface="${escapeXml(latin)}"/>`
	if (ea !== undefined) children += `<a:ea typeface="${escapeXml(ea)}"/>`
	if (latin !== undefined) children += `<a:cs typeface="${escapeXml(latin)}"/>`
	if (symbol !== undefined) children += `<a:sym typeface="${escapeXml(symbol)}"/>`

	children += extra

	return children === "" ? `<a:${element}${attributes}/>` : `<a:${element}${attributes}>${children}</a:${element}>`
}

export interface Margins {
	readonly leftMargin?: number
	readonly indent?: number
}

// a:pPr attributes and children of `pf` at `level`; `effective` is the paragraph's resolved formatting (bullets on or
// off decide whether the bullet properties are written), `margins` its resolved left margin and indent.
export function paraPropsXml(
	element: string,
	pf: ParaProps,
	level: number | undefined,
	context: TextEmitContext,
	effective: ParaProps,
	margins: Margins,
	defRPr = ""
): string {
	let attributes = ""

	if (margins.leftMargin !== undefined) attributes += ` marL="${String(Math.max(0, emuOf(margins.leftMargin)))}"`
	if (margins.leftMargin !== undefined && margins.indent !== undefined)
		attributes += ` indent="${String(emuOf(margins.indent - margins.leftMargin))}"`
	if (level !== undefined && level > 0) attributes += ` lvl="${String(Math.min(8, level))}"`
	if (pf.align !== undefined && ALIGN[pf.align] !== undefined) attributes += ` algn="${ALIGN[pf.align] ?? "l"}"`

	const defaultTab = pf.defaultTab

	if (defaultTab !== undefined && defaultTab > 0) attributes += ` defTabSz="${String(emuOf(defaultTab))}"`
	if (pf.fontAlign !== undefined && FONT_ALIGN[pf.fontAlign] !== undefined)
		attributes += ` fontAlgn="${FONT_ALIGN[pf.fontAlign] ?? "auto"}"`
	if (pf.direction === 1) attributes += ' rtl="1"'
	if (pf.charWrap !== undefined) attributes += ` eaLnBrk="${pf.charWrap ? "1" : "0"}"`
	if (pf.wordWrap !== undefined) attributes += ` latinLnBrk="${pf.wordWrap ? "0" : "1"}"`
	if (pf.overflow !== undefined) attributes += ` hangingPunct="${pf.overflow ? "1" : "0"}"`

	let children = spacing("lnSpc", pf.lineSpacing) + spacing("spcBef", pf.spaceBefore) + spacing("spcAft", pf.spaceAfter)

	if (pf.bullet === false) {
		children += "<a:buNone/>"
	} else if (effective.bullet === true) {
		const bulletColor = colorOf(effective.bulletHasColor === true ? effective.bulletColor : undefined, context.scheme)

		if (pf.bulletHasColor === false) children += "<a:buClrTx/>"
		else if (
			(pf.bulletColor !== undefined || pf.bulletHasColor !== undefined || (context.explicitColors && pf.bullet !== undefined)) &&
			bulletColor !== undefined
		)
			children += `<a:buClr>${srgb(bulletColor)}</a:buClr>`

		if (pf.bulletHasSize === false) children += "<a:buSzTx/>"
		else if (pf.bulletSize !== undefined && effective.bulletHasSize === true) {
			children +=
				pf.bulletSize > 0
					? `<a:buSzPct val="${String(Math.max(25, Math.min(400, pf.bulletSize)) * 1000)}"/>`
					: `<a:buSzPts val="${String(Math.min(400000, Math.max(100, -pf.bulletSize * 100)))}"/>`
		}

		const bulletFont = fontName(context, effective.bulletHasFont === true ? effective.bulletFont : undefined)

		if (pf.bulletHasFont === false) children += "<a:buFontTx/>"
		else if ((pf.bulletFont !== undefined || pf.bulletHasFont !== undefined || pf.bullet !== undefined) && bulletFont !== undefined)
			children += `<a:buFont typeface="${escapeXml(bulletFont)}"/>`

		const char = effective.bulletChar

		// A bullet turned on here, or a character set here, writes the character (its presence is what turns it on).
		if ((pf.bullet === true || pf.bulletChar !== undefined) && char !== undefined && char !== 0) {
			children += `<a:buChar char="${escapeXml(String.fromCharCode(char)) || "•"}"/>`
		} else if (pf.bullet === true) {
			children += '<a:buChar char="•"/>'
		}
	}

	if (pf.tabs !== undefined && pf.tabs.length > 0) {
		children += `<a:tabLst>${pf.tabs
			.slice(0, 32)
			.map(tab => `<a:tab pos="${String(emuOf(Math.max(0, tab.position)))}" algn="${TAB_ALIGN[tab.type] ?? "l"}"/>`)
			.join("")}</a:tabLst>`
	}

	children += defRPr

	return children === ""
		? attributes === ""
			? ""
			: `<a:${element}${attributes}/>`
		: `<a:${element}${attributes}>${children}</a:${element}>`
}

export function mergePara(...levels: readonly (ParaProps | undefined)[]): ParaProps {
	return Object.assign({}, ...levels.filter(level => level !== undefined)) as ParaProps
}

export function mergeChar(...levels: readonly (CharProps | undefined)[]): CharProps {
	return Object.assign({}, ...levels.filter(level => level !== undefined)) as CharProps
}

const FIELD_GUIDS: Readonly<Record<string, string>> = {
	slidenum: "{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}",
	datetime: "{2E8D2A6F-4F38-4E45-B6C1-6E26C1E7C1A4}"
}

// §2.9.50: a DateTimeMCAtom's format index (0–12) as ST_TextField datetime types.
function dateType(format: number | undefined): string {
	return `datetime${String(Math.min(13, Math.max(1, (format ?? 0) + 1)))}`
}

function runXml(run: TextRun, block: TextBlock, level: number, context: TextEmitContext): string {
	const inherited = context.style(block.type, level).cf
	const link = run.link === undefined ? "" : context.link(run.link)

	if (run.lineBreak === true) return `<a:br>${runPropsXml("rPr", run.cf, context, inherited)}</a:br>`

	const field = run.field

	if (field !== undefined) {
		const props = runPropsXml("rPr", run.cf, context, inherited, link)
		const rest = run.text.length > 1 ? run.text.slice(1) : ""
		const after = rest === "" ? "" : `<a:r>${props}<a:t>${escapeXml(rest)}</a:t></a:r>`

		switch (field.kind) {
			case "slidenum":
				return `<a:fld id="${FIELD_GUIDS["slidenum"] ?? ""}" type="slidenum">${props}<a:t>${context.slideNumber === undefined ? "‹#›" : String(context.slideNumber)}</a:t></a:fld>${after}`
			case "datetime":
			case "genericDate":
			case "rtfDate":
				return `<a:fld id="${FIELD_GUIDS["datetime"] ?? ""}" type="${dateType(field.format)}">${props}<a:t>${escapeXml(context.date ?? "")}</a:t></a:fld>${after}`
			case "footer":
				return `<a:r>${props}<a:t>${escapeXml((context.footer ?? "") + rest)}</a:t></a:r>`
			case "header":
				return `<a:r>${props}<a:t>${escapeXml((context.header ?? "") + rest)}</a:t></a:r>`
		}
	}

	return `<a:r>${runPropsXml("rPr", run.cf, context, inherited, link)}<a:t>${escapeXml(run.text)}</a:t></a:r>`
}

// The margins of a paragraph at `level`: its own, else the shape's ruler, else the master style's, else the document's
// default ruler.
function marginsOf(pf: ParaProps, level: number, ruler: Ruler | undefined, style: ParaProps, fallback: Ruler | undefined): Margins {
	const fromRuler = ruler?.levels[level]
	const fromDefault = fallback?.levels[level]
	const leftMargin = pf.leftMargin ?? fromRuler?.leftMargin ?? style.leftMargin ?? fromDefault?.leftMargin
	const indent = pf.indent ?? fromRuler?.indent ?? style.indent ?? fromDefault?.indent

	if (pf.leftMargin === undefined && pf.indent === undefined && fromRuler?.leftMargin === undefined && fromRuler?.indent === undefined)
		return {}

	return { ...(leftMargin === undefined ? {} : { leftMargin }), ...(indent === undefined ? {} : { indent }) }
}

// The a:p elements of a body of text.
export function paragraphsXml(block: TextBlock, context: TextEmitContext, fallbackRuler?: Ruler): string {
	const out: string[] = []

	for (const paragraph of paragraphsOf(block)) {
		const level = paragraph.level
		const style = context.style(block.type, level)
		const pf =
			block.ruler?.defaultTab !== undefined && paragraph.pf.defaultTab === undefined
				? { ...paragraph.pf, defaultTab: block.ruler.defaultTab }
				: paragraph.pf
		const tabs = pf.tabs ?? block.ruler?.tabs
		const own = tabs === undefined || tabs === pf.tabs ? pf : { ...pf, tabs }
		const effective = mergePara(style.pf, own)
		const pPr = paraPropsXml("pPr", own, level, context, effective, marginsOf(own, level, block.ruler, style.pf, fallbackRuler))
		const runs = paragraph.runs.map(run => runXml(run, block, level, context)).join("")
		const end = runPropsXml("endParaRPr", paragraph.end, context, style.cf)

		out.push(`<a:p>${pPr}${runs}${end}</a:p>`)
	}

	return out.join("")
}

// The a:lvlNpPr elements of a master style (txStyles, a placeholder's lstStyle).
export function listStyleXml(type: number, context: TextEmitContext, ruler?: Ruler): string {
	let out = ""

	for (let level = 0; level < 5; level++) {
		const style = context.style(type, level)
		const leftMargin = style.pf.leftMargin ?? ruler?.levels[level]?.leftMargin
		const indent = style.pf.indent ?? ruler?.levels[level]?.indent
		const margins: Margins = { ...(leftMargin === undefined ? {} : { leftMargin }), ...(indent === undefined ? {} : { indent }) }
		const pf: ParaProps = { ...style.pf, ...(style.pf.bullet === undefined ? { bullet: false } : {}) }

		out += paraPropsXml(
			`lvl${String(level + 1)}pPr`,
			pf,
			undefined,
			{ ...context, explicitColors: true },
			pf,
			margins,
			runPropsXml("defRPr", style.cf, context, undefined)
		)
	}

	return out
}
