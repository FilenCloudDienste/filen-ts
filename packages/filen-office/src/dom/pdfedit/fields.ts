import type { PDFDocument, PDFObject } from "mupdf"
import { signedEnd } from "../../core/pdfsign/byteRange"
import { certificationLevel, type PdfCertificationLevel, type PdfFieldLock } from "../../core/pdfsign/policy"
import type { PdfSignatureFieldHint } from "../pdf/signatureFields"

// Reading a document's form through MuPDF's object access: the AcroForm field tree, signature dictionaries and what
// they lock. Shared by the signature verifier and the editor (no CMS or crypto here).

export interface FieldRecord {
	readonly name: string
	readonly partialName: string
	readonly type: string | null
	readonly dict: PDFObject
	readonly num: number | null
	readonly widget: PDFObject | null
}

export interface SignatureField extends FieldRecord {
	readonly value: PDFObject
	readonly valueNum: number | null
	readonly page: number | null
	readonly rect: readonly [number, number, number, number] | null
}

export const MAX_FIELD_DEPTH = 32
export const MAX_FIELDS = 100_000

// MuPDF's null object has no document: every read of a missing value goes through these, which pass it on.
export function deref(object: PDFObject): PDFObject {
	return object.isNull() ? object : object.resolve()
}

// The value at a key or index path, unresolved (to read its object number) or resolved.
export function ref(object: PDFObject, ...path: (string | number)[]): PDFObject {
	return object.isNull() ? object : object.get(...path)
}

export function at(object: PDFObject, ...path: (string | number)[]): PDFObject {
	return deref(ref(object, ...path))
}

export function name(object: PDFObject): string | null {
	const resolved = deref(object)

	return resolved.isName() ? resolved.asName() : null
}

export function text(object: PDFObject): string | null {
	const resolved = deref(object)

	return resolved.isString() ? resolved.asString() : null
}

export function num(object: PDFObject): number | null {
	return object.isIndirect() ? object.asIndirect() : null
}

export function numberArray(object: PDFObject): number[] | null {
	const resolved = deref(object)

	if (!resolved.isArray()) return null

	const out: number[] = []

	for (let i = 0; i < resolved.length; i++) {
		const item = at(resolved, i)

		if (!item.isNumber()) return null

		out.push(item.asNumber())
	}

	return out
}

export function rectOf(object: PDFObject): [number, number, number, number] | null {
	const values = numberArray(ref(object, "Rect"))

	if (values?.length !== 4) return null

	const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = values

	return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
}

// Every field of the AcroForm tree by fully qualified name, with its type (inherited) and its first widget.
export function collectFields(document: PDFDocument): { readonly fields: FieldRecord[]; readonly names: Map<number, string> } {
	const fields: FieldRecord[] = []
	const names = new Map<number, string>()
	const seen = new Set<number>()
	const roots = at(document.getTrailer(), "Root", "AcroForm", "Fields")

	const visit = (field: PDFObject, parent: string | null, inheritedType: string | null, depth: number): void => {
		const fieldNum = num(field)
		const dict = deref(field)

		if (depth > MAX_FIELD_DEPTH || fields.length >= MAX_FIELDS || !dict.isDictionary()) return
		if (fieldNum !== null) {
			if (seen.has(fieldNum)) return

			seen.add(fieldNum)
		}

		const partial = text(ref(dict, "T"))
		const fullName = partial === null ? parent : parent === null ? partial : `${parent}.${partial}`
		const type = name(ref(dict, "FT")) ?? inheritedType
		const kids = at(dict, "Kids")
		const childFields: PDFObject[] = []
		let widget: PDFObject | null = name(ref(dict, "Subtype")) === "Widget" ? dict : null

		if (kids.isArray()) {
			for (let i = 0; i < kids.length; i++) {
				const kid = ref(kids, i)
				const kidDict = deref(kid)

				// A kid without a name is one of this field's widgets.
				if (kidDict.isDictionary() && ref(kidDict, "T").isNull()) {
					widget ??= kidDict

					const kidNum = num(kid)

					if (kidNum !== null && fullName !== null) names.set(kidNum, fullName)
				} else childFields.push(kid)
			}
		}

		if (fullName !== null) {
			if (fieldNum !== null) names.set(fieldNum, fullName)
			if (childFields.length === 0) fields.push({ name: fullName, partialName: partial ?? "", type, dict, num: fieldNum, widget })
		}

		for (const child of childFields) visit(child, fullName, type, depth + 1)
	}

	if (roots.isArray()) for (let i = 0; i < roots.length; i++) visit(ref(roots, i), null, null, 0)

	return { fields, names }
}

export function pageIndexOf(widget: PDFObject | null, pages: () => Map<number, number>): number | null {
	if (widget === null) return null

	const pageNum = num(ref(widget, "P"))

	return pageNum === null ? null : (pages().get(pageNum) ?? null)
}

export function lazyPages(document: PDFDocument): () => Map<number, number> {
	let pages: Map<number, number> | null = null

	return () => {
		if (pages === null) {
			pages = new Map()

			const count = document.countPages()

			for (let i = 0; i < count; i++) {
				const pageNum = num(document.findPage(i))

				if (pageNum !== null) pages.set(pageNum, i)
			}
		}

		return pages
	}
}

// Field locks a signature declares: FieldMDP in /Reference, and its field's /Lock.
export function locksOf(signature: SignatureField): PdfFieldLock[] {
	const locks: PdfFieldLock[] = []
	const add = (params: PDFObject): void => {
		const action = name(ref(params, "Action"))

		if (action !== "All" && action !== "Include" && action !== "Exclude") return

		const fields: string[] = []
		const list = at(params, "Fields")

		if (list.isArray()) {
			for (let i = 0; i < list.length; i++) {
				const value = text(ref(list, i))

				if (value !== null) fields.push(value)
			}
		}

		locks.push({ action, fields })
	}
	const references = at(signature.value, "Reference")

	if (references.isArray()) {
		for (let i = 0; i < references.length; i++) {
			const reference = at(references, i)

			if (name(ref(reference, "TransformMethod")) === "FieldMDP") add(at(reference, "TransformParams"))
		}
	}

	const lock = at(signature.dict, "Lock")

	if (lock.isDictionary()) add(lock)

	return locks
}

// The DocMDP level of the document's certifying signature: only the catalog's /Perms /DocMDP names it, and only the
// first signature may certify.
export function certificationOf(document: PDFDocument, first: SignatureField | undefined): PdfCertificationLevel | null {
	if (first === undefined) return null

	const certifying = num(ref(document.getTrailer(), "Root", "Perms", "DocMDP"))

	if (certifying === null || certifying !== first.valueNum) return null

	const references = at(first.value, "Reference")

	if (!references.isArray()) return null

	for (let i = 0; i < references.length; i++) {
		const reference = at(references, i)

		if (name(ref(reference, "TransformMethod")) === "DocMDP") {
			const p = at(reference, "TransformParams", "P")

			return certificationLevel(p.isNumber() ? p.asNumber() : null)
		}
	}

	return null
}

// Where a signature's signed bytes end, or null when its ByteRange cannot be read.
export function signatureEnd(signature: SignatureField): number | null {
	const range = numberArray(ref(signature.value, "ByteRange"))

	return range?.length === 4 ? signedEnd([range[0] ?? 0, range[1] ?? 0, range[2] ?? 0, range[3] ?? 0]) : null
}

// Signatures by where their signed bytes end (an unreadable ByteRange sorts last, past a file of `length` bytes).
export function signedOrder(fields: readonly SignatureField[], length: number): SignatureField[] {
	const ends = new Map(fields.map(field => [field, signatureEnd(field) ?? length + 1]))

	return [...fields].sort((a, b) => (ends.get(a) ?? 0) - (ends.get(b) ?? 0))
}

// The certification (DocMDP) as the first signature signed it: read from the catalog and signature dictionary of the
// revision it signed, never from a later revision's, which anyone can write. `openRevision` opens the byte prefix
// [0, length) of the file as its own document (destroyed here). Throws when that revision cannot be opened or read.
export function signedCertification(
	document: PDFDocument,
	first: SignatureField | undefined,
	length: number,
	openRevision: (length: number) => PDFDocument
): PdfCertificationLevel | null {
	if (first === undefined) return null

	const end = signatureEnd(first)

	// No earlier revision to read: the signature covers the whole file (or no file at all).
	if (end === null || end >= length) return certificationOf(document, first)

	const revision = openRevision(end)

	try {
		const value = first.valueNum === null ? first.value : deref(revision.newIndirect(first.valueNum))

		return certificationOf(revision, { ...first, value })
	} finally {
		revision.destroy()
	}
}

export function fieldType(dict: PDFObject): string | null {
	let current = dict

	for (let depth = 0; depth < MAX_FIELD_DEPTH && current.isDictionary(); depth++) {
		const type = name(ref(current, "FT"))

		if (type !== null) return type

		current = at(current, "Parent")
	}

	return null
}

// The signed signature fields (a /Sig field with a value dictionary), in field order.
// The signatures as hints (pdf.js's shape): each signed field's own name and byte range, for a file of `length`
// bytes. Fields whose range or contents could not have been signed are left out, as pdf.js leaves them out.
export function signatureFieldHints(fields: readonly SignatureField[], length: number): PdfSignatureFieldHint[] {
	const hints: PdfSignatureFieldHint[] = []

	for (const field of fields) {
		const range = numberArray(ref(field.value, "ByteRange"))
		const contents = deref(ref(field.value, "Contents"))

		if (range?.length !== 4 || range.some(value => !Number.isSafeInteger(value) || value < 0)) continue

		const [a = 0, b = 0, c = 0, d = 0] = range

		if (a !== 0 || b <= 0 || a + b > c || c + d > length || !contents.isString() || contents.asByteString().length === 0) continue

		hints.push({ name: field.partialName, byteRange: [a, b, c, d] })
	}

	return hints
}

export function signatureFieldsOf(document: PDFDocument, fields: readonly FieldRecord[]): SignatureField[] {
	const pages = lazyPages(document)
	const signatures: SignatureField[] = []

	for (const field of fields) {
		if (field.type !== "Sig") continue

		const valueRef = ref(field.dict, "V")
		const value = deref(valueRef)

		if (!value.isDictionary()) continue

		signatures.push({
			...field,
			value,
			valueNum: num(valueRef),
			page: pageIndexOf(field.widget, pages),
			rect: field.widget === null ? null : rectOf(field.widget)
		})
	}

	return signatures
}
