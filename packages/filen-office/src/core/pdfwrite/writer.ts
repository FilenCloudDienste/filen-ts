import { sliceClock, type SliceClock, type Slicing } from "../slicing"
import { ByteWriter, concat } from "./bytes"
import { platformRandom, securityOfKey, standardSecurity, type PdfSecurityKey, type RandomBytes, type SecurityHandler } from "./crypto"
import { nativeZlibDeflate, type PdfDeflate } from "./deflate"
import { PdfWriteError } from "./errors"
import {
	ByteSource,
	DEFAULT_MAX_IMAGE_PIXELS,
	platformImageDecoder,
	pngColorKey,
	pngPassthrough,
	readJpeg,
	readPng,
	sameBytes,
	sampledHash,
	sniffFormat,
	splitAlpha,
	type PdfBlobLike,
	type PdfDecodedImage,
	type PdfImageData,
	type PdfImageDecoder,
	type PdfImageFormat
} from "./images"
import { xmpMetadata } from "./metadata"
import { mapStrings, pdfName, PdfRef, PdfString, utf8, writeValue, type PdfDict, type PdfValue } from "./objects"
import { PdfPage, type PdfImage, type PdfTextFont } from "./page"
import {
	gradientAlpha,
	gradientKey,
	meshAlpha,
	meshStream,
	shadingDict,
	type PdfGradient,
	type PdfMesh,
	type PdfMeshStream
} from "./shading"
import { StructTree, type PdfStructOptions } from "./tagged"

// The document writer: PDF 1.7 (ISO 32000-1) with a cross-reference stream and object streams (§7.5.7-8),
// written front to back as it goes. A finished page is compressed and appended at once, and its buffer is
// reused for the next; images are appended when first used; fonts, the structure tree, outlines and the
// catalog come after the pages. The output is a list of parts (bytes and Blob slices) for a Blob.
//
// Peak memory: the compressed output so far, one page's content, and whatever one image or font needs while
// it is written.

// What a document says of itself beyond its title, as Word's "Document properties" export option writes it.
export interface PdfDocumentProperties {
	readonly author?: string | undefined
	readonly subject?: string | undefined
	readonly keywords?: string | undefined
}

export interface PdfAbortSignal {
	readonly aborted: boolean
	readonly reason?: unknown
}

export interface PdfWriterOptions {
	// The title viewers show (Info /Title, XMP dc:title, DisplayDocTitle); a tagged document claims PDF/UA only with one.
	readonly title?: string
	// The document's properties (Info /Author, /Subject, /Keywords and their XMP twins); blank values are none.
	readonly properties?: PdfDocumentProperties
	// BCP 47 language of the document (/Lang).
	readonly lang?: string
	// Tagged PDF with a structure tree, as PDF/UA-1 (ISO 14289-1) asks.
	readonly tagged?: boolean
	// The same input gives the same bytes: no dates, and the file ID from the content (encryption still takes
	// fresh random salts and IVs unless `random` is given).
	readonly deterministic?: boolean
	// Encrypts with the standard security handler, AES-256 (user and owner password).
	readonly password?: string
	// Encrypts as `password` does, with a key made where the password is (crypto.ts standardSecurityKey); `password`
	// wins when both are given.
	readonly securityKey?: PdfSecurityKey
	readonly signal?: PdfAbortSignal
	readonly slicing?: Slicing
	// Overrides the platform's deflate; null writes streams uncompressed.
	readonly deflate?: PdfDeflate | null
	readonly decoder?: PdfImageDecoder
	readonly maxImagePixels?: number
	// The random source for encryption and file IDs (tests only).
	readonly random?: RandomBytes
}

// What fonts and other late writers get (see page.ts PdfTextFont.write).
export interface PdfObjectSink {
	allocate(): PdfRef
	// A plain object; it may land in an object stream.
	object(ref: PdfRef, value: PdfValue): void
	// A stream object. `compress` deflates Uint8Array data (dict must not name a Filter then); Blob data and
	// part lists are written as they are.
	stream(ref: PdfRef, dict: PdfDict, data: PdfStreamData, options?: { readonly compress?: boolean }): Promise<void>
	readonly signal: PdfAbortSignal | undefined
	readonly deterministic: boolean
}

export type PdfStreamData = Uint8Array | PdfBlobLike | readonly (Uint8Array | PdfBlobLike)[]

export interface PdfPixelsSource extends PdfDecodedImage {
	// Dedupe key: the same key is embedded once.
	readonly key: string
	readonly interpolate?: boolean
}

export interface PdfImageSource {
	// Passed through as views or Blob slices: must stay unchanged until finish().
	readonly data: PdfImageData
	readonly format?: PdfImageFormat
	// Dedupe key (a part name); without one, the same data object is embedded once.
	readonly key?: string
	// Smooth when scaled up (§8.9.5.3).
	readonly interpolate?: boolean
	// Changes the decoded pixels in place before they are written (a picture's recolouring). The image is then always
	// decoded and shared by `key` alone (none: written each time); with no decoder for it, it is written unchanged.
	readonly transform?: (rgba: Uint8Array) => void
}

export type PdfDestinationTarget = { readonly page: number; readonly x?: number; readonly y?: number }

export interface PdfOutput {
	readonly parts: readonly (Uint8Array | PdfBlobLike)[]
	readonly size: number
}

// Object streams hold at most this many objects (and roughly this many bytes) each.
const OBJECTS_PER_STREAM = 200
const OBJECT_STREAM_BYTES = 128 * 1024

interface OutlineItem {
	readonly title: string
	readonly level: number
	readonly target: PdfDestinationTarget | string
}

// Mesh streams the writer holds to share them (a document's distinct scenes; more are written again each time).
const MESH_SHARE_BYTES = 16 * 1024 * 1024

// FNV-1a over a mesh stream's bytes, its bounds and its opacity.
function meshHash(stream: PdfMeshStream, alpha: number): number {
	let hash = 0x811c9dc5

	const mixByte = (byte: number): void => {
		hash = Math.imul(hash ^ byte, 0x01000193)
	}

	for (const byte of stream.data) mixByte(byte)

	const numbers = new Float64Array([...stream.decode, alpha, stream.bitsPerCoordinate])

	for (const byte of new Uint8Array(numbers.buffer)) mixByte(byte)

	return hash >>> 0
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false

	return true
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
	return a.length === b.length && a.every((value, k) => value === b[k])
}

export class PdfWriter implements PdfObjectSink {
	readonly deterministic: boolean
	readonly tagged: boolean
	readonly signal: PdfAbortSignal | undefined
	readonly struct: StructTree
	private readonly parts: (Uint8Array | PdfBlobLike)[] = []
	private offset = 0
	private nextId = 1
	// Cross-reference entries by object number: type (1 offset, 2 in an object stream), field 2, field 3.
	private readonly xrefType: number[] = [0]
	private readonly xrefField2: number[] = [0]
	private readonly xrefField3: number[] = [0]
	private readonly pending = new ByteWriter(OBJECT_STREAM_BYTES + 16384)
	private readonly pendingIds: number[] = []
	private readonly pendingOffsets: number[] = []
	private readonly deflate: PdfDeflate | undefined
	private readonly decoder: PdfImageDecoder | undefined
	private readonly maxImagePixels: number
	private readonly clock: SliceClock | undefined
	private readonly pagesRef: PdfRef
	private readonly pageRefs: PdfRef[] = []
	private readonly pageHeights: number[] = []
	private pageCount = 0
	private readonly content = new ByteWriter(64 * 1024)
	private current: PdfPage | undefined
	private finished = false
	private readonly fonts = new Map<PdfTextFont, { readonly name: string; readonly ref: PdfRef }>()
	// By key, else by the data object (weakly: the writer never keeps a source alive for dedupe alone).
	private readonly imagesByKey = new Map<string, Promise<PdfImage>>()
	private readonly imagesByData = new WeakMap<object, Promise<PdfImage>>()
	// Sources by content fingerprint (held weakly where the platform can), for identical bytes in different
	// objects.
	private readonly imagesByHash = new Map<
		string,
		{ readonly data: () => PdfImageData | undefined; readonly image: Promise<PdfImage> }[]
	>()
	private readonly states = new Map<string, { readonly name: string; readonly ref: PdfRef }>()
	// Resources whose painting composites (an ExtGState with alpha, a soft mask or a blend mode, an image with an SMask,
	// a pattern drawing one), by object number: a page using any gets a transparency group.
	private readonly transparent = new Set<number>()
	private readonly gradients = new Map<string, Promise<GradientResources>>()
	// Meshes written so far, by hash of their stream and opacity.
	private readonly meshes = new Map<
		number,
		{
			readonly data: Uint8Array
			readonly decode: readonly number[]
			readonly alpha: number
			readonly bits: number
			readonly resources: Promise<GradientResources>
		}[]
	>()
	private meshBytes = 0
	private readonly destinations = new Map<string, PdfDestinationTarget>()
	// Link annotations to named destinations, written at the end once every name is known.
	private readonly namedLinks: { readonly ref: PdfRef; readonly annotation: PdfDict; readonly name: string }[] = []
	private readonly outlines: OutlineItem[] = []
	private names = 0

	private readonly options: PdfWriterOptions
	private readonly security: SecurityHandler | undefined

	private constructor(options: PdfWriterOptions, security: SecurityHandler | undefined) {
		this.options = options
		this.security = security
		this.deterministic = options.deterministic === true
		this.tagged = options.tagged === true
		this.signal = options.signal
		this.struct = new StructTree()
		this.deflate = options.deflate === null ? undefined : (options.deflate ?? nativeZlibDeflate())
		this.decoder = options.decoder ?? platformImageDecoder()
		this.maxImagePixels = options.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS
		this.clock = options.slicing === undefined ? undefined : sliceClock(options.slicing)
		this.pagesRef = this.allocate()
		// A binary comment marks the file as binary (§7.5.2).
		this.emit(new Uint8Array([...utf8("%PDF-1.7\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))
	}

	static async create(options: PdfWriterOptions = {}): Promise<PdfWriter> {
		// Salts, keys and IVs always come from the platform's CSPRNG unless a test passes its own source.
		const random = options.random ?? platformRandom
		const security =
			options.password !== undefined
				? await standardSecurity(options.password, random)
				: options.securityKey === undefined
					? undefined
					: securityOfKey(options.securityKey, random)

		return new PdfWriter(options, security)
	}

	private checkAbort(): void {
		const signal = this.signal

		if (signal?.aborted === true) {
			throw signal.reason ?? Object.assign(new Error("The PDF export was aborted"), { name: "AbortError" })
		}
	}

	// Gives the host a turn when the slice is up (call between pieces of long work).
	async yieldIfDue(): Promise<void> {
		this.checkAbort()

		if (this.clock?.due === true) await this.clock.pause()

		this.checkAbort()
	}

	allocate(): PdfRef {
		const id = this.nextId++

		this.xrefType[id] = 0
		this.xrefField2[id] = 0
		this.xrefField3[id] = 0

		return new PdfRef(id)
	}

	private emit(part: Uint8Array | PdfBlobLike): void {
		this.parts.push(part)
		this.offset += part instanceof Uint8Array ? part.length : part.size
	}

	object(ref: PdfRef, value: PdfValue): void {
		if (this.finished) throw new PdfWriteError("state", "The document is finished")

		this.pendingIds.push(ref.id)
		this.pendingOffsets.push(this.pending.length)
		writeValue(this.pending, value)
		this.pending.newline()
	}

	private async flushObjectsIfFull(): Promise<void> {
		if (this.pendingIds.length >= OBJECTS_PER_STREAM || this.pending.length >= OBJECT_STREAM_BYTES) await this.flushObjects()
	}

	// Writes the pending objects as one object stream (§7.5.7); strings inside are encrypted with the stream.
	private async flushObjects(): Promise<void> {
		if (this.pendingIds.length === 0) return

		const header = new ByteWriter(this.pendingIds.length * 12)

		this.pendingIds.forEach((id, index) => {
			header
				.int(id)
				.space()
				.int(this.pendingOffsets[index] ?? 0)
				.space()
		})

		const data = concat([header.view(), this.pending.view()])
		const ref = this.allocate()
		const count = this.pendingIds.length

		this.pendingIds.forEach((id, index) => {
			this.xrefType[id] = 2
			this.xrefField2[id] = ref.id
			this.xrefField3[id] = index
		})
		this.pendingIds.length = 0
		this.pendingOffsets.length = 0
		this.pending.reset()

		await this.stream(ref, { Type: pdfName("ObjStm"), N: count, First: header.length }, data, { compress: true })
	}

	async stream(ref: PdfRef, dict: PdfDict, data: PdfStreamData, options: { readonly compress?: boolean } = {}): Promise<void> {
		this.checkAbort()

		let parts: readonly (Uint8Array | PdfBlobLike)[] =
			data instanceof Uint8Array || !Array.isArray(data) ? [data as Uint8Array | PdfBlobLike] : data
		let filter: PdfDict = {}

		if (options.compress === true && this.deflate !== undefined) {
			const raw = parts.length === 1 && parts[0] instanceof Uint8Array ? parts[0] : await readAll(parts)

			parts = [await this.deflate(raw)]
			filter = { Filter: pdfName("FlateDecode") }
		}

		let entries: PdfDict = dict

		if (this.security !== undefined) {
			const security = this.security

			parts = [await security.encrypt(await readAll(parts))]
			entries = (await mapStrings(dict, bytes => security.encrypt(bytes))) as PdfDict
		}

		let length = 0

		for (const part of parts) length += part instanceof Uint8Array ? part.length : part.size

		this.checkAbort()
		this.xrefType[ref.id] = 1
		this.xrefField2[ref.id] = this.offset

		const head = new ByteWriter(256)

		head.int(ref.id).ascii(" 0 obj\n")
		writeValue(head, { ...entries, ...filter, Length: length })
		head.ascii("\nstream\n")
		this.emit(head.take())

		for (const part of parts) this.emit(part)

		this.emit(ENDSTREAM)
	}

	// A plain object outside object streams (the encryption dictionary must be, §7.5.7).
	private direct(ref: PdfRef, value: PdfValue): void {
		const out = new ByteWriter(256)

		this.xrefType[ref.id] = 1
		this.xrefField2[ref.id] = this.offset
		out.int(ref.id).ascii(" 0 obj\n")
		writeValue(out, value)
		out.ascii("\nendobj\n")
		this.emit(out.take())
	}

	private name(prefix: string): string {
		return `${prefix}${++this.names}`
	}

	// --- pages

	// Starts a page of `width` x `height` px (96 per inch).
	beginPage(width: number, height: number): PdfPage {
		if (this.finished) throw new PdfWriteError("state", "The document is finished")
		if (this.current !== undefined) throw new PdfWriteError("state", "The previous page is not finished")

		const index = this.pageCount++
		const ref = this.pageRef(index)

		this.pageHeights[index] = height * 0.75
		this.content.reset()
		this.current = new PdfPage(this, index, ref, width, height, this.content)

		return this.current
	}

	// The reference of page `index`, also before the page is written (links to later pages).
	pageRef(index: number): PdfRef {
		let ref = this.pageRefs[index]

		if (ref === undefined) {
			ref = this.allocate()
			this.pageRefs[index] = ref
		}

		return ref
	}

	async endPage(page: PdfPage): Promise<void> {
		if (page !== this.current) throw new PdfWriteError("state", "Not the current page")

		page.checkBalanced()
		page.finished = true

		const contents = this.allocate()

		// Written as is (no deflate, no encryption), the bytes must outlive the reused buffer.
		const data = this.deflate === undefined && this.security === undefined ? this.content.take() : this.content.view()

		await this.stream(contents, {}, data, { compress: true })

		const resources: Record<string, PdfValue> = {}
		const table = (map: ReadonlyMap<string, PdfRef>): PdfDict | undefined => (map.size === 0 ? undefined : Object.fromEntries(map))

		resources["Font"] = table(page.fonts) ?? null
		resources["XObject"] = table(page.xobjects) ?? null
		resources["ExtGState"] = table(page.extGStates) ?? null
		resources["Shading"] = table(page.shadings) ?? null
		resources["Pattern"] = table(page.patterns) ?? null

		for (const key of Object.keys(resources)) if (resources[key] === null) delete resources[key]

		const structParents = this.tagged ? this.struct.pageKey(page.index) : undefined
		const composites = (map: ReadonlyMap<string, PdfRef>): boolean => {
			for (const ref of map.values()) if (this.transparent.has(ref.id)) return true

			return false
		}

		this.object(page.ref, {
			Type: pdfName("Page"),
			Parent: this.pagesRef,
			MediaBox: [0, 0, round(page.width * 0.75), round(page.height * 0.75)],
			Resources: resources,
			// §11.4.7: compositing in RGB, not the device's or output intent's space; opaque pages stay as they were.
			Group:
				composites(page.extGStates) || composites(page.xobjects) || composites(page.patterns)
					? { Type: pdfName("Group"), S: pdfName("Transparency"), CS: pdfName("DeviceRGB") }
					: undefined,
			Contents: contents,
			Annots: page.annotations.length === 0 ? undefined : page.annotations,
			StructParents: structParents,
			// ISO 14289-1 §7.18.3: annotations in structure order.
			Tabs: this.tagged && page.annotations.length > 0 ? pdfName("S") : undefined
		})

		this.current = undefined
		this.content.reset()
		await this.flushObjectsIfFull()
		await this.yieldIfDue()
	}

	// --- resources

	fontName(font: PdfTextFont): { readonly name: string; readonly ref: PdfRef } {
		let entry = this.fonts.get(font)

		if (entry === undefined) {
			entry = { name: this.name("F"), ref: this.allocate() }
			this.fonts.set(font, entry)
		}

		return entry
	}

	extGState(options: {
		readonly fillAlpha?: number
		readonly strokeAlpha?: number
		readonly blend?: string
		readonly softMask?: PdfRef
	}): { readonly name: string; readonly ref: PdfRef } {
		const key = `${options.fillAlpha ?? ""}|${options.strokeAlpha ?? ""}|${options.blend ?? ""}|${options.softMask?.id ?? ""}`
		let entry = this.states.get(key)

		if (entry === undefined) {
			entry = { name: this.name("GS"), ref: this.allocate() }
			this.states.set(key, entry)

			if (
				(options.fillAlpha !== undefined && round(options.fillAlpha) < 1) ||
				(options.strokeAlpha !== undefined && round(options.strokeAlpha) < 1) ||
				(options.blend !== undefined && options.blend !== "Normal") ||
				options.softMask !== undefined
			)
				this.transparent.add(entry.ref.id)

			this.object(entry.ref, {
				Type: pdfName("ExtGState"),
				ca: options.fillAlpha === undefined ? undefined : round(options.fillAlpha),
				CA: options.strokeAlpha === undefined ? undefined : round(options.strokeAlpha),
				BM: options.blend === undefined ? undefined : pdfName(options.blend),
				SMask: options.softMask === undefined ? undefined : { Type: pdfName("Mask"), S: pdfName("Luminosity"), G: options.softMask }
			})
		}

		return entry
	}

	// A coloured tiling pattern (§8.7.3.3) whose cell `content` draws `image`; `matrix` places pattern space in the
	// page's default space.
	async tilingPattern(cell: {
		readonly width: number
		readonly height: number
		readonly matrix: readonly number[]
		readonly content: Uint8Array
		readonly image: PdfImage
	}): Promise<{ readonly name: string; readonly ref: PdfRef }> {
		const pattern = { name: this.name("P"), ref: this.allocate() }
		const fine = (value: number): number => Math.round(value * 1e6) / 1e6

		if (this.transparent.has(cell.image.ref.id)) this.transparent.add(pattern.ref.id)

		await this.stream(
			pattern.ref,
			{
				Type: pdfName("Pattern"),
				PatternType: 1,
				PaintType: 1,
				TilingType: 1,
				BBox: [0, 0, fine(cell.width), fine(cell.height)],
				XStep: fine(cell.width),
				YStep: fine(cell.height),
				Matrix: cell.matrix.map(fine),
				Resources: { XObject: { [cell.image.name]: cell.image.ref } }
			},
			cell.content,
			{ compress: true }
		)

		return pattern
	}

	gradient(gradient: PdfGradient): Promise<GradientResources> {
		const key = gradientKey(gradient)
		let entry = this.gradients.get(key)

		if (entry === undefined) {
			entry = this.writeGradient(gradient)
			this.gradients.set(key, entry)
		}

		return entry
	}

	private async writeGradient(gradient: PdfGradient): Promise<GradientResources> {
		const shading = { name: this.name("Sh"), ref: this.allocate() }

		this.object(shading.ref, shadingDict(gradient, "rgb"))

		const alpha = gradientAlpha(gradient)

		if (alpha.uniform) {
			return { shading, state: alpha.alpha < 1 ? this.extGState({ fillAlpha: alpha.alpha }) : undefined }
		}

		// The alpha ramp painted in gray inside a transparency group: its luminosity is the mask (§11.6.5.2).
		const maskShading = this.allocate()
		const form = this.allocate()
		const [minX, minY, maxX, maxY] = gradient.bounds

		this.object(maskShading, shadingDict(gradient, "alpha"))
		await this.stream(
			form,
			{
				Type: pdfName("XObject"),
				Subtype: pdfName("Form"),
				BBox: [minX, minY, maxX, maxY].map(round),
				Group: { Type: pdfName("Group"), S: pdfName("Transparency"), CS: pdfName("DeviceGray") },
				Resources: { Shading: { A: maskShading } }
			},
			utf8("/A sh\n"),
			{ compress: false }
		)

		return { shading, state: this.extGState({ softMask: form }) }
	}

	// A Gouraud mesh as a shading, written once per document however often it is painted (a scene on a master, a
	// deck's repeated picture): the same stream and opacity share one shading. Undefined for a mesh the stream
	// refuses (bounds that are no page geometry); the caller paints its mean colour.
	async mesh(mesh: PdfMesh): Promise<GradientResources | undefined> {
		const stream = meshStream(mesh.points, mesh.colors)

		if (stream === undefined) return undefined

		const alpha = meshAlpha(mesh.colors)
		const hash = meshHash(stream, alpha)
		const known = this.meshes
			.get(hash)
			?.find(
				entry =>
					entry.alpha === alpha &&
					entry.bits === stream.bitsPerCoordinate &&
					equalBytes(entry.data, stream.data) &&
					sameNumbers(entry.decode, stream.decode)
			)

		if (known !== undefined) return await known.resources

		const shading = { name: this.name("Sh"), ref: this.allocate() }
		const resources = this.stream(
			shading.ref,
			{
				ShadingType: 4,
				ColorSpace: pdfName("DeviceRGB"),
				BitsPerCoordinate: stream.bitsPerCoordinate,
				BitsPerComponent: 8,
				BitsPerFlag: 8,
				Decode: stream.decode.map(value => Math.round(value * 1000) / 1000)
			},
			stream.data,
			{ compress: true }
		).then(() => ({ shading, state: alpha < 1 ? this.extGState({ fillAlpha: alpha }) : undefined }))

		// Kept for sharing within a byte budget (past it a mesh is written again rather than held).
		if (this.meshBytes + stream.data.length <= MESH_SHARE_BYTES) {
			const entries = this.meshes.get(hash) ?? []

			entries.push({ data: stream.data, decode: stream.decode, alpha, bits: stream.bitsPerCoordinate, resources })
			this.meshes.set(hash, entries)
			this.meshBytes += stream.data.length
		}

		return await resources
	}

	// Embeds an image once; refusals throw PdfWriteError.
	image(source: PdfImageSource): Promise<PdfImage> {
		const key = source.key

		if (source.transform !== undefined) {
			const held = key === undefined ? undefined : this.imagesByKey.get(key)

			if (held !== undefined) return held

			// A realm that cannot decode the picture draws it unchanged rather than not at all.
			const made = this.writeImage(source, new ByteSource(source.data)).catch((error: unknown) => {
				if (!(error instanceof PdfWriteError) || error.reason !== "imageUnsupported") throw error

				return this.image({ data: source.data, ...(source.format === undefined ? {} : { format: source.format }) })
			})

			if (key !== undefined) this.imagesByKey.set(key, made)

			return made
		}

		let entry = key === undefined ? this.imagesByData.get(source.data) : this.imagesByKey.get(key)

		if (entry === undefined) {
			entry = this.dedupeImage(source)

			if (key === undefined) this.imagesByData.set(source.data, entry)
			else this.imagesByKey.set(key, entry)
		}

		return entry
	}

	// The image of an earlier source with the same bytes, else a new one. Each source object is hashed once
	// (the callers above remember its promise); a fingerprint match is confirmed byte for byte.
	private async dedupeImage(source: PdfImageSource): Promise<PdfImage> {
		const bytes = new ByteSource(source.data)
		const hash = await sampledHash(bytes)
		let candidates = this.imagesByHash.get(hash)

		if (candidates === undefined) {
			candidates = []
			this.imagesByHash.set(hash, candidates)
		}

		const earlier = [...candidates]
		const image = (async (): Promise<PdfImage> => {
			for (const candidate of earlier) {
				const other = candidate.data()

				if (other !== undefined && (await sameBytes(bytes, new ByteSource(other)))) return candidate.image
			}

			return this.writeImage(source, bytes)
		})()

		// Registered before any comparison awaits, so a concurrent call with the same bytes finds this one.
		candidates.push({ data: weakly(source.data), image })

		return image
	}

	private async writeImage(source: PdfImageSource, bytes: ByteSource): Promise<PdfImage> {
		this.checkAbort()

		const format = sniffFormat(await bytes.read(0, 16)) ?? source.format

		if (format === undefined) throw new PdfWriteError("imageUnsupported", "Unknown image format")

		const ref = this.allocate()
		const name = this.name("Im")
		const common: PdfDict = {
			Type: pdfName("XObject"),
			Subtype: pdfName("Image"),
			Interpolate: source.interpolate === true ? true : undefined
		}
		let orientation = 1
		const transform = source.transform

		if (format === "jpeg") {
			const jpeg = await readJpeg(bytes)

			if (jpeg !== undefined) orientation = jpeg.orientation

			if (jpeg?.passthrough === true && transform === undefined) {
				const space = jpeg.components === 1 ? "DeviceGray" : jpeg.components === 3 ? "DeviceRGB" : "DeviceCMYK"

				await this.stream(
					ref,
					{
						...common,
						Width: jpeg.width,
						Height: jpeg.height,
						ColorSpace: pdfName(space),
						BitsPerComponent: 8,
						Filter: pdfName("DCTDecode"),
						Decode: jpeg.components === 4 && jpeg.adobe ? [1, 0, 1, 0, 1, 0, 1, 0] : undefined
					},
					bytes.part(0, bytes.size)
				)

				return { ref, name, width: jpeg.width, height: jpeg.height, orientation }
			}
		} else if (format === "png") {
			const png = await readPng(bytes)

			if (png !== undefined && pngPassthrough(png) && transform === undefined) {
				const colors = png.colorType === 2 ? 3 : 1
				const palette = png.palette
				const colorSpace: PdfValue =
					png.colorType === 3 && palette !== undefined
						? [
								pdfName("Indexed"),
								pdfName("DeviceRGB"),
								Math.floor(palette.length / 3) - 1,
								new PdfString(palette.subarray(0, Math.floor(palette.length / 3) * 3))
							]
						: pdfName(png.colorType === 2 ? "DeviceRGB" : "DeviceGray")

				await this.stream(
					ref,
					{
						...common,
						Width: png.width,
						Height: png.height,
						ColorSpace: colorSpace,
						BitsPerComponent: png.bitDepth,
						Filter: pdfName("FlateDecode"),
						DecodeParms: { Predictor: 15, Colors: colors, BitsPerComponent: png.bitDepth, Columns: png.width },
						Mask: pngColorKey(png) ?? undefined
					},
					png.data.map(([start, end]) => bytes.part(start, end))
				)

				return { ref, name, width: png.width, height: png.height, orientation }
			}
		}

		if (this.decoder === undefined) throw new PdfWriteError("imageUnsupported", `No decoder for this ${format} image`)

		const decoded = await this.decoder.decode(source.data, format, this.maxImagePixels)

		transform?.(decoded.rgba)

		return this.writeRgba(ref, name, common, decoded, decoded.oriented === true ? 1 : orientation)
	}

	// Straight RGBA pixels (a picture the caller decoded or drew itself, such as an SVG's raster) as an image, written
	// once per key. The pixels are read before the promise settles and not kept.
	pixels(source: PdfPixelsSource): Promise<PdfImage> {
		let entry = this.imagesByKey.get(source.key)

		if (entry === undefined) {
			this.checkAbort()

			const common: PdfDict = {
				Type: pdfName("XObject"),
				Subtype: pdfName("Image"),
				Interpolate: source.interpolate === true ? true : undefined
			}

			entry = this.writeRgba(this.allocate(), this.name("Im"), common, source, 1)
			this.imagesByKey.set(source.key, entry)
		}

		return entry
	}

	private async writeRgba(ref: PdfRef, name: string, common: PdfDict, decoded: PdfDecodedImage, orientation: number): Promise<PdfImage> {
		const pixels = decoded.width * decoded.height

		if (pixels > this.maxImagePixels) throw new PdfWriteError("imageTooLarge", `The image has ${pixels} pixels`)
		if (!(decoded.width >= 1 && decoded.height >= 1) || decoded.rgba.length < pixels * 4)
			throw new PdfWriteError("imageUnsupported", "The pixels do not fill the image")

		const { rgb, alpha } = splitAlpha(decoded.rgba, pixels)
		let mask: PdfRef | undefined

		if (alpha !== null) {
			this.transparent.add(ref.id)
			mask = this.allocate()
			await this.stream(
				mask,
				{ ...common, Width: decoded.width, Height: decoded.height, ColorSpace: pdfName("DeviceGray"), BitsPerComponent: 8 },
				alpha,
				{ compress: true }
			)
		}

		await this.stream(
			ref,
			{ ...common, Width: decoded.width, Height: decoded.height, ColorSpace: pdfName("DeviceRGB"), BitsPerComponent: 8, SMask: mask },
			rgb,
			{ compress: true }
		)

		return { ref, name, width: decoded.width, height: decoded.height, orientation }
	}

	// --- tagging

	// The MCID for content of `node` on page `page` (undefined in an untagged document).
	mark(node: number, page: number): number | undefined {
		return this.tagged ? this.struct.mark(node, page) : undefined
	}

	structType(node: number): string {
		return this.struct.typeOf(node)
	}

	// Opens a structure element under the current one (no-op id in an untagged document).
	open(type: string, options?: PdfStructOptions): number {
		return this.struct.open(type, options)
	}

	close(node: number): void {
		this.struct.close(node)
	}

	// --- navigation

	destination(name: string, target: PdfDestinationTarget): void {
		this.destinations.set(name, target)
	}

	// A link annotation whose /Dest is `name`. A name no destination defines is left out (ISO 32000-1 §12.5.6.5
	// Table 173: Dest is optional; a link with neither Dest nor A does nothing), never left dangling.
	namedLink(ref: PdfRef, annotation: PdfDict, name: string): void {
		this.namedLinks.push({ ref, annotation, name })
	}

	// An outline entry (bookmark) at `level` (1 top) for a page position or a named destination, in order.
	outline(title: string, level: number, target: PdfDestinationTarget | string): void {
		this.outlines.push({ title, level: Math.max(1, Math.floor(level)), target })
	}

	// [page /XYZ left top null] (§12.3.2.2): positions in px of a page written or yet to come.
	explicitDestination(page: number, x?: number, y?: number): PdfValue {
		const height = this.pageHeights[page]

		return [
			this.pageRef(page),
			pdfName("XYZ"),
			x === undefined ? null : round(x * 0.75),
			y === undefined || height === undefined ? null : round(height - y * 0.75),
			null
		]
	}

	// --- finish

	async finish(): Promise<PdfOutput> {
		if (this.current !== undefined) throw new PdfWriteError("state", "A page is not finished")
		if (this.finished) throw new PdfWriteError("state", "The document is finished")

		for (const [font, entry] of this.fonts) {
			await font.write(this, entry.ref)
			font.close()
			await this.flushObjectsIfFull()
			await this.yieldIfDue()
		}

		const pages: PdfRef[] = []

		for (let index = 0; index < this.pageCount; index++) pages.push(this.pageRef(index))

		if (this.pageRefs.length > this.pageCount) throw new PdfWriteError("state", "A link targets a page that was never written")

		this.object(this.pagesRef, { Type: pdfName("Pages"), Kids: pages, Count: pages.length })

		const pause = async (): Promise<void> => {
			await this.flushObjectsIfFull()
			await this.yieldIfDue()
		}
		const structRoot = this.tagged
			? await this.struct.write(
					() => this.allocate(),
					(ref, value) => this.object(ref, value),
					pause,
					pages,
					this.pageHeights
				)
			: undefined
		const outlines = await this.writeOutlines(pause)
		for (const link of this.namedLinks) {
			// The same bytes as the name tree's key: a JS string would be written as a text string (UTF-16BE
			// once not ASCII), which no reader matches against the UTF-8 key (ISO 32000-1 §7.9.6 compares bytes).
			this.object(link.ref, {
				...link.annotation,
				Dest: this.destinations.has(link.name) ? new PdfString(utf8Bytes(link.name)) : undefined
			})
		}

		this.namedLinks.length = 0
		await pause()

		let names: PdfDict | undefined

		if (this.destinations.size > 0) {
			const entries = [...this.destinations.entries()]
				.map(([name, target]) => ({ key: utf8Bytes(name), target }))
				.sort((a, b) => compareBytes(a.key, b.key))
			const tree = this.allocate()

			this.object(tree, {
				Names: entries.flatMap(({ key, target }) => [new PdfString(key), this.explicitDestination(target.page, target.x, target.y)])
			})
			names = { Dests: tree }
		}

		// A blank title is none. PDF/UA wants the title shown (ISO 14289-1 §7.1: dc:title, DisplayDocTitle): a tagged
		// document without one is still tagged but makes no claim a reader would find false.
		const title = nonBlank(this.options.title)
		const properties = this.options.properties
		const author = nonBlank(properties?.author)
		const subject = nonBlank(properties?.subject)
		const keywords = nonBlank(properties?.keywords)
		// One instant for Info and XMP, which must agree (ISO 32000-1 §14.3.2).
		const created = this.deterministic ? undefined : new Date()
		const metadata = this.allocate()

		await this.stream(
			metadata,
			{ Type: pdfName("Metadata"), Subtype: pdfName("XML") },
			xmpMetadata({ title, author, subject, keywords, created, lang: this.options.lang, pdfua: this.tagged && title !== undefined })
		)

		const catalog = this.allocate()

		this.object(catalog, {
			Type: pdfName("Catalog"),
			Pages: this.pagesRef,
			Outlines: outlines,
			PageMode: outlines === undefined ? undefined : pdfName("UseOutlines"),
			Names: names,
			Metadata: metadata,
			Lang: this.options.lang,
			StructTreeRoot: structRoot,
			MarkInfo: this.tagged ? { Marked: true } : undefined,
			ViewerPreferences: title === undefined ? undefined : { DisplayDocTitle: true },
			// AES-256 (revision 6) is ISO 32000-2's; a 1.7 reader knows it as Adobe extension level 8.
			Extensions: this.security === undefined ? undefined : { ADBE: { BaseVersion: pdfName("1.7"), ExtensionLevel: 8 } }
		})

		const info = this.allocate()

		this.object(info, {
			Producer: "Filen",
			Title: title,
			Author: author,
			Subject: subject,
			Keywords: keywords,
			CreationDate: created === undefined ? undefined : pdfDate(created)
		})
		await this.flushObjects()

		let encrypt: PdfRef | undefined

		if (this.security !== undefined) {
			const d = this.security.dictionary

			encrypt = this.allocate()
			this.direct(encrypt, {
				Filter: pdfName("Standard"),
				V: 5,
				R: 6,
				Length: 256,
				CF: { StdCF: { Type: pdfName("CryptFilter"), CFM: pdfName("AESV3"), AuthEvent: pdfName("DocOpen"), Length: 32 } },
				StmF: pdfName("StdCF"),
				StrF: pdfName("StdCF"),
				O: new PdfString(d.O),
				U: new PdfString(d.U),
				OE: new PdfString(d.OE),
				UE: new PdfString(d.UE),
				Perms: new PdfString(d.Perms),
				P: d.P
			})
		}

		await this.writeXref(catalog, info, encrypt)
		this.finished = true

		return { parts: this.parts, size: this.offset }
	}

	private async writeOutlines(pause: () => Promise<void>): Promise<PdfRef | undefined> {
		if (this.outlines.length === 0) return undefined

		const root = this.allocate()
		const refs = this.outlines.map(() => this.allocate())
		const parents: number[] = []
		const children: number[][] = this.outlines.map(() => [])
		const top: number[] = []
		const stack: number[] = []
		// Each entry's index among its siblings.
		const positions: number[] = []

		this.outlines.forEach((item, index) => {
			while (stack.length > 0 && (this.outlines[stack[stack.length - 1] ?? 0]?.level ?? 0) >= item.level) stack.pop()

			const parent = stack[stack.length - 1] ?? -1

			parents[index] = parent

			const siblings = parent === -1 ? top : children[parent]

			positions[index] = siblings?.length ?? 0
			siblings?.push(index)

			stack.push(index)
		})

		const counts: number[] = []
		const countOf = (index: number): number => {
			let count = 0

			for (const child of children[index] ?? []) count += 1 + countOf(child)

			counts[index] = count

			return count
		}

		let total = 0

		for (const index of top) total += 1 + countOf(index)

		const siblingsOf = (index: number): number[] => {
			const parent = parents[index] ?? -1

			return parent === -1 ? top : (children[parent] ?? [])
		}

		for (let index = 0; index < this.outlines.length; index++) {
			const item = this.outlines[index]
			const ref = refs[index]

			if (item === undefined || ref === undefined) continue
			if (index % 256 === 255) await pause()

			const siblings = siblingsOf(index)
			const position = positions[index] ?? 0
			const kids = children[index] ?? []
			const parent = parents[index] ?? -1
			const target = item.target

			this.object(ref, {
				Title: item.title,
				Parent: parent === -1 ? root : refs[parent],
				Prev: position > 0 ? refs[siblings[position - 1] ?? 0] : undefined,
				Next: position < siblings.length - 1 ? refs[siblings[position + 1] ?? 0] : undefined,
				First: kids.length === 0 ? undefined : refs[kids[0] ?? 0],
				Last: kids.length === 0 ? undefined : refs[kids[kids.length - 1] ?? 0],
				Count: kids.length === 0 ? undefined : counts[index],
				// An undefined name is left out: Dest is optional (ISO 32000-1 §12.3.3 Table 153).
				Dest:
					typeof target !== "string"
						? this.explicitDestination(target.page, target.x, target.y)
						: this.destinations.has(target)
							? new PdfString(utf8Bytes(target))
							: undefined
			})
		}

		this.object(root, {
			Type: pdfName("Outlines"),
			First: refs[top[0] ?? 0],
			Last: refs[top[top.length - 1] ?? 0],
			Count: total
		})

		return root
	}

	// §7.5.8: the cross-reference stream, never encrypted, with the trailer entries.
	private async writeXref(catalog: PdfRef, info: PdfRef, encrypt: PdfRef | undefined): Promise<void> {
		const xref = this.allocate()
		const size = this.nextId
		const position = this.offset

		this.xrefType[xref.id] = 1
		this.xrefField2[xref.id] = position

		const offsetBytes = position < 2 ** 32 ? 4 : 6
		const width = 1 + offsetBytes + 2
		const table = new Uint8Array(size * width)

		for (let id = 0; id < size; id++) {
			const at = id * width
			const type = this.xrefType[id] ?? 0
			let field2 = type === 0 ? 0 : (this.xrefField2[id] ?? 0)
			const field3 = id === 0 ? 0xffff : type === 2 ? (this.xrefField3[id] ?? 0) : 0

			table[at] = type

			for (let k = offsetBytes; k >= 1; k--) {
				table[at + k] = field2 % 256
				field2 = Math.floor(field2 / 256)
			}

			table[at + offsetBytes + 1] = field3 >>> 8
			table[at + offsetBytes + 2] = field3 & 255
		}

		const id = this.documentId()
		const compressed = this.deflate === undefined ? table : await this.deflate(table)
		const head = new ByteWriter(512)

		head.int(xref.id).ascii(" 0 obj\n")
		writeValue(head, {
			Type: pdfName("XRef"),
			Size: size,
			W: [1, offsetBytes, 2],
			Root: catalog,
			Info: info,
			ID: [new PdfString(id), new PdfString(id)],
			Encrypt: encrypt,
			Filter: this.deflate === undefined ? undefined : pdfName("FlateDecode"),
			Length: compressed.length
		})
		head.ascii("\nstream\n")
		this.emit(head.take())
		this.emit(compressed)
		this.emit(ENDSTREAM)
		this.emit(utf8(`startxref\n${position}\n%%EOF\n`))
	}

	// §14.4: a file identifier, random (or from the title, deterministic).
	private documentId(): Uint8Array {
		if (!this.deterministic) return (this.options.random ?? platformRandom)(16)

		return deterministicRandom(`${this.options.title ?? ""}\u0000${this.pageCount}`)(16)
	}
}

export interface GradientResources {
	readonly shading: { readonly name: string; readonly ref: PdfRef }
	readonly state: { readonly name: string; readonly ref: PdfRef } | undefined
}

const ENDSTREAM = utf8("\nendstream\nendobj\n")

// §7.9.4: D:YYYYMMDDHHmmSSZ (UTC).
function pdfDate(date: Date): string {
	const two = (value: number): string => String(value).padStart(2, "0")

	return `D:${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000
}

function nonBlank(text: string | undefined): string | undefined {
	return text !== undefined && text.trim().length > 0 ? text : undefined
}

function utf8Bytes(text: string): Uint8Array {
	return utf8(text)
}

function compareBytes(x: Uint8Array, y: Uint8Array): number {
	for (let index = 0; index < Math.min(x.length, y.length); index++) {
		const difference = (x[index] ?? 0) - (y[index] ?? 0)

		if (difference !== 0) return difference
	}

	return x.length - y.length
}

async function readAll(parts: readonly (Uint8Array | PdfBlobLike)[]): Promise<Uint8Array> {
	const chunks: Uint8Array[] = []

	for (const part of parts) chunks.push(part instanceof Uint8Array ? part : new Uint8Array(await part.arrayBuffer()))

	return chunks.length === 1 && chunks[0] !== undefined ? chunks[0] : concat(chunks)
}

// A weak reference where the platform has one (a strong one otherwise: only dedupe memory is at stake).
function weakly(data: PdfImageData): () => PdfImageData | undefined {
	const Weak = Reflect.get(globalThis, "WeakRef") as (new (target: object) => { deref(): object | undefined }) | undefined

	if (typeof Weak !== "function") return () => data

	const ref = new Weak(data)

	return () => ref.deref() as PdfImageData | undefined
}

// A xorshift stream seeded from text: a stable file ID for deterministic output (never for secrets).
function deterministicRandom(seed: string): RandomBytes {
	let state = 0x9e3779b9

	for (const byte of utf8(seed)) state = Math.imul(state ^ byte, 0x01000193) >>> 0

	return length => {
		const out = new Uint8Array(length)

		for (let index = 0; index < length; index++) {
			state ^= state << 13
			state ^= state >>> 17
			state ^= state << 5
			state >>>= 0
			out[index] = state & 255
		}

		return out
	}
}
