import { kids, persistRecord, readHeadersFootersOf, type HeadersFooters, type PptDocument, type PptFile } from "./document"
import { readDrawing, type Drawing } from "./officeArt"
import { tooLarge } from "../presentation/refusal"
import { malformed, RT, u16, u32, utf16Text, type PptRecord } from "./records"
import { readMasterStyle, type MasterStyle } from "./text"

// Slides, main masters, title masters and notes ([MS-PPT] §2.5): each persist object's atoms (SlideAtom §2.5.10,
// NotesAtom §2.5.12), colour scheme (§2.5.14), text styles (a main master's TextMasterStyleAtoms), headers and
// footers, the transition atom (§2.6.6, read raw: the transition itself is converted elsewhere) and the drawing.

export type PptSlideKind = "slide" | "mainMaster" | "titleMaster" | "notes" | "notesMaster" | "handout"

// §2.6.6 SlideShowSlideInfoAtom, as the bytes and the flags the reader needs.
export interface SlideShowInfo {
	readonly raw: Uint8Array
	readonly hidden: boolean
	readonly effectType: number
	readonly effectDirection: number
	readonly flags: number
	readonly speed: number
	readonly slideTime: number
}

export interface PptSlide {
	readonly kind: PptSlideKind
	readonly persistId: number
	// SlideAtom (slides and masters).
	readonly layout: number
	readonly placeholderTypes: readonly number[]
	readonly masterIdRef: number
	readonly notesIdRef: number
	// NotesAtom (notes).
	readonly slideIdRef: number
	// SlideFlags: fMasterObjects 0x1, fMasterScheme 0x2, fMasterBackground 0x4.
	readonly flags: number
	// SlideSchemeColorSchemeAtom: 8 RGB colours (background, text, shadow, title, fill, accent, hyperlink, followed).
	readonly scheme: readonly number[] | undefined
	readonly styles: ReadonlyMap<number, MasterStyle>
	readonly headersFooters: HeadersFooters | undefined
	readonly show: SlideShowInfo | undefined
	readonly name: string | undefined
	readonly drawing: Drawing
	// A PowerPoint 2002 time tree (§2.8.15 ExtTimeNodeContainer) and Comment10 records (§2.5.25) in the slide's
	// PP10 programmable tag: what the conversion reports until timing and comments are read.
	readonly timeNodes: boolean
	readonly comments: number
	readonly record: PptRecord
}

export const SLIDE_FLAGS = { masterObjects: 0x1, masterScheme: 0x2, masterBackground: 0x4 } as const

function scheme(data: Uint8Array, record: PptRecord | undefined): number[] | undefined {
	if (record === undefined || record.end - record.start < 32) return undefined

	const out: number[] = []

	for (let k = 0; k < 8; k++) {
		const at = record.start + 4 * k

		out.push(((data[at] ?? 0) << 16) | ((data[at + 1] ?? 0) << 8) | (data[at + 2] ?? 0))
	}

	return out
}

function showInfo(data: Uint8Array, record: PptRecord | undefined): SlideShowInfo | undefined {
	if (record === undefined || record.end - record.start < 16) return undefined

	const flags = u16(data, record.start + 10)

	return {
		raw: data.slice(record.start, record.end),
		hidden: (flags & 0x4) !== 0,
		effectDirection: data[record.start + 8] ?? 0,
		effectType: data[record.start + 9] ?? 0,
		flags,
		speed: data[record.start + 12] ?? 0,
		slideTime: u32(data, record.start)
	}
}

export function readSlide(file: PptFile, persistId: number, kind: PptSlideKind): PptSlide {
	const expected =
		kind === "mainMaster"
			? RT.mainMaster
			: kind === "notes" || kind === "notesMaster"
				? RT.notes
				: kind === "handout"
					? RT.handout
					: RT.slide
	const record = persistRecord(file, persistId)
	const actualKind: PptSlideKind =
		kind === "titleMaster" || kind === "mainMaster" ? (record.type === RT.mainMaster ? "mainMaster" : "titleMaster") : kind

	if (record.type !== expected && !(kind === "mainMaster" || kind === "titleMaster")) {
		malformed(`persist object ${String(persistId)} is not a ${kind}`)
	}

	const data = file.stream
	const records = kids(file, record)
	const atom = records.find(child => child.type === RT.slideAtom || child.type === RT.notesAtom)
	const styles = new Map<number, MasterStyle>()
	let layout = 0
	let placeholderTypes: number[] = []
	let masterIdRef = 0
	let notesIdRef = 0
	let slideIdRef = 0
	let flags = SLIDE_FLAGS.masterObjects | SLIDE_FLAGS.masterScheme | SLIDE_FLAGS.masterBackground

	if (atom?.type === RT.slideAtom && atom.end - atom.start >= 22) {
		layout = u32(data, atom.start)
		placeholderTypes = [...data.subarray(atom.start + 4, atom.start + 12)]
		masterIdRef = u32(data, atom.start + 12)
		notesIdRef = u32(data, atom.start + 16)
		flags = u16(data, atom.start + 20)
	} else if (atom?.type === RT.notesAtom && atom.end - atom.start >= 6) {
		slideIdRef = u32(data, atom.start)
		flags = u16(data, atom.start + 4)
	}

	for (const child of records) if (child.type === RT.textMasterStyleAtom) styles.set(child.instance, readMasterStyle(data, child))

	const nameAtom = records.find(child => child.type === RT.cString && child.instance === 3)
	const extension = pp10(file, records)

	return {
		kind: actualKind,
		persistId,
		layout,
		placeholderTypes,
		masterIdRef,
		notesIdRef,
		slideIdRef,
		flags,
		scheme: scheme(
			data,
			records.find(child => child.type === RT.colorSchemeAtom && child.instance === 1)
		),
		styles,
		headersFooters: readHeadersFootersOf(
			file,
			records.find(child => child.type === RT.headersFooters)
		),
		show: showInfo(
			data,
			records.find(child => child.type === RT.slideShowSlideInfoAtom)
		),
		name: nameAtom === undefined ? undefined : utf16Text(data, nameAtom.start, nameAtom.end),
		drawing: readDrawing(
			file,
			records.find(child => child.type === RT.drawing)
		),
		...extension,
		record
	}
}

const RT_PROG_BINARY_TAG = 0x138a
const RT_BINARY_TAG_DATA_BLOB = 0x138b
const RT_EXT_TIME_NODE_CONTAINER = 0xf144

// §2.5.22–§2.5.24: the "___PPT10" binary tag of a slide's SlideProgTagsContainer and what it holds.
function pp10(file: PptFile, records: readonly PptRecord[]): { readonly timeNodes: boolean; readonly comments: number } {
	let timeNodes = false
	let comments = 0

	for (const tags of records) {
		if (tags.type !== RT.progTags) continue

		for (const tag of kids(file, tags)) {
			if (tag.type !== RT_PROG_BINARY_TAG) continue

			for (const blob of kids(file, tag)) {
				if (blob.type !== RT_BINARY_TAG_DATA_BLOB) continue

				for (const record of kids(file, blob)) {
					if (record.type === RT_EXT_TIME_NODE_CONTAINER) timeNodes = true
					else if (record.type === RT.comment10) comments++
				}
			}
		}
	}

	return { timeNodes, comments }
}

export interface PptSlides {
	readonly mainMasters: readonly PptSlide[]
	readonly titleMasters: readonly PptSlide[]
	// MasterId → the master (main or title).
	readonly masterById: ReadonlyMap<number, PptSlide>
	readonly slides: readonly PptSlide[]
	readonly notes: ReadonlyMap<number, PptSlide>
	readonly notesMaster: PptSlide | undefined
	readonly handoutMaster: PptSlide | undefined
}

// Every live slide of the document (§3.3 Parts 5–7).
export function readSlides(document: PptDocument): PptSlides {
	const file = document.file
	const budgets = file.deckBudgets

	// The deck budgets (§1.12), before a slide is read: every slide becomes a part of the converted package.
	if (document.slides.length > budgets.slides) tooLarge("slides", budgets.slides)
	if (document.masters.length > budgets.masters) tooLarge("masters", budgets.masters)
	if (document.notes.length > budgets.slides) tooLarge("notes slides", budgets.slides)

	const mainMasters: PptSlide[] = []
	const titleMasters: PptSlide[] = []
	const masterById = new Map<number, PptSlide>()

	for (const entry of document.masters) {
		const master = readSlide(file, entry.persistId, "mainMaster")

		;(master.kind === "mainMaster" ? mainMasters : titleMasters).push(master)
		masterById.set(entry.id, master)
	}

	const slides = document.slides.map(entry => readSlide(file, entry.persistId, "slide"))
	const notes = new Map<number, PptSlide>()

	for (const entry of document.notes) notes.set(entry.id, readSlide(file, entry.persistId, "notes"))

	const notesMaster =
		document.notesMasterPersistId !== 0 && file.directory.offsets.has(document.notesMasterPersistId)
			? readSlide(file, document.notesMasterPersistId, "notesMaster")
			: undefined

	const handoutMaster =
		document.handoutMasterPersistId !== 0 && file.directory.offsets.has(document.handoutMasterPersistId)
			? readSlide(file, document.handoutMasterPersistId, "handout")
			: undefined

	return { mainMasters, titleMasters, masterById, slides, notes, notesMaster, handoutMaster }
}
