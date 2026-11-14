import type * as Mupdf from "mupdf"
import type { ByteRange } from "../../core/pdfsign/byteRange"
import {
	BYTE_RANGE_SENTINEL,
	locatePlaceholder,
	patchByteRange,
	patchContents,
	type SignaturePlaceholder
} from "../../core/pdfsign/placeholder"
import { digestRanges, type PdfDigestFactory } from "../../core/pdfsign/source"
import type { PdfDigestName } from "../../core/pdfsign/types"

// Signing an open MuPDF document with a certificate, in two steps around the CMS signature that is made elsewhere (the
// signer worker holds the key):
//
// 1. addPdfSignatureField (one journal operation, "Sign"): the signature field and its widget (a drawn rectangle, or an
//    existing empty signature field), the widget's appearance (the visual signature and lines of text as one form
//    XObject; only this widget's appearance is generated) and its /V dictionary (/Adobe.PPKLite, ETSI.CAdES.detached,
//    a /ByteRange of sentinels, /Contents of zeros sized for the CMS), SigFlags 3 and, for a certification, /Perms
//    /DocMDP. Nothing else in the document is touched.
// 2. signPdfDocument: an incremental save (the earlier revisions and their signatures stay byte for byte), the
//    placeholder found in the appended revision (its /Contents must be an unencrypted hex string, which MuPDF writes for
//    signature dictionaries of encrypted documents too), /ByteRange patched, the signed ranges digested, the CMS
//    requested and written into /Contents. A CMS larger than the space left triggers one more save with room for it.

// A drawn signature or an image, as the visual signature tools produce it.
export type PdfVisualSignatureInput =
	| {
			readonly kind: "strokes"
			// The drawing's own box; points are in it, y down.
			readonly width: number
			readonly height: number
			readonly strokes: readonly (readonly (readonly [number, number])[])[]
			// In the drawing's units.
			readonly lineWidth: number
			// RGB, 0..1.
			readonly color: readonly [number, number, number]
	  }
	| { readonly kind: "image"; readonly png: Uint8Array }

export type PdfSignaturePlacement =
	// A new field on `page` (0-based) at `rect` in MuPDF page space (the page as shown: origin top left, rotation applied).
	| { readonly kind: "rect"; readonly page: number; readonly rect: Mupdf.Rect }
	// An existing empty signature field, by fully qualified name.
	| { readonly kind: "field"; readonly name: string }

export interface PdfSignatureFieldRequest {
	readonly placement: PdfSignaturePlacement
	// What the widget shows: the visual signature (left) and lines of text (right), either may be absent.
	readonly visual: PdfVisualSignatureInput | null
	readonly lines: readonly string[]
	// /Name, /Reason, /Location of the signature dictionary.
	readonly name: string | null
	readonly reason: string | null
	readonly location: string | null
	// /M, the time the signer claims.
	readonly time: Date
	// A certification (DocMDP) at this level: allowed only as the document's first signature.
	readonly certify: 1 | 2 | 3 | null
	// Bytes the CMS may take (cmsCapacity); /Contents holds twice that in hex.
	readonly capacity: number
}

export interface PdfSignatureDraft {
	readonly pages: readonly number[]
	readonly field: string
	// The signature dictionary's object number.
	readonly signatureNum: number
}

export type PdfSignRefusalReason =
	// A certification at level 1 forbids any change, more signatures included.
	| "certifiedLocked"
	// Only the first signature may certify.
	| "certifyAfterSignature"
	| "fieldNotFound"
	| "fieldSigned"
	| "pageOutOfRange"
	// The document cannot be saved incrementally (it needed repair), so earlier revisions would not survive.
	| "notIncremental"
	// The saved placeholder is not what was written (for instance encrypted): nothing is patched.
	| "placeholder"

export class PdfSignRefusal extends Error {
	override readonly name = "PdfSignRefusal"

	readonly reason: PdfSignRefusalReason

	constructor(reason: PdfSignRefusalReason) {
		super(reason)
		this.reason = reason
	}
}

const WIDGET_FLAGS = 132 // Print | Locked
const SIG_FLAGS = 3 // SignaturesExist | AppendOnly
const MAX_FIELD_DEPTH = 32
const MAX_FIELDS = 100_000
const MAX_FONT_SIZE = 24
const MIN_FONT_SIZE = 2
const LINE_GAP = 1.2
// Extra room on a second pass, so a CMS a few bytes over the estimate never needs a third.
const RESIZE_MARGIN = 512

type MupdfModule = typeof Mupdf
type PDFDocument = Mupdf.PDFDocument
type PDFObject = Mupdf.PDFObject

function refuse(reason: PdfSignRefusalReason): never {
	throw new PdfSignRefusal(reason)
}

function deref(object: PDFObject): PDFObject {
	return object.isNull() ? object : object.resolve()
}

function nameOf(object: PDFObject): string | null {
	const resolved = deref(object)

	return resolved.isName() ? resolved.asName() : null
}

function pdfDate(date: Date): string {
	const pad = (value: number, size = 2): string => String(value).padStart(size, "0")

	return `D:${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(
		date.getUTCMinutes()
	)}${pad(date.getUTCSeconds())}+00'00'`
}

interface FieldEntry {
	readonly name: string
	readonly type: string | null
	readonly dict: PDFObject
	// The field as listed (an indirect reference, normally): what is written to, resolved at the time of writing.
	readonly ref: PDFObject
	// The field's widgets (the field itself when merged).
	readonly widgets: readonly PDFObject[]
}

// Terminal fields of the AcroForm tree by fully qualified name.
function formFields(document: PDFDocument): FieldEntry[] {
	const fields: FieldEntry[] = []
	const seen = new Set<number>()
	const roots = deref(document.getTrailer().get("Root", "AcroForm", "Fields"))

	const visit = (field: PDFObject, parent: string | null, inheritedType: string | null, depth: number): void => {
		const dict = deref(field)

		if (depth > MAX_FIELD_DEPTH || fields.length >= MAX_FIELDS || !dict.isDictionary()) return
		if (field.isIndirect()) {
			if (seen.has(field.asIndirect())) return

			seen.add(field.asIndirect())
		}

		const partialObject = deref(dict.get("T"))
		const partial = partialObject.isString() ? partialObject.asString() : null
		const name = partial === null ? parent : parent === null ? partial : `${parent}.${partial}`
		const type = nameOf(dict.get("FT")) ?? inheritedType
		const kids = deref(dict.get("Kids"))
		const children: PDFObject[] = []
		const widgets: PDFObject[] = nameOf(dict.get("Subtype")) === "Widget" ? [field] : []

		if (kids.isArray()) {
			for (let i = 0; i < kids.length; i++) {
				const kid = kids.get(i)
				const kidDict = deref(kid)

				if (kidDict.isDictionary() && kidDict.get("T").isNull()) widgets.push(kid)
				else children.push(kid)
			}
		}

		if (name !== null && children.length === 0) fields.push({ name, type, dict, ref: field, widgets })

		for (const child of children) visit(child, name, type, depth + 1)
	}

	if (roots.isArray()) for (let i = 0; i < roots.length; i++) visit(roots.get(i), null, null, 0)

	return fields
}

// The DocMDP level of the document's certification, if any.
function certification(document: PDFDocument): number | null {
	const references = deref(document.getTrailer().get("Root", "Perms", "DocMDP", "Reference"))

	if (!references.isArray()) return null

	for (let i = 0; i < references.length; i++) {
		const reference = deref(references.get(i))

		if (nameOf(reference.get("TransformMethod")) === "DocMDP") {
			const p = deref(reference.get("TransformParams", "P"))

			return p.isNumber() ? p.asNumber() : 2
		}
	}

	return null
}

function pageOf(document: PDFDocument, widget: PDFObject): number {
	const pageRef = widget.isNull() ? widget : deref(widget).get("P")
	const target = pageRef.isIndirect() ? pageRef.asIndirect() : null
	const widgetNum = widget.isIndirect() ? widget.asIndirect() : null
	const count = document.countPages()

	for (let i = 0; i < count; i++) {
		const page = document.findPage(i)

		if (target !== null && page.isIndirect() && page.asIndirect() === target) return i

		// No /P: the page whose /Annots lists the widget.
		const annots = deref(deref(page).get("Annots"))

		if (target === null && widgetNum !== null && annots.isArray()) {
			for (let k = 0; k < annots.length; k++) {
				const annot = annots.get(k)

				if (annot.isIndirect() && annot.asIndirect() === widgetNum) return i
			}
		}
	}

	return refuse("fieldNotFound")
}

function uniqueFieldName(fields: readonly FieldEntry[]): string {
	const names = new Set(fields.map(field => field.name))
	let n = fields.filter(field => field.type === "Sig").length + 1

	while (names.has(`Signature${String(n)}`)) n++

	return `Signature${String(n)}`
}

function pageRotation(page: Mupdf.PDFPage): number {
	const rotate = deref(page.getObject().getInheritable("Rotate"))
	const quarters = rotate.isNumber() ? Math.round(rotate.asNumber() / 90) : 0

	return (((quarters % 4) + 4) % 4) * 90
}

// ---- appearance ----

function fmt(value: number): string {
	return String(Math.round(value * 1000) / 1000)
}

interface TextRun {
	readonly operand: string
	readonly width: number
}

// Text set in Helvetica: base-14 WinAnsi (no font embedded) when every character is Latin-1, else MuPDF's Nimbus Sans
// as an embedded CID font (Latin, Greek, Cyrillic); a character neither has is shown as "?".
interface AppearanceFont {
	readonly ref: PDFObject
	run(text: string): TextRun
}

function isLatin1(text: string): boolean {
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0

		if (code < 0x20 || (code > 0x7e && code < 0xa0) || code > 0xff) return false
	}

	return true
}

function appearanceFont(mupdf: MupdfModule, document: PDFDocument, lines: readonly string[]): AppearanceFont {
	const font = new mupdf.Font("Helvetica")
	const advance = (code: number): number => font.advanceGlyph(font.encodeCharacter(code))

	if (lines.every(isLatin1)) {
		return {
			ref: document.addSimpleFont(font, "Latin"),
			run(text) {
				let operand = "("
				let width = 0

				for (const char of text) {
					const code = char.codePointAt(0) ?? 0x3f

					width += advance(code)
					operand +=
						code === 0x28 || code === 0x29 || code === 0x5c
							? `\\${char}`
							: code > 0x7e
								? `\\${code.toString(8).padStart(3, "0")}`
								: char
				}

				return { operand: `${operand})`, width }
			}
		}
	}

	const fallback = font.encodeCharacter(0x3f)

	return {
		ref: document.addFont(font),
		run(text) {
			let operand = "<"
			let width = 0

			for (const char of text) {
				let gid = font.encodeCharacter(char.codePointAt(0) ?? 0x3f)

				if (gid <= 0) gid = fallback

				width += font.advanceGlyph(gid)
				operand += gid.toString(16).padStart(4, "0")
			}

			return { operand: `${operand}>`, width }
		}
	}
}

function strokesContent(visual: Extract<PdfVisualSignatureInput, { kind: "strokes" }>, x: number, y: number, w: number, h: number): string {
	if (visual.width <= 0 || visual.height <= 0) return ""

	const scale = Math.min(w / visual.width, h / visual.height)
	const ox = x + (w - visual.width * scale) / 2
	const oy = y + (h - visual.height * scale) / 2
	const point = ([px, py]: readonly [number, number]): string => `${fmt(ox + px * scale)} ${fmt(oy + (visual.height - py) * scale)}`
	const [r, g, b] = visual.color
	let out = `q 1 J 1 j ${fmt(Math.max(visual.lineWidth * scale, 0.1))} w ${fmt(r)} ${fmt(g)} ${fmt(b)} RG\n`

	for (const stroke of visual.strokes) {
		const [first] = stroke

		if (first === undefined) continue

		out += `${point(first)} m`

		// A lone point draws as a dot through the round cap.
		for (const next of stroke.length === 1 ? stroke : stroke.slice(1)) out += ` ${point(next)} l`

		out += " S\n"
	}

	return `${out}Q\n`
}

function imageContent(image: Mupdf.Image, x: number, y: number, w: number, h: number): string {
	const iw = image.getWidth()
	const ih = image.getHeight()

	if (iw <= 0 || ih <= 0) return ""

	const scale = Math.min(w / iw, h / ih)
	const dw = iw * scale
	const dh = ih * scale

	return `q ${fmt(dw)} 0 0 ${fmt(dh)} ${fmt(x + (w - dw) / 2)} ${fmt(y + (h - dh) / 2)} cm /Im1 Do Q\n`
}

interface Appearance {
	readonly resources: PDFObject
	readonly contents: string
}

// The form XObject content of a box `width` × `height` (as the reader sees it).
function buildAppearance(
	mupdf: MupdfModule,
	document: PDFDocument,
	request: PdfSignatureFieldRequest,
	width: number,
	height: number
): Appearance {
	const resources = document.newDictionary()
	const pad = Math.min(width, height) * 0.06
	const innerW = Math.max(width - pad * 2, 0)
	const innerH = Math.max(height - pad * 2, 0)
	const lines = request.lines.filter(line => line.length > 0)
	const { visual } = request
	const split = visual !== null && lines.length > 0
	const visualW = split ? innerW * 0.45 : innerW
	let contents = ""

	if (visual?.kind === "strokes") contents += strokesContent(visual, pad, pad, visualW, innerH)

	if (visual?.kind === "image") {
		const image = new mupdf.Image(visual.png)
		const xobjects = document.newDictionary()

		xobjects.put("Im1", document.addImage(image))
		resources.put("XObject", xobjects)
		contents += imageContent(image, pad, pad, visualW, innerH)
		image.destroy()
	}

	if (lines.length > 0) {
		const font = appearanceFont(mupdf, document, lines)
		const fonts = document.newDictionary()
		const textX = split ? pad + visualW + pad : pad
		const textW = Math.max(innerW - (split ? visualW + pad : 0), 0)
		const runs = lines.map(line => font.run(line))
		const widest = Math.max(...runs.map(run => run.width), 0.001)
		const size = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, innerH / (lines.length * LINE_GAP), textW / widest))
		const block = size * LINE_GAP * lines.length
		let baseline = pad + (innerH + block) / 2 - size

		fonts.put("F1", font.ref)
		resources.put("Font", fonts)
		contents += `q 0 g BT /F1 ${fmt(size)} Tf\n`

		for (const run of runs) {
			contents += `1 0 0 1 ${fmt(textX)} ${fmt(baseline)} Tm ${run.operand} Tj\n`
			baseline -= size * LINE_GAP
		}

		contents += "ET Q\n"
	}

	return { resources, contents }
}

// ---- the field ----

function findPlacedWidget(page: Mupdf.PDFPage, num: number): Mupdf.PDFWidget {
	const widget = page.getWidgets().find(item => {
		const object = item.getObject()

		return object.isIndirect() && object.asIndirect() === num
	})

	return widget ?? refuse("fieldNotFound")
}

export function addPdfSignatureField(mupdf: MupdfModule, document: PDFDocument, request: PdfSignatureFieldRequest): PdfSignatureDraft {
	const fields = formFields(document)
	const signed = fields.some(field => field.type === "Sig" && deref(field.dict.get("V")).isDictionary())

	if (certification(document) === 1) refuse("certifiedLocked")
	if (request.certify !== null && signed) refuse("certifyAfterSignature")

	const trailer = document.getTrailer()
	const root = trailer.get("Root")
	let pageIndex: number
	let widget: Mupdf.PDFWidget | Mupdf.PDFAnnotation
	// Written through its reference: editing an annotation (the appearance below) may replace its resolved object.
	let fieldDict: PDFObject
	let fieldName: string
	let newField: PDFObject | null = null

	if (request.placement.kind === "field") {
		const { name } = request.placement
		const field = fields.find(item => item.name === name && item.type === "Sig")
		const first = field?.widgets[0]

		if (field === undefined || first === undefined) return refuse("fieldNotFound")
		if (!deref(field.dict.get("V")).isNull()) refuse("fieldSigned")

		pageIndex = pageOf(document, first)

		const page = document.loadPage(pageIndex)

		widget = findPlacedWidget(page, first.asIndirect())
		fieldDict = field.ref
		fieldName = field.name
	} else {
		const { page: index, rect } = request.placement

		if (!Number.isInteger(index) || index < 0 || index >= document.countPages()) refuse("pageOutOfRange")

		pageIndex = index
		fieldName = uniqueFieldName(fields)

		const page = document.loadPage(index)
		const annot = page.createAnnotation("Widget")
		const object = annot.getObject()

		object.put("FT", document.newName("Sig"))
		object.put("T", document.newString(fieldName))
		object.put("F", WIDGET_FLAGS)
		annot.setRect(rect)
		widget = annot
		fieldDict = object
		newField = object
	}

	const page = document.loadPage(pageIndex)
	const rotation = pageRotation(page)
	const [x0, y0, x1, y1] = widget.getRect()
	// The box as the reader sees it; the appearance turns with the page so its text stays upright.
	const width = Math.abs(x1 - x0)
	const height = Math.abs(y1 - y0)
	const appearance = buildAppearance(mupdf, document, request, width, height)
	const radians = (rotation * Math.PI) / 180
	const cos = Math.round(Math.cos(radians))
	const sin = Math.round(Math.sin(radians))

	widget.setAppearance(null, null, [cos, sin, -sin, cos, 0, 0], [0, 0, width, height], appearance.resources, appearance.contents)
	widget.update()

	// The signature dictionary.
	const signature = document.newDictionary()

	signature.put("Type", document.newName("Sig"))
	signature.put("Filter", document.newName("Adobe.PPKLite"))
	signature.put("SubFilter", document.newName("ETSI.CAdES.detached"))
	signature.put("ByteRange", sentinelRange(document))
	signature.put("Contents", document.newByteString(new Uint8Array(request.capacity)))
	signature.put("M", document.newString(pdfDate(request.time)))

	if (request.name !== null) signature.put("Name", document.newString(request.name))
	if (request.reason !== null) signature.put("Reason", document.newString(request.reason))
	if (request.location !== null) signature.put("Location", document.newString(request.location))

	if (request.certify !== null) {
		const params = document.newDictionary()
		const reference = document.newDictionary()
		const references = document.newArray()

		params.put("Type", document.newName("TransformParams"))
		params.put("P", request.certify)
		params.put("V", document.newName("1.2"))
		reference.put("Type", document.newName("SigRef"))
		reference.put("TransformMethod", document.newName("DocMDP"))
		reference.put("TransformParams", params)
		references.push(reference)
		signature.put("Reference", references)
	}

	const signatureRef = document.addObject(signature)

	fieldDict.put("V", signatureRef)

	// The form: the new field listed, SigFlags set (only when different, so a signed document's form is not rewritten).
	let acroForm = root.get("AcroForm")

	if (acroForm.isNull()) {
		acroForm = document.addObject(document.newDictionary())
		root.put("AcroForm", acroForm)
	}

	const form = deref(acroForm)

	if (newField !== null) {
		let list = form.get("Fields")

		if (list.isNull()) {
			list = document.newArray()
			form.put("Fields", list)
		}

		deref(list).push(newField)
	}

	const flags = deref(form.get("SigFlags"))

	if (!flags.isNumber() || flags.asNumber() !== SIG_FLAGS) form.put("SigFlags", SIG_FLAGS)

	if (request.certify !== null) {
		let perms = root.get("Perms")

		if (perms.isNull()) {
			perms = document.newDictionary()
			root.put("Perms", perms)
		}

		deref(perms).put("DocMDP", signatureRef)
	}

	return { pages: [pageIndex], field: fieldName, signatureNum: signatureRef.asIndirect() }
}

// ---- the signed save ----

// MuPDF treats an incremental save as the document's new file: its next incremental save would append to that output,
// which the document does not read from. So signing spends the document once it has saved (whatever happens next):
// the caller reopens it on the signed output, or on the original file when signing failed.

export interface PdfSignedRevision {
	// The whole output; a view into MuPDF's heap, valid until destroy().
	readonly bytes: Uint8Array
	readonly byteRange: ByteRange
	// Offset of the `<` of /Contents.
	readonly contentsOffset: number
	// Bytes the CMS may take.
	readonly gap: number
	// Writes the CMS into /Contents; false when it does not fit (a second pass with more room).
	patch(cms: Uint8Array): boolean
	destroy(): void
}

export interface WritePdfSignatureOptions {
	// Length of the file the document was opened from: the appended revision starts there.
	readonly baseLength: number
	// /Contents room in bytes; the placeholder is resized when it differs from the draft's.
	readonly capacity: number
}

interface WrittenRevision extends PdfSignedRevision {
	readonly buffer: Mupdf.Buffer
}

function sentinelRange(document: PDFDocument): PDFObject {
	const range = document.newArray()

	range.push(0)

	for (let i = 0; i < 3; i++) range.push(BYTE_RANGE_SENTINEL)

	return range
}

// The placeholder as written by addPdfSignatureField, sized `capacity` (a reopened first output carries its patched
// /ByteRange, which goes back to the sentinels).
function setPlaceholder(document: PDFDocument, draft: PdfSignatureDraft, capacity: number): void {
	const signature = document.newIndirect(draft.signatureNum)
	const contents = deref(signature.get("Contents"))
	const range = deref(signature.get("ByteRange"))

	if (!contents.isString() || contents.asByteString().length !== capacity) {
		signature.put("Contents", document.newByteString(new Uint8Array(capacity)))
	}

	if (range.toString(true) !== sentinelRange(document).toString(true)) signature.put("ByteRange", sentinelRange(document))
}

function writeRevision(document: PDFDocument, draft: PdfSignatureDraft, options: WritePdfSignatureOptions): WrittenRevision {
	if (!document.canBeSavedIncrementally()) refuse("notIncremental")

	setPlaceholder(document, draft, options.capacity)

	const buffer = document.saveToBuffer("incremental")
	const bytes = buffer.asUint8Array()
	let placeholder: SignaturePlaceholder
	let byteRange: ByteRange

	try {
		placeholder = locatePlaceholder(bytes, draft.signatureNum, options.baseLength, options.capacity)
		byteRange = patchByteRange(bytes, placeholder)
	} catch {
		buffer.destroy()

		return refuse("placeholder")
	}

	return {
		buffer,
		bytes,
		byteRange,
		contentsOffset: placeholder.contentsStart,
		gap: options.capacity,
		patch: cms => patchContents(bytes, placeholder, cms),
		destroy: () => {
			buffer.destroy()
		}
	}
}

// Saves the document incrementally with the placeholder and patches /ByteRange (the document is spent, see above).
// The bytes before `baseLength` are the original file, unchanged.
export function writePdfSignature(document: PDFDocument, draft: PdfSignatureDraft, options: WritePdfSignatureOptions): PdfSignedRevision {
	return writeRevision(document, draft, options)
}

export interface SignPdfDocumentOptions extends WritePdfSignatureOptions {
	readonly digest: PdfDigestName
	readonly createDigest: PdfDigestFactory
	// Makes the CMS for the digest of the signed ranges (in the signer worker).
	readonly sign: (digest: Uint8Array) => Promise<Uint8Array>
	// The password the document was opened with: a second pass reopens the first output.
	readonly password?: string | null
}

async function signRevision(revision: PdfSignedRevision, options: SignPdfDocumentOptions): Promise<Uint8Array> {
	const { bytes, byteRange } = revision
	const digests = await digestRanges(
		{ length: bytes.length, read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)) },
		[
			[byteRange[0], byteRange[1]],
			[byteRange[2], byteRange[3]]
		],
		[options.digest],
		options.createDigest
	)

	return options.sign(digests.get(options.digest) ?? new Uint8Array(0))
}

// Digests the revision's signed ranges, has them signed and patches the CMS in; false when it does not fit. The
// revision is destroyed when signing fails.
async function completeRevision(
	revision: WrittenRevision,
	options: SignPdfDocumentOptions
): Promise<{ readonly fits: boolean; readonly size: number }> {
	let cms: Uint8Array

	try {
		cms = await signRevision(revision, options)
	} catch (error) {
		revision.destroy()

		throw error
	}

	return { fits: revision.patch(cms), size: cms.length }
}

// Saves, digests, signs and patches. A CMS larger than the placeholder costs a second pass: the first output is
// reopened in place and the signature dictionary saved once more in a revision sized for it, which supersedes the
// first revision's placeholder (covered by the signature like everything before it). Returns the signed file (destroy()
// it once uploaded). The document is spent either way (see above).
export async function signPdfDocument(
	mupdf: MupdfModule,
	document: PDFDocument,
	draft: PdfSignatureDraft,
	options: SignPdfDocumentOptions
): Promise<PdfSignedRevision> {
	const first = writeRevision(document, draft, options)
	const firstPass = await completeRevision(first, options)

	if (firstPass.fits) return first

	let second: WrittenRevision

	try {
		const reopened = new mupdf.PDFDocument(first.buffer)

		try {
			if (reopened.needsPassword() && reopened.authenticatePassword(options.password ?? "") === 0) refuse("placeholder")

			second = writeRevision(reopened, draft, { baseLength: first.bytes.length, capacity: firstPass.size + RESIZE_MARGIN })
		} finally {
			reopened.destroy()
		}
	} finally {
		first.destroy()
	}

	if ((await completeRevision(second, options)).fits) return second

	second.destroy()

	return refuse("placeholder")
}
