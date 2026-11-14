import type { PDFDocument, PDFObject } from "mupdf"
import {
	certificationLevel,
	changeAllowed,
	checkContents,
	checkIntegrity,
	onlyWhitespace,
	readExactly,
	readXrefChain,
	signatureKind,
	signedEnd,
	type PdfByteSource,
	type PdfCertificationLevel,
	type PdfChange,
	type PdfChangeKind,
	type PdfCryptoDeps,
	type PdfFieldLock,
	type PdfSignatureInfo,
	type PdfSignatureReport,
	type XrefChain,
	type XrefSection
} from "../../core/pdfsign"
import { parsePdfDate } from "../pdf/outline"
import type { PdfSignatureFieldHint } from "../pdf/signatureFields"

export type { PdfSignatureFieldHint }

// Verifies every signature of an open MuPDF document. Signature dictionaries are read from the final revision through
// MuPDF's object access (the same parser that edits the file); their integrity, location and CMS signatures are
// checked on the raw bytes, which stream through digests and are never held whole. Changes after a signature are
// judged object by object: each object a later revision wrote, compared with the signed revision's copy of it.

export interface VerifyPdfSignaturesOptions extends PdfCryptoDeps {
	// Opens the byte prefix [0, length) as its own read-only document: the revision a signature signed. Called only for
	// signatures with later revisions; the document is destroyed after use.
	readonly openRevision: (length: number) => PDFDocument
	// The signatures a second parser (pdf.js) found; when given and they differ from MuPDF's, nothing is trusted. Null:
	// that parser could not say, so nothing is trusted either.
	readonly expectedFields?: readonly PdfSignatureFieldHint[] | null
	readonly signal?: { readonly aborted: boolean }
	readonly now?: number
}

interface FieldRecord {
	readonly name: string
	readonly partialName: string
	readonly type: string | null
	readonly dict: PDFObject
	readonly num: number | null
	readonly widget: PDFObject | null
}

interface SignatureField extends FieldRecord {
	readonly value: PDFObject
	readonly valueNum: number | null
	readonly page: number | null
	readonly rect: readonly [number, number, number, number] | null
}

const MAX_FIELD_DEPTH = 32
const MAX_FIELDS = 100_000
const MAX_CHANGED_OBJECTS = 100_000
const TRAILING_CHECK_BYTES = 64 * 1024
const FORM_KEYS = new Set(["V", "AS", "AP", "M"])
const ACROFORM_FORM_KEYS = new Set(["NeedAppearances", "DR", "DA"])

// MuPDF's null object has no document: every read of a missing value goes through these, which pass it on.
function deref(object: PDFObject): PDFObject {
	return object.isNull() ? object : object.resolve()
}

// The value at a key or index path, unresolved (to read its object number) or resolved.
function ref(object: PDFObject, ...path: (string | number)[]): PDFObject {
	return object.isNull() ? object : object.get(...path)
}

function at(object: PDFObject, ...path: (string | number)[]): PDFObject {
	return deref(ref(object, ...path))
}

function name(object: PDFObject): string | null {
	const resolved = deref(object)

	return resolved.isName() ? resolved.asName() : null
}

function text(object: PDFObject): string | null {
	const resolved = deref(object)

	return resolved.isString() ? resolved.asString() : null
}

function num(object: PDFObject): number | null {
	return object.isIndirect() ? object.asIndirect() : null
}

function numberArray(object: PDFObject): number[] | null {
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

function rectOf(object: PDFObject): [number, number, number, number] | null {
	const values = numberArray(ref(object, "Rect"))

	if (values?.length !== 4) return null

	const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = values

	return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
}

// Every field of the AcroForm tree by fully qualified name, with its type (inherited) and its first widget.
function collectFields(document: PDFDocument): { readonly fields: FieldRecord[]; readonly names: Map<number, string> } {
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

function pageIndexOf(widget: PDFObject | null, pages: () => Map<number, number>): number | null {
	if (widget === null) return null

	const pageNum = num(ref(widget, "P"))

	return pageNum === null ? null : (pages().get(pageNum) ?? null)
}

function lazyPages(document: PDFDocument): () => Map<number, number> {
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

// pdf.js lists the signatures whose /ByteRange it finds well-formed and whose /Contents is a non-empty string; the
// same signatures, by field name and byte range, must be MuPDF's.
function sameSignatures(found: readonly SignatureField[], expected: readonly PdfSignatureFieldHint[], length: number): boolean {
	const key = (name: string, range: readonly number[]): string => JSON.stringify([name, range])
	const mine: string[] = []

	for (const field of found) {
		const range = numberArray(ref(field.value, "ByteRange"))
		const contents = deref(ref(field.value, "Contents"))

		if (range?.length !== 4 || range.some(value => !Number.isSafeInteger(value) || value < 0)) continue

		const [a = 0, b = 0, c = 0, d = 0] = range

		if (a !== 0 || b <= 0 || a + b > c || c + d > length || !contents.isString() || contents.asByteString().length === 0) continue

		mine.push(key(field.partialName, range))
	}

	const theirs = expected.map(hint => key(hint.name, hint.byteRange))

	return mine.length === theirs.length && mine.sort().join() === theirs.sort().join()
}

// Field locks a signature declares: FieldMDP in /Reference, and its field's /Lock.
function locksOf(signature: SignatureField): PdfFieldLock[] {
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
function certificationOf(document: PDFDocument, first: SignatureField | undefined): PdfCertificationLevel | null {
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

interface ChangeContext {
	readonly document: PDFDocument
	readonly revision: PDFDocument
	readonly rootNum: number | null
	readonly acroFormNum: number | null
	readonly fieldNames: ReadonlyMap<number, string>
	readonly appearances: () => Map<number, "widget" | "annotation">
}

function isWidget(dict: PDFObject): boolean {
	return name(ref(dict, "Subtype")) === "Widget"
}

function isAnnotation(dict: PDFObject): boolean {
	return (
		dict.isDictionary() &&
		(name(ref(dict, "Type")) === "Annot" || (!ref(dict, "Subtype").isNull() && !ref(dict, "Rect").isNull())) &&
		!isWidget(dict)
	)
}

function isField(dict: PDFObject): boolean {
	return (
		dict.isDictionary() && (isWidget(dict) || !ref(dict, "FT").isNull() || (!ref(dict, "T").isNull() && !ref(dict, "Parent").isNull()))
	)
}

function fieldType(dict: PDFObject): string | null {
	let current = dict

	for (let depth = 0; depth < MAX_FIELD_DEPTH && current.isDictionary(); depth++) {
		const type = name(ref(current, "FT"))

		if (type !== null) return type

		current = at(current, "Parent")
	}

	return null
}

function changedKeys(before: PDFObject, after: PDFObject): Set<string> {
	const keys = new Set<string>()
	const values = new Map<string, string>()

	before.forEach((value, key) => {
		values.set(String(key), value.toString(true))
	})
	after.forEach((value, key) => {
		const k = String(key)

		if (values.get(k) !== value.toString(true)) keys.add(k)

		values.delete(k)
	})

	for (const key of values.keys()) keys.add(key)

	return keys
}

function refs(array: PDFObject): Set<number> {
	const out = new Set<number>()
	const resolved = deref(array)

	if (resolved.isArray()) {
		for (let i = 0; i < resolved.length; i++) {
			const item = num(ref(resolved, i))

			if (item !== null) out.add(item)
		}
	}

	return out
}

// Annotations added to or removed from an /Annots array: signature widgets are signing, other widgets new fields,
// the rest annotations.
function annotsChanges(before: PDFObject, after: PDFObject, context: ChangeContext): PdfChange[] {
	const old = refs(before)
	const current = refs(after)
	const changes: PdfChange[] = []

	for (const item of current) {
		if (old.has(item)) continue

		const dict = deref(context.document.newIndirect(item))

		changes.push({ kind: isWidget(dict) ? (fieldType(dict) === "Sig" ? "signature" : "content") : "annotation" })
	}

	for (const item of old) {
		if (current.has(item)) continue

		const dict = deref(context.revision.newIndirect(item))

		changes.push({ kind: isWidget(dict) ? "content" : "annotation" })
	}

	return changes
}

function fieldsChanges(before: PDFObject, after: PDFObject, context: ChangeContext): PdfChange[] {
	const old = refs(before)
	const changes: PdfChange[] = []

	for (const item of refs(after)) {
		if (!old.has(item)) changes.push({ kind: fieldType(deref(context.document.newIndirect(item))) === "Sig" ? "signature" : "content" })
	}

	const current = refs(after)

	if ([...old].some(item => !current.has(item))) changes.push({ kind: "content" })

	return changes
}

function dictChanges(objectNum: number, before: PDFObject, after: PDFObject, context: ChangeContext): PdfChange[] {
	const keys = changedKeys(before, after)

	if (keys.size === 0) return []

	if (objectNum === context.rootNum) return [...keys].map(key => ({ kind: key === "DSS" ? "dss" : "content" }))

	if (objectNum === context.acroFormNum) {
		return [...keys].flatMap((key): PdfChange[] => {
			if (key === "Fields") return fieldsChanges(ref(before, "Fields"), ref(after, "Fields"), context)
			if (key === "SigFlags") return [{ kind: "signature" }]

			return [{ kind: ACROFORM_FORM_KEYS.has(key) ? "form" : "content" }]
		})
	}

	if (name(ref(after, "Type")) === "Page" || name(ref(before, "Type")) === "Page") {
		return [...keys].flatMap((key): PdfChange[] =>
			key === "Annots" ? annotsChanges(ref(before, "Annots"), ref(after, "Annots"), context) : [{ kind: "content" }]
		)
	}

	if (isField(after) || isField(before)) {
		const field = context.fieldNames.get(objectNum)

		if ([...keys].some(key => !FORM_KEYS.has(key))) return [{ kind: "content" }]

		if (fieldType(after) === "Sig") {
			// Signing an empty signature field; replacing an existing signature value is not.
			return ref(before, "V").isNull() ? [{ kind: "signature" }] : [{ kind: "content" }]
		}

		return [field === undefined ? { kind: "form" } : { kind: "form", field }]
	}

	if (isAnnotation(after) || isAnnotation(before)) return [{ kind: "annotation" }]

	return [{ kind: "content" }]
}

function classifyObject(objectNum: number, context: ChangeContext): PdfChange[] {
	const before = deref(context.revision.newIndirect(objectNum))
	const after = deref(context.document.newIndirect(objectNum))

	// A new object matters only once something references it, which is a change to that object.
	if (before.isNull()) return []
	if (after.isNull()) return [{ kind: isAnnotation(before) ? "annotation" : "content" }]

	if (after.isStream() || before.isStream()) {
		if (!after.isStream() || !before.isStream()) return [{ kind: "content" }]

		const sameData = equal(after.readRawStream().asUint8Array(), before.readRawStream().asUint8Array())

		if (sameData && changedKeys(before, after).size === 0) return []

		const role = context.appearances().get(objectNum)
		const field = context.fieldNames.get(objectNum)

		if (role === "widget") return [field === undefined ? { kind: "form" } : { kind: "form", field }]
		if (role === "annotation") return [{ kind: "annotation" }]

		return [{ kind: "content" }]
	}

	if (after.isArray() && before.isArray()) {
		if (after.toString(true) === before.toString(true)) return []

		// An indirect /Annots array of a page.
		return annotsChanges(before, after, context)
	}

	if (after.isDictionary() && before.isDictionary()) return dictChanges(objectNum, before, after, context)

	return after.toString(true) === before.toString(true) ? [] : [{ kind: "content" }]
}

// An object MuPDF cannot load in one of the two revisions is a change nothing allows.
function classifyObjectSafely(objectNum: number, context: ChangeContext): PdfChange[] {
	try {
		return classifyObject(objectNum, context)
	} catch {
		return [{ kind: "content" }]
	}
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false

	return true
}

// Appearance streams of every annotation of the final document, by object number.
function lazyAppearances(document: PDFDocument, fieldNames: Map<number, string>): () => Map<number, "widget" | "annotation"> {
	let map: Map<number, "widget" | "annotation"> | null = null

	return () => {
		if (map !== null) return map

		const found = new Map<number, "widget" | "annotation">()
		const count = document.countPages()

		for (let i = 0; i < count; i++) {
			const annots = at(document.findPage(i), "Annots")

			if (!annots.isArray()) continue

			for (let a = 0; a < annots.length; a++) {
				const annot = at(annots, a)
				const role = isWidget(annot) ? "widget" : "annotation"
				const annotName = fieldNames.get(num(ref(annots, a)) ?? -1)
				const ap = at(annot, "AP")

				if (!ap.isDictionary()) continue

				ap.forEach(entry => {
					const add = (stream: PDFObject): void => {
						const streamNum = num(stream)

						if (streamNum === null) return

						found.set(streamNum, role)

						if (annotName !== undefined) fieldNames.set(streamNum, annotName)
					}

					if (entry.isIndirect()) add(entry)
					else if (entry.isDictionary()) entry.forEach(add)
				})
			}
		}

		map = found

		return found
	}
}

function changedObjects(later: readonly XrefSection[]): Set<number> | null {
	const nums = new Set<number>()

	for (const section of later) {
		for (const objectNum of section.entries.keys()) {
			// Entry 0 heads every section's free list.
			if (objectNum !== 0) nums.add(objectNum)
		}

		if (nums.size > MAX_CHANGED_OBJECTS) return null
	}

	return nums
}

function kindsOf(changes: readonly PdfChange[]): PdfChangeKind[] {
	return [...new Set(changes.map(change => change.kind))]
}

async function trailingContent(source: PdfByteSource, end: number): Promise<boolean> {
	if (end >= source.length) return false
	if (source.length - end > TRAILING_CHECK_BYTES) return true

	return !onlyWhitespace(await readExactly(source, end, source.length - end))
}

function blankInfo(field: SignatureField, overrides: Partial<PdfSignatureInfo>): PdfSignatureInfo {
	return {
		field: field.name,
		page: field.page,
		rect: field.rect,
		kind: "signature",
		subFilter: name(ref(field.value, "SubFilter")) ?? "",
		state: "unverifiable",
		invalidReason: null,
		unverifiableReason: null,
		changes: null,
		signedLength: 0,
		revision: 0,
		signer: null,
		chain: [],
		name: text(ref(field.value, "Name")),
		reason: text(ref(field.value, "Reason")),
		location: text(ref(field.value, "Location")),
		contactInfo: text(ref(field.value, "ContactInfo")),
		claimedTime: null,
		timestampTime: null,
		certification: null,
		digest: null,
		algorithm: null,
		expiredAtClaimedTime: false,
		notYetValidAtClaimedTime: false,
		...overrides
	}
}

export async function verifyPdfSignatures(
	document: PDFDocument,
	source: PdfByteSource,
	options: VerifyPdfSignaturesOptions
): Promise<PdfSignatureReport> {
	const { fields, names } = collectFields(document)
	const pages = lazyPages(document)
	const signatureFields: SignatureField[] = []

	for (const field of fields) {
		if (field.type !== "Sig") continue

		const valueRef = ref(field.dict, "V")
		const value = deref(valueRef)

		if (!value.isDictionary()) continue

		signatureFields.push({
			...field,
			value,
			valueNum: num(valueRef),
			page: pageIndexOf(field.widget, pages),
			rect: field.widget === null ? null : rectOf(field.widget)
		})
	}

	const root = ref(document.getTrailer(), "Root")
	const dss = !ref(root, "DSS").isNull()

	if (signatureFields.length === 0) return { signatures: [], revisions: document.countVersions(), dss }

	const unverifiable = (reason: PdfSignatureInfo["unverifiableReason"], revisions: number): PdfSignatureReport => ({
		signatures: signatureFields.map(field => blankInfo(field, { unverifiableReason: reason })),
		revisions,
		dss
	})

	if (
		options.expectedFields === null ||
		(options.expectedFields !== undefined && !sameSignatures(signatureFields, options.expectedFields, source.length))
	) {
		return unverifiable("parserMismatch", document.countVersions())
	}

	if (document.wasRepaired()) return unverifiable("damaged", document.countVersions())

	let chain: XrefChain | null

	try {
		chain = await readXrefChain(source)
	} catch {
		return unverifiable("readFailed", document.countVersions())
	}

	if (chain === null) return unverifiable("damaged", document.countVersions())

	const xref = chain
	const ordered = signedOrder(signatureFields, source.length)
	const certification = certificationOf(document, ordered[0])
	const history = document.validateChangeHistory()
	const appearances = lazyAppearances(document, names)
	const locks: PdfFieldLock[] = []
	const results = new Map<SignatureField, PdfSignatureInfo>()

	for (const field of ordered) {
		locks.push(...locksOf(field))

		let info: PdfSignatureInfo

		try {
			info = await verifyOne(field, document, source, xref, {
				options,
				certification: field === ordered[0] ? certification : null,
				documentCertification: certification,
				locks: [...locks],
				history,
				rootNum: num(root),
				acroFormNum: num(ref(root, "AcroForm")),
				fieldNames: names,
				appearances
			})
		} catch {
			info = blankInfo(field, { unverifiableReason: "readFailed" })
		}

		results.set(field, info)
	}

	return {
		signatures: signatureFields.map(field => results.get(field) ?? blankInfo(field, { unverifiableReason: "readFailed" })),
		revisions: xref.sections.length,
		dss
	}
}

// Signatures by where their signed bytes end (an unreadable ByteRange sorts last).
function signedOrder(fields: readonly SignatureField[], length: number): SignatureField[] {
	const ends = new Map(
		fields.map(field => {
			const range = numberArray(ref(field.value, "ByteRange"))
			const end = range?.length === 4 ? signedEnd([range[0] ?? 0, range[1] ?? 0, range[2] ?? 0, range[3] ?? 0]) : length + 1

			return [field, end]
		})
	)

	return [...fields].sort((a, b) => (ends.get(a) ?? 0) - (ends.get(b) ?? 0))
}

interface VerifyContext {
	readonly options: VerifyPdfSignaturesOptions
	readonly certification: PdfCertificationLevel | null
	readonly documentCertification: PdfCertificationLevel | null
	readonly locks: readonly PdfFieldLock[]
	readonly history: number
	readonly rootNum: number | null
	readonly acroFormNum: number | null
	readonly fieldNames: Map<number, string>
	readonly appearances: () => Map<number, "widget" | "annotation">
}

async function verifyOne(
	field: SignatureField,
	document: PDFDocument,
	source: PdfByteSource,
	chain: XrefChain,
	context: VerifyContext
): Promise<PdfSignatureInfo> {
	const { options } = context
	const subFilter = name(ref(field.value, "SubFilter"))
	const kind = signatureKind(subFilter)
	const claimed = text(ref(field.value, "M"))
	const claimedTime = parsePdfDate(claimed)?.getTime() ?? null
	const base = { certification: context.certification, claimedTime }

	if (kind !== "signature" && kind !== "timestamp") return blankInfo(field, { ...base, state: "invalid", invalidReason: kind })

	const byteRange = numberArray(ref(field.value, "ByteRange")) ?? []
	const integrity = await checkIntegrity(source, chain, { byteRange, dictionaryNum: field.valueNum ?? field.num })

	if (!integrity.ok) return blankInfo(field, { ...base, kind, state: "invalid", invalidReason: integrity.reason })

	const end = signedEnd(integrity.range)
	const contents = await checkContents(source, integrity.range, integrity.der, kind, options, options.signal)
	const located = { ...base, kind, signedLength: end, revision: integrity.revision }

	if (contents.state === "invalid") {
		return blankInfo(field, {
			...located,
			state: "invalid",
			invalidReason: contents.reason,
			signer: contents.signer,
			digest: contents.digest
		})
	}

	if (contents.state === "unverifiable") {
		return blankInfo(field, { ...located, unverifiableReason: "algorithm", signer: contents.signer, digest: contents.digest })
	}

	const at = claimedTime ?? contents.signingTime ?? contents.timestampTime ?? options.now ?? Date.now()
	const signer = contents.signer
	const valid = {
		...located,
		claimedTime: claimedTime ?? contents.signingTime,
		timestampTime: contents.timestampTime,
		signer,
		chain: contents.chain,
		digest: contents.digest,
		algorithm: contents.algorithm,
		expiredAtClaimedTime: signer !== null && at > signer.notAfter,
		notYetValidAtClaimedTime: signer !== null && at < signer.notBefore
	}

	const later = integrity.later

	if (later.length === 0) {
		if (await trailingContent(source, end))
			return blankInfo(field, { ...valid, state: "changed", changes: { allowed: false, kinds: ["content"] } })

		return blankInfo(field, { ...valid, state: "unchanged" })
	}

	const changes = changesAfter(field, document, later, context)

	return blankInfo(field, { ...valid, state: "changed", changes })
}

function changesAfter(
	field: SignatureField,
	document: PDFDocument,
	later: readonly XrefSection[],
	context: VerifyContext
): { readonly allowed: boolean; readonly kinds: PdfChangeKind[] } {
	const nums = changedObjects(later)

	if (nums === null) return { allowed: false, kinds: ["content"] }

	const range = numberArray(ref(field.value, "ByteRange")) ?? []
	const end = signedEnd([range[0] ?? 0, range[1] ?? 0, range[2] ?? 0, range[3] ?? 0])
	const revision = context.options.openRevision(end)
	const changes: PdfChange[] = []

	try {
		const changeContext: ChangeContext = {
			document,
			revision,
			rootNum: context.rootNum,
			acroFormNum: context.acroFormNum,
			fieldNames: context.fieldNames,
			appearances: context.appearances
		}

		for (const objectNum of nums) {
			if (context.options.signal?.aborted === true) throw new Error("aborted")

			changes.push(...classifyObjectSafely(objectNum, changeContext))
		}
	} finally {
		revision.destroy()
	}

	const kinds = kindsOf(changes)
	let allowed = changes.every(change => changeAllowed(change, context.documentCertification, context.locks))

	// MuPDF's own lock check (FieldMDP, DocMDP) as a second opinion. It counts annotations as forbidden even where the
	// certification allows them, so it decides only when no annotation changed.
	if (context.history > 0 && context.history <= later.length && !kinds.includes("annotation")) allowed = false

	return { allowed, kinds }
}
