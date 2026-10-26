import { CfbError, CfbFile, isCompoundFile } from "../cfb/index"
import type { DocBlockKey } from "../doc/decrypt"
import { readProperties, records as artRecords, type ArtProperty } from "../doc/toDocx/officeArt"
import type { ByteSource } from "../opc/index"
import { DEFAULT_PRESENTATION_BUDGETS, type PresentationBudgets } from "../presentation/budget"
import { PresentationError } from "../presentation/model"
import { tooLarge } from "../presentation/refusal"
import { decryptPersistObjects, pptKey, type PptDecryption } from "./decrypt"
import { ENCRYPTED_TOKEN, isEncryptedEdit, readCurrentUser, readPersistDirectory, type PersistDirectory } from "./persist"
import {
	childrenOf,
	DEFAULT_PPT_BUDGETS,
	find,
	malformed,
	recordAt,
	RecordCounter,
	RT,
	u16,
	u32,
	utf16Text,
	type PptBudgets,
	type PptRecord
} from "./records"
import { readMasterStyle, readRuler, readTextBlocks, type MasterStyle, type Ruler, type TextBlock } from "./text"

// A PowerPoint 97–2003 file (.ppt, .pps, .pot; [MS-PPT] §2.1): the compound file's streams, the persist object
// directory, decryption with the open password, and the DocumentContainer (§2.4.1): slide size, fonts, the document's
// text styles, the master, slide and notes lists with their outline text, hyperlinks, named shows, headers and
// footers, and the drawing group (the BLIP store and the default shape properties). Slides themselves are read from
// their persist objects (slides.ts).

export interface PptOpenOptions {
	// The open password of an encrypted file, with the SHA-1 the key derivation needs (the realm's WebCrypto).
	readonly decryption?: PptDecryption
	readonly budgets?: PptBudgets
	// The presentation budgets the converted deck is held to (slides, shapes per slide, characters), §1.12.
	readonly deckBudgets?: PresentationBudgets
}

export interface PptFile {
	// The PowerPoint Document stream, its persist objects decrypted.
	readonly stream: Uint8Array
	readonly directory: PersistDirectory
	readonly counter: RecordCounter
	readonly budgets: PptBudgets
	readonly deckBudgets: PresentationBudgets
	readonly pictures: ByteSource | undefined
	// The key of an encrypted file (the Pictures stream is decrypted per picture); undefined when not encrypted.
	readonly key: DocBlockKey | undefined
	readonly encrypted: boolean
	readonly cfb: CfbFile
}

// Streams at the root of a compound file that make it another format, not a presentation.
const OTHER_FORMATS = ["WordDocument", "Workbook", "Book"]

async function readCfb<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read()
	} catch (error) {
		if (error instanceof CfbError) throw new PresentationError(error.code === "tooLarge" ? "tooLarge" : "malformed", error.message)

		throw error
	}
}

// Whether a compound file is encrypted without opening it fully (the Current User stream's token, or an edit that
// names an encryption session).
function encryptedAtOpen(user: { readonly headerToken: number }, directory: PersistDirectory): boolean {
	return user.headerToken === ENCRYPTED_TOKEN || isEncryptedEdit(directory)
}

// Opens the compound file and its PowerPoint Document stream: needsPassword without a password for an encrypted
// file, wrongPassword for a wrong one, unsupported for a compound file that is not a presentation.
export async function openPptFile(source: ByteSource, options: PptOpenOptions = {}): Promise<PptFile> {
	const budgets = options.budgets ?? DEFAULT_PPT_BUDGETS
	const deckBudgets = options.deckBudgets ?? DEFAULT_PRESENTATION_BUDGETS

	if (source.size < 8 || !isCompoundFile(await source.read(0, 8))) throw new PresentationError("malformed", "Not a compound file")

	const cfb = await readCfb(() => CfbFile.open(source))
	const documentEntry = cfb.entry(["PowerPoint Document"])
	const userEntry = cfb.entry(["Current User"])

	if (documentEntry?.kind !== "stream" || userEntry?.kind !== "stream") {
		if (cfb.entry(["EncryptionInfo"])?.kind === "stream")
			throw new PresentationError("unsupported", "An encrypted OOXML package, not a .ppt")
		if (OTHER_FORMATS.some(name => cfb.entry([name])?.kind === "stream")) {
			throw new PresentationError("unsupported", "A Word or Excel binary file, not a presentation")
		}

		// PowerPoint 4.0 and earlier stored "PP40" / "PP97_DUALSTORAGE" files differently.
		throw new PresentationError("unsupported", "A compound file without a PowerPoint Document stream")
	}

	const stream = await readCfb(() => cfb.read(documentEntry))
	const user = readCurrentUser(await readCfb(() => cfb.read(userEntry)))
	const directory = readPersistDirectory(stream, user, budgets)
	const counter = new RecordCounter(budgets)
	const picturesEntry = cfb.entry(["Pictures"])
	const pictures = picturesEntry?.kind === "stream" ? cfb.stream(picturesEntry) : undefined

	if (!encryptedAtOpen(user, directory)) {
		return { stream, directory, counter, budgets, deckBudgets, pictures, key: undefined, encrypted: false, cfb }
	}

	if (options.decryption === undefined) throw new PresentationError("needsPassword", "The presentation is encrypted")

	const key = await pptKey(stream, directory, options.decryption)
	const plain = await decryptPersistObjects(stream, directory, key)

	return { stream: plain, directory, counter, budgets, deckBudgets, pictures, key: key.key, encrypted: true, cfb }
}

// The record of persist object `id`, of `type` when given; malformed when it is missing or of another type.
export function persistRecord(file: PptFile, id: number, type?: number): PptRecord {
	const offset = file.directory.offsets.get(id)

	if (offset === undefined) malformed(`persist object ${String(id)} is not in the directory`)

	const record = recordAt(file.stream, offset)

	if (type !== undefined && record.type !== type) malformed(`persist object ${String(id)} is not of type ${String(type)}`)

	file.counter.add(1)

	return record
}

export function kids(file: PptFile, record: PptRecord): PptRecord[] {
	return childrenOf(file.stream, record, file.counter)
}

// --- The DocumentContainer ---

export interface FontEntry {
	readonly name: string
	readonly charset: number
	readonly pitchFamily: number
}

export interface Hyperlink {
	readonly target?: string
	readonly location?: string
	readonly name?: string
}

export interface HeadersFooters {
	readonly formatId: number
	readonly flags: number
	readonly userDate?: string
	readonly header?: string
	readonly footer?: string
}

export interface ListEntry {
	readonly persistId: number
	// SlideId, MasterId or NotesId.
	readonly id: number
	// The outline text that follows the entry (§2.4.14.3), one body per text placeholder.
	readonly texts: readonly TextBlock[]
}

export interface BlipStoreEntry {
	// FBSE (MS-ODRAW §2.2.32) btWin32, or 0 for a bare BLIP.
	readonly type: number
	// Offset in the Pictures stream of the BLIP (foDelay), and its size.
	readonly delay?: { readonly offset: number; readonly size: number }
	// A BLIP embedded in the store: its record in the document stream.
	readonly embedded?: {
		readonly data: Uint8Array
		readonly start: number
		readonly end: number
		readonly type: number
		readonly instance: number
	}
}

export interface OleObject {
	readonly persistId: number
	readonly progId?: string
	readonly linked: boolean
}

export interface PptDocument {
	readonly file: PptFile
	readonly slideSize: { readonly x: number; readonly y: number }
	readonly notesSize: { readonly x: number; readonly y: number }
	readonly firstSlideNumber: number
	// DocumentAtom.fOmitTitlePlace: title slides show no date, footer or slide number.
	readonly omitTitlePlaceholders: boolean
	readonly notesMasterPersistId: number
	readonly handoutMasterPersistId: number
	readonly fonts: readonly FontEntry[]
	// DocumentTextInfoContainer's TextMasterStyleAtoms by text type.
	readonly styles: ReadonlyMap<number, MasterStyle>
	readonly defaultRuler: Ruler | undefined
	readonly masters: readonly ListEntry[]
	readonly slides: readonly ListEntry[]
	readonly notes: readonly ListEntry[]
	readonly hyperlinks: ReadonlyMap<number, Hyperlink>
	readonly oleObjects: ReadonlyMap<number, OleObject>
	readonly media: ReadonlySet<number>
	readonly namedShows: readonly { readonly name: string; readonly slideIds: readonly number[] }[]
	readonly slideHF: HeadersFooters | undefined
	readonly notesHF: HeadersFooters | undefined
	readonly blips: readonly BlipStoreEntry[]
	// The drawing group's default shape properties (OfficeArtDggContainer drawingPrimaryOptions and the others).
	readonly defaults: ReadonlyMap<number, ArtProperty>
	readonly macros: boolean
}

function cString(file: PptFile, record: PptRecord): string {
	return utf16Text(file.stream, record.start, record.end)
}

function readFonts(file: PptFile, collection: PptRecord | undefined): FontEntry[] {
	const fonts: FontEntry[] = []

	if (collection === undefined) return fonts

	for (const atom of kids(file, collection)) {
		if (atom.type !== RT.fontEntityAtom || atom.end - atom.start < 68) continue

		const data = file.stream

		fonts[atom.instance] = {
			name: utf16Text(data, atom.start, atom.start + 64),
			charset: data[atom.start + 64] ?? 0,
			pitchFamily: data[atom.start + 67] ?? 0
		}
	}

	return fonts
}

// §2.4.14.3: SlidePersistAtom (or MasterPersistAtom, NotesPersistAtom: the same first 20 bytes' layout for the ids
// the reader uses) and the text bodies after it.
function readList(file: PptFile, list: PptRecord | undefined): ListEntry[] {
	if (list === undefined) return []

	const out: { persistId: number; id: number; records: PptRecord[] }[] = []

	for (const record of kids(file, list)) {
		if (record.type === RT.slidePersistAtom) {
			if (record.end - record.start < 16) malformed("a persist atom is truncated")

			out.push({ persistId: u32(file.stream, record.start), id: u32(file.stream, record.start + 12), records: [] })
		} else {
			out[out.length - 1]?.records.push(record)
		}
	}

	return out.map(entry => ({
		persistId: entry.persistId,
		id: entry.id,
		texts: readTextBlocks(file.stream, entry.records, file.budgets, record => kids(file, record), file.deckBudgets.runsPerBody)
	}))
}

function readHeadersFooters(file: PptFile, container: PptRecord | undefined): HeadersFooters | undefined {
	if (container === undefined) return undefined

	let formatId = 0
	let flags = 0
	let userDate: string | undefined
	let header: string | undefined
	let footer: string | undefined

	for (const record of kids(file, container)) {
		if (record.type === RT.headersFootersAtom && record.end - record.start >= 4) {
			formatId = u16(file.stream, record.start)
			flags = u16(file.stream, record.start + 2)
		} else if (record.type === RT.cString) {
			if (record.instance === 0) userDate = cString(file, record)
			else if (record.instance === 1) header = cString(file, record)
			else if (record.instance === 2) footer = cString(file, record)
		}
	}

	return {
		formatId,
		flags,
		...(userDate === undefined ? {} : { userDate }),
		...(header === undefined ? {} : { header }),
		...(footer === undefined ? {} : { footer })
	}
}

export function readHeadersFootersOf(file: PptFile, container: PptRecord | undefined): HeadersFooters | undefined {
	return readHeadersFooters(file, container)
}

function readExObjects(file: PptFile, list: PptRecord | undefined): Pick<PptDocument, "hyperlinks" | "oleObjects" | "media"> {
	const hyperlinks = new Map<number, Hyperlink>()
	const oleObjects = new Map<number, OleObject>()
	const media = new Set<number>()

	if (list === undefined) return { hyperlinks, oleObjects, media }

	for (const record of kids(file, list)) {
		switch (record.type) {
			case RT.externalHyperlink: {
				let id: number | undefined
				const link: { target?: string; location?: string; name?: string } = {}

				for (const child of kids(file, record)) {
					if (child.type === RT.externalHyperlinkAtom && child.end - child.start >= 4) id = u32(file.stream, child.start)
					else if (child.type === RT.cString) {
						const text = cString(file, child)

						if (child.instance === 0) link.name = text
						else if (child.instance === 1) link.target = text
						else if (child.instance === 3) link.location = text
					}
				}

				if (id !== undefined) hyperlinks.set(id, link)
				break
			}
			case RT.externalOleEmbed:
			case RT.externalOleLink:
			case RT.externalOleControl: {
				let id: number | undefined
				let persistId = 0
				let progId: string | undefined

				for (const child of kids(file, record)) {
					if (child.type === RT.externalOleObjectAtom && child.end - child.start >= 24) {
						id = u32(file.stream, child.start + 8)
						persistId = u32(file.stream, child.start + 16)
					} else if (child.type === RT.cString && child.instance === 2) {
						progId = cString(file, child)
					}
				}

				if (id !== undefined) {
					oleObjects.set(id, {
						persistId,
						linked: record.type === RT.externalOleLink,
						...(progId === undefined ? {} : { progId })
					})
				}

				break
			}
			case RT.externalVideo:
			case RT.externalAviMovie:
			case RT.externalMciMovie:
			case RT.externalMidiAudio:
			case RT.externalCdAudio:
			case RT.externalWavAudioEmbedded:
			case RT.externalWavAudioLink: {
				// ExMediaAtom (§2.10.6) first in each: exObjId.
				const atom = kids(file, record).find(child => child.type === 0x1004)

				if (atom !== undefined && atom.end - atom.start >= 4) media.add(u32(file.stream, atom.start))
				break
			}
			default:
				break
		}
	}

	return { hyperlinks, oleObjects, media }
}

// MS-ODRAW §2.2.12 OfficeArtDggContainer: the BLIP store and the default properties.
function readDrawingGroup(file: PptFile, group: PptRecord | undefined): Pick<PptDocument, "blips" | "defaults"> {
	const blips: BlipStoreEntry[] = []
	const defaults = new Map<number, ArtProperty>()
	const data = file.stream

	if (group === undefined) return { blips, defaults }

	const dgg = artRecords(data, group.start, group.end).find(record => record.type === 0xf000)

	if (dgg === undefined) return { blips, defaults }

	const inner = artRecords(data, dgg.start, dgg.end)

	file.counter.add(inner.length)

	for (const record of inner) {
		if (record.type === 0xf00b || record.type === 0xf121 || record.type === 0xf122) {
			if (record.end - record.start > file.budgets.shapePropertyBytes)
				tooLarge("OfficeArt property bytes", file.budgets.shapePropertyBytes)

			readProperties(data, record, defaults)
		} else if (record.type === 0xf001) {
			const store = artRecords(data, record.start, record.end)

			file.counter.add(store.length)

			for (const entry of store) {
				if (entry.type === 0xf007 && entry.end - entry.start >= 36) {
					const size = u32(data, entry.start + 20)
					const delay = u32(data, entry.start + 28)
					const cbName = data[entry.start + 33] ?? 0
					const embeddedAt = entry.start + 36 + cbName
					const embedded = embeddedAt + 8 <= entry.end ? artRecords(data, embeddedAt, entry.end)[0] : undefined

					blips.push({
						type: data[entry.start] ?? 0,
						// An FBSE whose size is 0 (encrypted files write it so) is bounded by its BLIP's own header.
						...(embedded === undefined
							? delay !== 0xffffffff
								? { delay: { offset: delay, size } }
								: {}
							: {
									embedded: {
										data,
										start: embedded.start,
										end: embedded.end,
										type: embedded.type,
										instance: embedded.instance
									}
								})
					})
				} else if (entry.type >= 0xf018 && entry.type <= 0xf117) {
					blips.push({
						type: 0,
						embedded: { data, start: entry.start, end: entry.end, type: entry.type, instance: entry.instance }
					})
				} else {
					blips.push({ type: 0 })
				}
			}
		}
	}

	return { blips, defaults }
}

function readNamedShows(file: PptFile, container: PptRecord | undefined): PptDocument["namedShows"] {
	if (container === undefined) return []

	const out: { name: string; slideIds: number[] }[] = []

	for (const show of kids(file, container)) {
		if (show.type !== RT.namedShow) continue

		let name = ""
		const slideIds: number[] = []

		for (const child of kids(file, show)) {
			if (child.type === RT.cString) name = cString(file, child)
			else if (child.type === RT.namedShowSlidesAtom)
				for (let at = child.start; at + 4 <= child.end; at += 4) slideIds.push(u32(file.stream, at))
		}

		out.push({ name, slideIds })
	}

	return out
}

// §2.4.1 DocumentContainer, through the persist directory (§3.3 Part 2).
export function readDocument(file: PptFile): PptDocument {
	const container = persistRecord(file, file.directory.current.docPersistIdRef, RT.document)
	const records = kids(file, container)
	const atom = find(records, RT.documentAtom)

	if (atom === undefined || atom.end - atom.start < 40) malformed("no DocumentAtom")

	const data = file.stream
	const environment = find(records, RT.environment)
	const environmentRecords = environment === undefined ? [] : kids(file, environment)
	const styles = new Map<number, MasterStyle>()
	let defaultRuler: Ruler | undefined

	for (const record of environmentRecords) {
		if (record.type === RT.textMasterStyleAtom) styles.set(record.instance, readMasterStyle(data, record))
		else if (record.type === 0x0fab) defaultRuler = readRuler(data, record.start, record.end)
	}

	const lists = records.filter(record => record.type === RT.slideListWithText)
	const listOf = (instance: number): PptRecord | undefined => lists.find(record => record.instance === instance)
	const headersFooters = records.filter(record => record.type === RT.headersFooters)
	const docInfo = find(records, RT.list)
	// §2.4.10–§2.4.11: a VBAInfoContainer whose VBAInfoAtom names a project (persistIdRef) and sets fHasMacros.
	const macros =
		docInfo !== undefined &&
		kids(file, docInfo).some(record => {
			if (record.type !== RT.vbaInfo) return false

			const atom = kids(file, record).find(child => child.type === RT.vbaInfoAtom)

			return atom !== undefined && atom.end - atom.start >= 8 && u32(data, atom.start) !== 0 && (u32(data, atom.start + 4) & 1) === 1
		})

	return {
		file,
		slideSize: { x: u32(data, atom.start), y: u32(data, atom.start + 4) },
		notesSize: { x: u32(data, atom.start + 8), y: u32(data, atom.start + 12) },
		notesMasterPersistId: u32(data, atom.start + 24),
		handoutMasterPersistId: u32(data, atom.start + 28),
		firstSlideNumber: u16(data, atom.start + 32),
		omitTitlePlaceholders: (data[atom.start + 37] ?? 0) !== 0,
		fonts: readFonts(
			file,
			environmentRecords.find(record => record.type === RT.fontCollection)
		),
		styles,
		defaultRuler,
		// §2.4.14: recInstance 0 the slides, 1 the masters, 2 the notes.
		masters: readList(file, listOf(1)),
		slides: readList(file, listOf(0)),
		notes: readList(file, listOf(2)),
		...readExObjects(file, find(records, RT.externalObjectList)),
		namedShows: readNamedShows(file, find(records, RT.namedShows)),
		slideHF: readHeadersFooters(
			file,
			headersFooters.find(record => record.instance === 3)
		),
		notesHF: readHeadersFooters(
			file,
			headersFooters.find(record => record.instance === 4)
		),
		...readDrawingGroup(file, find(records, RT.drawingGroup)),
		macros
	}
}
