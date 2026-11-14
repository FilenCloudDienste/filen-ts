import type { PDFDocument, PDFObject } from "mupdf"
import {
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
import {
	at,
	collectFields,
	deref,
	fieldType,
	locksOf,
	name,
	num,
	numberArray,
	ref,
	signatureEnd,
	signatureFieldHints,
	signatureFieldsOf,
	signedCertification,
	signedOrder,
	text,
	type SignatureField
} from "./fields"
import type { PdfSignatureFieldHint } from "../pdf/signatureFields"

export type { PdfSignatureFieldHint }

// Verifies every signature of an open MuPDF document. Signature dictionaries are read from the final revision through
// MuPDF's object access (the same parser that edits the file); their integrity, location and CMS signatures are
// checked on the raw bytes, which stream through digests and are never held whole. Changes after a signature are
// judged object by object: each object a later revision wrote, compared with the signed revision's copy of it, by the
// role the signed revision gave it (a later revision can make any object look like anything).

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

const MAX_CHANGED_OBJECTS = 100_000
const TRAILING_CHECK_BYTES = 64 * 1024
const FORM_KEYS = new Set(["V", "AS", "AP", "M"])
const ACROFORM_FORM_KEYS = new Set(["NeedAppearances", "DR", "DA"])
// How often a walk over every object of a revision looks at the abort signal.
const ABORT_CHECK_OBJECTS = 4096

// pdf.js lists the signatures whose /ByteRange it finds well-formed and whose /Contents is a non-empty string; the
// same signatures, by field name and byte range, must be MuPDF's (signatureFieldHints).
function sameSignatures(found: readonly SignatureField[], expected: readonly PdfSignatureFieldHint[], length: number): boolean {
	const key = (hint: PdfSignatureFieldHint): string => JSON.stringify([hint.name, hint.byteRange])
	const mine = signatureFieldHints(found, length).map(key)
	const theirs = expected.map(key)

	return mine.length === theirs.length && mine.sort().join() === theirs.sort().join()
}

interface Appearance {
	readonly role: "widget" | "annotation"
	// The field a widget's appearance shows.
	readonly field: string | undefined
}

// What the signed revision made its objects, the roles a later change is judged by.
interface SignedRoles {
	readonly pages: ReadonlySet<number>
	// Indirect /Annots arrays of its pages.
	readonly annotsArrays: ReadonlySet<number>
	// Entries of its pages' /Annots that are not widgets, and those that are.
	readonly annotations: ReadonlySet<number>
	readonly widgets: ReadonlySet<number>
	// The appearance streams (and appearance subdictionaries) of those entries.
	readonly appearances: ReadonlyMap<number, Appearance>
	// Its form fields and their widgets, by fully qualified name.
	readonly fieldNames: ReadonlyMap<number, string>
	// Every object its document reaches other than through a page's /Annots, the form or the structure tree's object
	// references: what pages draw, the page tree, the catalog's own. None of these is an annotation, whatever else
	// lists it. Walked once, when a change to an annotation or an appearance asks.
	readonly rendered: () => ReadonlySet<number>
}

interface ChangeContext {
	readonly document: PDFDocument
	readonly revision: PDFDocument
	readonly roles: SignedRoles
	readonly rootNum: number | null
	readonly acroFormNum: number | null
	// New objects (absent from the signed revision) that a signed object already refers to: adding one changes what
	// the signed revision shows.
	readonly shadowed: boolean
}

function isWidget(dict: PDFObject): boolean {
	return name(ref(dict, "Subtype")) === "Widget"
}

function signedRoles(revision: PDFDocument, signal: VerifyPdfSignaturesOptions["signal"]): SignedRoles {
	const { names } = collectFields(revision)
	const pages = new Set<number>()
	const annotsArrays = new Set<number>()
	const annotations = new Set<number>()
	const widgets = new Set<number>()
	const appearances = new Map<number, Appearance>()
	const count = revision.countPages()

	for (let i = 0; i < count; i++) {
		const page = revision.findPage(i)
		const pageNum = num(page)

		if (pageNum !== null) pages.add(pageNum)

		const annotsRef = ref(page, "Annots")
		const annotsNum = num(annotsRef)
		const annots = deref(annotsRef)

		if (annotsNum !== null) annotsArrays.add(annotsNum)
		if (!annots.isArray()) continue

		for (let a = 0; a < annots.length; a++) {
			const entry = ref(annots, a)
			const entryNum = num(entry)
			const dict = deref(entry)
			const widget = isWidget(dict)

			if (entryNum !== null) (widget ? widgets : annotations).add(entryNum)

			const appearance: Appearance = {
				role: widget ? "widget" : "annotation",
				field: entryNum === null ? undefined : names.get(entryNum)
			}
			const add = (value: PDFObject): void => {
				const valueNum = num(value)

				if (valueNum !== null) appearances.set(valueNum, appearance)
			}
			const ap = at(dict, "AP")

			if (!ap.isDictionary()) continue

			ap.forEach(state => {
				add(state)

				const states = deref(state)

				// A subdictionary of appearance states (by /AS), direct or its own object.
				if (states.isDictionary() && !states.isStream()) states.forEach(add)
			})
		}
	}

	let rendered: Set<number> | null = null

	return {
		pages,
		annotsArrays,
		annotations,
		widgets,
		appearances,
		fieldNames: names,
		rendered: () => (rendered ??= renderedObjects(revision, pages, signal))
	}
}

// Objects a document reaches from its catalog and trailer, past every key but a page's /Annots and the catalog's
// /AcroForm (what pages draw, the page tree, outlines, optional content, names, …), then the structure tree's, past
// every key but an object reference's /Obj (structure elements name the annotations they tag). The first walk runs
// whole before the second, so a key the second skips never hides what the first reaches.
function renderedObjects(revision: PDFDocument, pages: ReadonlySet<number>, signal: VerifyPdfSignaturesOptions["signal"]): Set<number> {
	const seen = new Set<number>()
	const trailer = revision.getTrailer()
	const root = ref(trailer, "Root")
	const rootNum = num(root)
	let steps = 0

	const walk = (start: readonly PDFObject[], structure: boolean): void => {
		const stack = [...start]

		for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
			if (++steps % ABORT_CHECK_OBJECTS === 0 && signal?.aborted === true) throw new Error("aborted")

			const itemNum = num(item)

			if (itemNum !== null) {
				if (seen.has(itemNum)) continue

				seen.add(itemNum)

				// The structure tree names pages; what they draw is the first walk's.
				if (structure && pages.has(itemNum)) continue
			}

			const value = deref(item)
			const page = itemNum !== null && pages.has(itemNum)

			if (value.isDictionary()) {
				value.forEach((child, key) => {
					if ((page && key === "Annots") || (structure && key === "Obj")) return
					if (child.isIndirect() || child.isDictionary() || child.isArray()) stack.push(child)
				})
			} else if (value.isArray()) {
				value.forEach(child => {
					if (child.isIndirect() || child.isDictionary() || child.isArray()) stack.push(child)
				})
			}
		}
	}

	const catalog = deref(root)
	const start: PDFObject[] = [ref(trailer, "Info")]
	const structure: PDFObject[] = []

	if (rootNum !== null) seen.add(rootNum)

	catalog.forEach((child, key) => {
		if (key === "AcroForm") return
		if (key === "StructTreeRoot") structure.push(child)
		else start.push(child)
	})

	walk(start, false)

	walk(structure, true)

	return seen
}

// Whether any object of the signed revision (or its trailer) refers to one of `wanted`: object numbers it does not
// define, so the reference reads as null at signing and as whatever a later revision adds there after. References
// are read from each object's serialization; a string that merely looks like one only errs towards "changed".
function referencesAny(revision: PDFDocument, wanted: ReadonlySet<number>, signal: VerifyPdfSignaturesOptions["signal"]): boolean {
	if (wanted.size === 0) return false

	const refers = (serialized: string): boolean => {
		for (const match of serialized.matchAll(/(\d+) \d+ R/g)) if (wanted.has(Number(match[1]))) return true

		return false
	}

	if (refers(revision.getTrailer().toString(true))) return true

	const count = revision.countObjects()

	for (let objectNum = 1; objectNum < count; objectNum++) {
		if (objectNum % ABORT_CHECK_OBJECTS === 0 && signal?.aborted === true) throw new Error("aborted")

		let serialized: string

		try {
			serialized = revision.newIndirect(objectNum).resolve().toString(true)
		} catch {
			return true
		}

		if (refers(serialized)) return true
	}

	return false
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

// An array's indirect entries, and its direct ones by serialization (each with how often it occurs).
function entries(array: PDFObject): { readonly indirect: Set<number>; readonly direct: Map<string, PDFObject[]> } {
	const indirect = new Set<number>()
	const direct = new Map<string, PDFObject[]>()
	const resolved = deref(array)

	if (resolved.isArray()) {
		for (let i = 0; i < resolved.length; i++) {
			const item = ref(resolved, i)
			const itemNum = num(item)

			if (itemNum !== null) indirect.add(itemNum)
			else {
				const key = item.toString(true)
				const same = direct.get(key)

				if (same === undefined) direct.set(key, [item])
				else same.push(item)
			}
		}
	}

	return { indirect, direct }
}

function existedAtSigning(objectNum: number, context: ChangeContext): boolean {
	return !deref(context.revision.newIndirect(objectNum)).isNull()
}

// Annotations added to or removed from an /Annots array. An added entry is an annotation when it is a new object (or
// a direct dictionary) that is no widget, or one of the signed revision's annotations moved; a new signature widget is
// signing, any other widget a new field; anything else the signed revision had is content.
function annotsChanges(before: PDFObject, after: PDFObject, context: ChangeContext): PdfChange[] {
	const old = entries(before)
	const current = entries(after)
	const changes: PdfChange[] = []
	const added = (dict: PDFObject): PdfChange => ({
		kind: isWidget(dict) ? (fieldType(dict) === "Sig" ? "signature" : "content") : "annotation"
	})

	for (const item of current.indirect) {
		if (old.indirect.has(item)) continue

		if (existedAtSigning(item, context)) changes.push({ kind: context.roles.annotations.has(item) ? "annotation" : "content" })
		else changes.push(added(deref(context.document.newIndirect(item))))
	}

	for (const item of old.indirect) {
		if (current.indirect.has(item)) continue

		changes.push({ kind: isWidget(deref(context.revision.newIndirect(item))) ? "content" : "annotation" })
	}

	for (const [key, items] of current.direct) {
		const kept = old.direct.get(key)?.length ?? 0

		for (const item of items.slice(kept)) changes.push(added(item))
	}

	for (const [key, items] of old.direct) {
		const kept = current.direct.get(key)?.length ?? 0

		for (const item of items.slice(kept)) changes.push({ kind: isWidget(item) ? "content" : "annotation" })
	}

	return changes
}

function fieldsChanges(before: PDFObject, after: PDFObject, context: ChangeContext): PdfChange[] {
	const old = entries(before).indirect
	const current = entries(after).indirect
	const changes: PdfChange[] = []

	for (const item of current) {
		if (old.has(item)) continue

		// Only a new signature field is signing; a field from the signed revision listed anew is not.
		const signature = !existedAtSigning(item, context) && fieldType(deref(context.document.newIndirect(item))) === "Sig"

		changes.push({ kind: signature ? "signature" : "content" })
	}

	if ([...old].some(item => !current.has(item))) changes.push({ kind: "content" })

	return changes
}

function formChange(field: string | undefined): PdfChange {
	return field === undefined ? { kind: "form" } : { kind: "form", field }
}

// The change to an object the signed revision made an annotation or an appearance, and that nothing draws as page
// content; null for any other object.
function annotationChange(objectNum: number, context: ChangeContext): PdfChange | null {
	const { roles } = context
	const appearance = roles.appearances.get(objectNum)
	const annotation = roles.annotations.has(objectNum)

	if (!annotation && appearance === undefined) return null
	if (roles.rendered().has(objectNum)) return null
	if (annotation || appearance?.role !== "widget") return { kind: "annotation" }

	return formChange(appearance.field)
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

	const { roles } = context

	if (roles.pages.has(objectNum)) {
		return [...keys].flatMap((key): PdfChange[] =>
			key === "Annots" ? annotsChanges(ref(before, "Annots"), ref(after, "Annots"), context) : [{ kind: "content" }]
		)
	}

	const field = roles.fieldNames.get(objectNum)

	// A field's value and appearance keys only: on any other object they draw nothing.
	if (field !== undefined || roles.widgets.has(objectNum)) {
		if ([...keys].some(key => !FORM_KEYS.has(key))) return [{ kind: "content" }]

		if (fieldType(after) === "Sig") {
			// Signing an empty signature field; replacing an existing signature value is not.
			return ref(before, "V").isNull() ? [{ kind: "signature" }] : [{ kind: "content" }]
		}

		return [formChange(field)]
	}

	return [annotationChange(objectNum, context) ?? { kind: "content" }]
}

function classifyObject(objectNum: number, context: ChangeContext): PdfChange[] {
	const before = deref(context.revision.newIndirect(objectNum))
	const after = deref(context.document.newIndirect(objectNum))

	// A new object matters once something references it, which is a change to that object, or when the signed
	// revision already referred to it.
	if (before.isNull()) return context.shadowed ? [{ kind: "content" }] : []
	if (after.isNull()) return [annotationChange(objectNum, context) ?? { kind: "content" }]

	if (after.isStream() || before.isStream()) {
		if (!after.isStream() || !before.isStream()) return [{ kind: "content" }]

		const sameData = equal(after.readRawStream().asUint8Array(), before.readRawStream().asUint8Array())

		if (sameData && changedKeys(before, after).size === 0) return []

		return [annotationChange(objectNum, context) ?? { kind: "content" }]
	}

	if (after.isArray() && before.isArray()) {
		if (after.toString(true) === before.toString(true)) return []

		// An indirect /Annots array of a signed page; any other array is content.
		return context.roles.annotsArrays.has(objectNum) ? annotsChanges(before, after, context) : [{ kind: "content" }]
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

// What a trailer points the document at: its catalog, its encryption and its information. A later revision pointing
// any of them elsewhere (a new catalog and page tree in fresh objects, say) changes the document whole, whatever its
// other objects say.
const TRAILER_KEYS = ["Root", "Encrypt", "Info"] as const

function trailerEntry(trailer: PDFObject, key: string): string {
	const value = ref(trailer, key)
	const objectNum = num(value)

	return objectNum === null ? value.toString(true) : `${String(objectNum)} R`
}

function trailerChanged(revision: PDFDocument, document: PDFDocument): boolean {
	const before = revision.getTrailer()
	const after = document.getTrailer()

	return TRAILER_KEYS.some(key => trailerEntry(before, key) !== trailerEntry(after, key))
}

// The certification of the first signature, null when its revision cannot be read (its changes then cannot be read
// either, and count as content).
function documentCertification(
	document: PDFDocument,
	first: SignatureField | undefined,
	length: number,
	options: VerifyPdfSignaturesOptions
): PdfCertificationLevel | null {
	try {
		return signedCertification(document, first, length, options.openRevision)
	} catch {
		return null
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
	const { fields } = collectFields(document)
	const signatureFields = signatureFieldsOf(document, fields)

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
	const certification = documentCertification(document, ordered[0], source.length, options)
	const history = document.validateChangeHistory()
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
				acroFormNum: num(ref(root, "AcroForm"))
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

interface VerifyContext {
	readonly options: VerifyPdfSignaturesOptions
	readonly certification: PdfCertificationLevel | null
	readonly documentCertification: PdfCertificationLevel | null
	readonly locks: readonly PdfFieldLock[]
	readonly history: number
	readonly rootNum: number | null
	readonly acroFormNum: number | null
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
	const end = signatureEnd(field)

	if (nums === null || end === null) return { allowed: false, kinds: ["content"] }

	const { signal } = context.options
	const revision = context.options.openRevision(end)
	const changes: PdfChange[] = []
	// Each changed object's changes, to tell which later revision changed what.
	const byObject = new Map<number, readonly PdfChange[]>()

	try {
		const added = new Set([...nums].filter(objectNum => deref(revision.newIndirect(objectNum)).isNull()))
		const changeContext: ChangeContext = {
			document,
			revision,
			roles: signedRoles(revision, signal),
			rootNum: context.rootNum,
			acroFormNum: context.acroFormNum,
			shadowed: referencesAny(revision, added, signal)
		}

		// A new catalog, encryption or information: new objects then matter whether or not a changed object refers to
		// them.
		if (trailerChanged(revision, document)) changes.push({ kind: "content" })

		for (const objectNum of nums) {
			if (signal?.aborted === true) throw new Error("aborted")

			const found = classifyObjectSafely(objectNum, changeContext)

			byObject.set(objectNum, found)
			changes.push(...found)
		}
	} finally {
		revision.destroy()
	}

	const kinds = kindsOf(changes)
	let allowed = changes.every(change => changeAllowed(change, context.documentCertification, context.locks))

	// MuPDF's own check of the locks (FieldMDP, DocMDP) as a second opinion: it names the first revision it rejects
	// (newest first, 1-based). It rejects every annotation change, even where the certification allows them, so it
	// overrules only a revision that changed no annotation.
	const rejected = context.history > 0 ? later[context.history - 1] : undefined

	if (allowed && rejected !== undefined) {
		const annotated = [...rejected.entries.keys()].some(objectNum =>
			byObject.get(objectNum)?.some(change => change.kind === "annotation")
		)

		if (!annotated) allowed = false
	}

	return { allowed, kinds }
}
