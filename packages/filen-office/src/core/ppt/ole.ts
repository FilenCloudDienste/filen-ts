import { Unzlib } from "fflate"
import type { LinkedPart } from "../opc/package"
import type { ByteChunks } from "../opc/pieces"
import { PresentationError } from "../presentation/model"
import { persistRecord, type PptFile } from "./document"
import { children, u32, utf16Text, type PptRecord } from "./records"
import type { PptReport } from "./report"
import { xmlText } from "./text"

// Embedded OLE objects ([MS-PPT] §2.10.27 ExOleEmbedContainer, §2.10.34–§2.10.36 ExOleObjStg) as PresentationML
// OLE objects (ECMA-376 Part 1 §19.3.2.4 p:oleObj in a graphic frame): the object's storage becomes an embedded
// package part, ppt/embeddings/oleObjectN.bin (a compound file, as the ExOleObjStg holds it), and the shape's
// preview picture the p:pic PowerPoint shows in its place. A compressed storage is never inflated when the deck opens:
// it is trusted to hold the size it states, and inflated only when the package is written, piece by piece as the zip
// takes it. A storage that turns out damaged then keeps that size (what inflated, then zeros) and is counted.
// Linked objects and ActiveX controls stay their preview pictures (a link the reader would have to follow, a control
// it would have to run).

const RT = {
	externalObjectList: 0x0409,
	cString: 0x0fba,
	oleEmbed: 0x0fcc,
	oleObjectAtom: 0x0fc3,
	oleObjectStorage: 0x1011
} as const

// What all of a deck's storages together may state they hold (a zip entry's limit, core/opc DEFAULT_ZIP_LIMITS).
const MAX_STORAGE = 512 * 1024 * 1024
// Deflate's longest match (258 bytes) costs at least two bits: a stream inflates to at most 1032 times its size.
const MAX_RATIO = 1032
const OLE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.oleObject"
const GRAPHIC_OLE = "http://schemas.openxmlformats.org/presentationml/2006/ole"

// Compressed bytes per inflate step: a step yields at most MAX_RATIO times as much (4 MiB).
const INFLATE_STEP = 4 * 1024
// Zeros a damaged storage is padded with, per piece.
const PAD = 64 * 1024

// A compressed storage (§2.10.36 ExOleObjStgCompressedAtom) as a part of its stated size: inflated in bounded steps
// each time its pieces are read, never held whole (read() joins them for a caller that wants the bytes). Content past
// the stated size is cut and a stream that ends early or is damaged is padded with zeros; either is reported once.
class CompressedStorage implements LinkedPart, ByteChunks {
	readonly size: number
	private readonly body: Uint8Array
	private damaged: (() => void) | undefined

	constructor(body: Uint8Array, size: number, damaged: () => void) {
		this.body = body
		this.size = size
		this.damaged = damaged
	}

	get length(): number {
		return this.size
	}

	async *chunks(): AsyncIterable<Uint8Array> {
		const size = this.size
		const body = this.body
		let given = 0
		let pending: Uint8Array[] = []
		let broken = false
		const stream = new Unzlib(chunk => {
			if (given + chunk.length > size) {
				broken = true
				chunk = chunk.subarray(0, size - given)
			}

			if (chunk.length > 0) pending.push(chunk)

			given += chunk.length
		})

		for (let at = 0; at < body.length && !broken; at += INFLATE_STEP) {
			const end = Math.min(body.length, at + INFLATE_STEP)

			try {
				stream.push(body.subarray(at, end), end === body.length)
			} catch {
				broken = true
			}

			const ready = pending

			pending = []

			for (const chunk of ready) yield chunk
		}

		if (given < size) broken = true

		for (; given < size; given += PAD) yield new Uint8Array(Math.min(PAD, size - given))

		if (broken) {
			this.damaged?.()
			this.damaged = undefined
		}
	}

	async read(): Promise<Uint8Array> {
		const out = new Uint8Array(this.size)
		let at = 0

		for await (const chunk of this.chunks()) {
			out.set(chunk, at)
			at += chunk.length
		}

		return out
	}
}

export interface PptOleEmbed {
	readonly exObjId: number
	readonly persistIdRef: number
	readonly progId: string
	readonly name: string
	// DVASPECT_ICON (§2.10.12 drawAspect, [MS-OSHARED] §2.2.1.2): shown as its icon.
	readonly icon: boolean
}

export class PptOle {
	private embeds: Map<number, PptOleEmbed> | undefined
	private readonly parts = new Map<string, LinkedPart>()
	// exObjId → its part (null: it cannot be embedded), so shapes showing the same object share one part.
	private readonly partOf = new Map<number, string | null>()
	// The slides showing each part, for the report of a storage found damaged when it is written.
	private readonly slidesOf = new Map<string, Set<number>>()
	// What the compressed storages embedded so far state they hold.
	private stated = 0

	private readonly file: PptFile
	// The DocumentContainer's children.
	private readonly document: readonly PptRecord[]
	private readonly report: PptReport

	constructor(file: PptFile, document: readonly PptRecord[], report: PptReport) {
		this.file = file
		this.document = document
		this.report = report
	}

	private kids(record: PptRecord): PptRecord[] {
		return children(this.file.stream, record.start, record.end, this.file.counter)
	}

	// §2.10.27: the deck's embedded objects by exObjId.
	embed(exObjId: number): PptOleEmbed | undefined {
		if (this.embeds === undefined) {
			const out = new Map<number, PptOleEmbed>()
			const data = this.file.stream
			const list = this.document.find(record => record.type === RT.externalObjectList)

			for (const record of list === undefined ? [] : this.kids(list)) {
				if (record.type !== RT.oleEmbed) continue

				const kids = this.kids(record)
				const atom = kids.find(child => child.type === RT.oleObjectAtom)

				if (atom === undefined || atom.end - atom.start < 24) continue

				const id = u32(data, atom.start + 8)
				const text = (instance: number): string => {
					const found = kids.find(child => child.type === RT.cString && child.instance === instance)

					return found === undefined ? "" : utf16Text(data, found.start, found.end)
				}

				if (!out.has(id))
					out.set(id, {
						exObjId: id,
						persistIdRef: u32(data, atom.start + 16),
						progId: text(2),
						name: text(1),
						icon: u32(data, atom.start) === 4
					})
			}

			this.embeds = out
		}

		return this.embeds.get(exObjId)
	}

	// The storage of `embed` as a lazily read part; undefined when the file has no readable storage for it.
	private storage(embed: PptOleEmbed, name: string): LinkedPart | undefined {
		if (!this.file.directory.offsets.has(embed.persistIdRef)) return undefined

		let record: PptRecord

		try {
			record = persistRecord(this.file, embed.persistIdRef, RT.oleObjectStorage)
		} catch (error) {
			if (error instanceof PresentationError) return undefined

			throw error
		}

		const data = this.file.stream

		if (record.instance === 0) {
			const bytes = data.subarray(record.start, record.end)

			return { size: bytes.length, read: () => Promise.resolve(bytes) }
		}

		if (record.instance !== 1 || record.end - record.start < 4) return undefined

		const size = u32(data, record.start)
		const body = data.subarray(record.start + 4, record.end)

		if (size === 0 || size > MAX_STORAGE - this.stated || size > body.length * MAX_RATIO) return undefined

		this.stated += size

		return new CompressedStorage(body, size, () => {
			for (const slide of this.slidesOf.get(name) ?? []) this.report.note("oleObject", slide)
		})
	}

	// The graphic frame of an embedded object on `slide`, its preview picture `picture` (a p:pic, which keeps the
	// shape's border, crop and effects) inside; `xfrm` is the frame's p:xfrm, `ph` its p:ph.
	// Undefined when the object cannot be embedded (linked, a control, or no storage), so the caller keeps the picture.
	frameXml(
		exObjId: number,
		frame: { readonly cNvPr: string; readonly xfrm: string; readonly ph: string; readonly picture: string },
		add: (type: string, target: string) => string,
		slide?: number
	): string | undefined {
		const embed = this.embed(exObjId)

		if (embed === undefined) return undefined

		let name = this.partOf.get(exObjId)

		if (name === undefined) {
			const candidate = `ppt/embeddings/oleObject${String(this.parts.size + 1)}.bin`
			const part = this.storage(embed, candidate)

			name = part === undefined ? null : candidate
			this.partOf.set(exObjId, name)

			if (part !== undefined) this.parts.set(candidate, part)
		}

		if (name === null) return undefined

		if (slide !== undefined) {
			let slides = this.slidesOf.get(name)

			if (slides === undefined) {
				slides = new Set()
				this.slidesOf.set(name, slides)
			}

			slides.add(slide)
		}

		const id = add("oleObject", `../embeddings/${name.slice(name.lastIndexOf("/") + 1)}`)

		return (
			`<p:graphicFrame><p:nvGraphicFramePr>${frame.cNvPr}<p:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></p:cNvGraphicFramePr>${frame.ph === "" ? "<p:nvPr/>" : `<p:nvPr>${frame.ph}</p:nvPr>`}</p:nvGraphicFramePr>` +
			`${frame.xfrm}<a:graphic><a:graphicData uri="${GRAPHIC_OLE}">` +
			`<p:oleObj${embed.name === "" ? "" : ` name="${xmlText(embed.name)}"`} r:id="${id}"${embed.progId === "" ? "" : ` progId="${xmlText(embed.progId)}"`}${embed.icon ? ' showAsIcon="1"' : ""}>` +
			`<p:embed/>${frame.picture}</p:oleObj></a:graphicData></a:graphic></p:graphicFrame>`
		)
	}

	// The embedded storages written, by name, and their content type.
	finish(parts: Map<string, Uint8Array | LinkedPart>, defaults: Map<string, string>): void {
		for (const [name, part] of this.parts) parts.set(name, part)

		if (this.parts.size > 0) defaults.set("bin", OLE_CONTENT_TYPE)
	}
}
