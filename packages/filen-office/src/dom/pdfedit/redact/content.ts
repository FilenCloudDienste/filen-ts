import type * as Mupdf from "mupdf"
import {
	parseContent,
	sectionEnd,
	spliceContent,
	writeOperation,
	type ContentEdit,
	type PdfOperand,
	type PdfOperation
} from "../../../core/pdfedit/contentStream"
import {
	concatMatrix,
	intersectRects,
	rectsOverlap,
	transformRect,
	type RedactMatrix,
	type RedactRect
} from "../../../core/pdfedit/redactVerify"

// Content-stream passes MuPDF's redaction does not do: shadings painted under an area mark, the text alternatives of
// marked content whose drawing a redaction changed, and (sanitize) content in hidden layers. Streams are rewritten by
// splicing (content.ts in core): what a pass does not change is copied byte for byte.

const MAX_FORM_DEPTH = 12
const PATH_PAINT = new Set(["n", "f", "F", "f*", "B", "B*", "b", "b*", "S", "s"])
const PATH_BUILD = new Set(["m", "l", "c", "v", "y", "h", "re"])
const TEXT_SHOW = new Set(["Tj", "'", '"', "TJ"])
const IDENTITY: RedactMatrix = [1, 0, 0, 1, 0, 0]

export function streamBytes(stream: Mupdf.PDFObject): Uint8Array {
	return stream.readStream().asUint8Array().slice()
}

// A page's content, its streams joined.
export function pageContent(page: Mupdf.PDFObject): Uint8Array {
	const contents = page.get("Contents")

	if (contents.isStream()) return streamBytes(contents)
	if (!contents.isArray()) return new Uint8Array(0)

	const parts: Uint8Array[] = []

	contents.forEach(part => {
		if (part.isStream()) parts.push(streamBytes(part), Uint8Array.of(10))
	})

	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let offset = 0

	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}

	return out
}

export function setPageContent(document: Mupdf.PDFDocument, page: Mupdf.PDFObject, bytes: Uint8Array): void {
	page.put("Contents", document.addStream(bytes, {}))
}

function numbers(operands: readonly PdfOperand[]): number[] {
	return operands.map(operand => (operand.kind === "number" ? operand.value : Number.NaN))
}

function matrixOf(object: Mupdf.PDFObject): RedactMatrix {
	if (!object.isArray() || object.length !== 6) return IDENTITY

	const values = [0, 1, 2, 3, 4, 5].map(index => object.get(index).asNumber())

	return [values[0] ?? 1, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1, values[4] ?? 0, values[5] ?? 0]
}

function rectOf(object: Mupdf.PDFObject): RedactRect | null {
	if (!object.isArray() || object.length !== 4) return null

	const [a = 0, b = 0, c = 0, d = 0] = [0, 1, 2, 3].map(index => object.get(index).asNumber())

	return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]
}

// A shallow copy of a dictionary, without the keys given.
function copyDict(document: Mupdf.PDFDocument, source: Mupdf.PDFObject, without: readonly string[] = []): Mupdf.PDFObject {
	const copy = document.newDictionary()

	source.forEach((value, key) => {
		if (typeof key === "string" && !without.includes(key)) copy.put(key, value)
	})

	return copy
}

// A form XObject with new content: a fresh object, so other users of the original keep it unchanged.
function cloneForm(
	document: Mupdf.PDFDocument,
	form: Mupdf.PDFObject,
	bytes: Uint8Array,
	resources: Mupdf.PDFObject | null
): Mupdf.PDFObject {
	const dict = copyDict(document, form, ["Length", "Filter", "DecodeParms"])

	if (resources !== null) dict.put("Resources", resources)

	return document.addStream(bytes, dict)
}

// Resources with some XObject names pointing elsewhere; a copy, since resources are often shared.
function withXObjects(
	document: Mupdf.PDFDocument,
	resources: Mupdf.PDFObject,
	replaced: ReadonlyMap<string, Mupdf.PDFObject>
): Mupdf.PDFObject {
	const copy = copyDict(document, resources)
	const xobjects = copyDict(document, resources.get("XObject"))

	for (const [name, form] of replaced) xobjects.put(name, form)

	copy.put("XObject", xobjects)

	return copy
}

interface ShadingResult {
	// New content, or null when nothing changed.
	readonly bytes: Uint8Array | null
	// New resources (forms replaced), or null when unchanged.
	readonly resources: Mupdf.PDFObject | null
}

// Removes every `sh` whose clip region touches an area mark: MuPDF's redaction keeps shadings, which for meshes can
// draw anything. The clip is tracked as a bounding box (path clips; text clips are ignored, which only widens it), so
// a shading that might reach a mark goes.
function removeShadingsIn(
	document: Mupdf.PDFDocument,
	bytes: Uint8Array,
	resources: Mupdf.PDFObject,
	start: RedactMatrix,
	startClip: RedactRect | null,
	areas: readonly RedactRect[],
	depth: number
): ShadingResult {
	const operations = parseContent(bytes)
	const edits: ContentEdit[] = []
	const replaced = new Map<string, Mupdf.PDFObject>()
	const stack: { ctm: RedactMatrix; clip: RedactRect | null }[] = []
	let ctm = start
	let clip = startClip
	let path: RedactRect | null = null
	let pendingClip = false
	const touches = (region: RedactRect | null): boolean => region === null || areas.some(area => rectsOverlap(region, area))
	const extend = (x: number, y: number): void => {
		path = path === null ? [x, y, x, y] : [Math.min(path[0], x), Math.min(path[1], y), Math.max(path[2], x), Math.max(path[3], y)]
	}

	for (const operation of operations) {
		const { operator, operands } = operation

		if (operator === "q") {
			stack.push({ ctm, clip })
		} else if (operator === "Q") {
			const saved = stack.pop()

			if (saved !== undefined) ({ ctm, clip } = saved)
		} else if (operator === "cm") {
			const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = numbers(operands)

			if ([a, b, c, d, e, f].every(Number.isFinite)) ctm = concatMatrix([a, b, c, d, e, f], ctm)
		} else if (PATH_BUILD.has(operator)) {
			const values = numbers(operands)

			if (operator === "re") {
				const [x = 0, y = 0, width = 0, height = 0] = values

				extend(x, y)
				extend(x + width, y + height)
			} else {
				for (let index = 0; index + 1 < values.length; index += 2) extend(values[index] ?? 0, values[index + 1] ?? 0)
			}
		} else if (operator === "W" || operator === "W*") {
			pendingClip = true
		} else if (PATH_PAINT.has(operator)) {
			if (pendingClip && path !== null) {
				const box = transformRect(ctm, path)

				clip = clip === null ? box : (intersectRects(clip, box) ?? [box[0], box[1], box[0], box[1]])
			}

			path = null
			pendingClip = false
		} else if (operator === "sh") {
			if (touches(clip)) edits.push({ start: operation.start, end: operation.end })
		} else if (operator === "Do" && depth < MAX_FORM_DEPTH) {
			const name = operands[0]?.kind === "name" ? operands[0].value : null
			const form = name === null ? null : resources.get("XObject", name)

			if (name === null || form === null || !form.isStream() || form.get("Subtype").asName() !== "Form") continue

			const formCtm = concatMatrix(matrixOf(form.get("Matrix")), ctm)
			const bbox = rectOf(form.get("BBox"))
			const formClip =
				bbox === null ? clip : clip === null ? transformRect(formCtm, bbox) : intersectRects(clip, transformRect(formCtm, bbox))

			if (formClip !== null && !touches(formClip)) continue

			const formResources = form.get("Resources").isDictionary() ? form.get("Resources") : resources
			const result = removeShadingsIn(document, streamBytes(form), formResources, formCtm, formClip, areas, depth + 1)

			if (result.bytes !== null || result.resources !== null) {
				replaced.set(name, cloneForm(document, form, result.bytes ?? streamBytes(form), result.resources))
			}
		}
	}

	return {
		bytes: edits.length === 0 ? null : spliceContent(bytes, edits),
		resources: replaced.size === 0 ? null : withXObjects(document, resources, replaced)
	}
}

// Removes the page's shadings that may touch an area mark (page space). Returns whether the page changed.
export function removeShadings(document: Mupdf.PDFDocument, page: Mupdf.PDFPage, areas: readonly RedactRect[]): boolean {
	if (areas.length === 0) return false

	const object = page.getObject()
	const resources = object.getInheritable("Resources")

	if (!resources.isDictionary()) return false

	const result = removeShadingsIn(document, pageContent(object), resources, page.getTransform(), null, areas, 0)

	if (result.bytes !== null) setPageContent(document, object, result.bytes)
	if (result.resources !== null) object.put("Resources", result.resources)

	return result.bytes !== null || result.resources !== null
}

// ——— Marked content and its text alternatives ———

export interface MarkedSection {
	// Index of its BDC/BMC operation.
	readonly open: number
	readonly mcid: number | null
	// What the section draws: shown strings, painted paths, images and forms (forms by their own signature).
	readonly signature: string
}

function hexOf(bytes: Uint8Array): string {
	let out = ""

	for (const byte of bytes) out += byte.toString(16).padStart(2, "0")

	return out
}

function propertyDict(resources: Mupdf.PDFObject, operand: PdfOperand | undefined): Mupdf.PDFObject | null {
	if (operand?.kind !== "name") return null

	const dict = resources.get("Properties", operand.value)

	return dict.isDictionary() ? dict : null
}

function mcidOf(resources: Mupdf.PDFObject, operation: PdfOperation): number | null {
	if (operation.operator !== "BDC") return null

	const operand = operation.operands[1]

	if (operand?.kind === "dict") {
		const mcid = operand.entries.get("MCID")

		return mcid?.kind === "number" ? mcid.value : null
	}

	const dict = propertyDict(resources, operand)
	const mcid = dict?.get("MCID")

	return mcid !== undefined && mcid.isNumber() ? mcid.asNumber() : null
}

// What a stream draws, in order, as a comparable string.
function drawSignature(resources: Mupdf.PDFObject, operation: PdfOperation, depth: number, seen: Set<number>): string {
	const { operator, operands } = operation

	if (TEXT_SHOW.has(operator)) {
		let out = "T"

		for (const operand of operands) {
			if (operand.kind === "string") out += hexOf(operand.bytes)
			if (operand.kind === "array") for (const item of operand.items) if (item.kind === "string") out += hexOf(item.bytes)
		}

		return out
	}
	if (PATH_PAINT.has(operator) && operator !== "n") return "P"
	if (operator === "sh") return "S"
	if (operator === "BI") return "B"
	if (operator !== "Do") return ""

	const name = operands[0]?.kind === "name" ? operands[0].value : ""
	const xobject = resources.get("XObject", name)

	if (!xobject.isStream()) return "X"
	if (xobject.get("Subtype").asName() !== "Form") return `I${String(xobject.asIndirect())}`

	const number = xobject.asIndirect()

	if (depth >= MAX_FORM_DEPTH || seen.has(number)) return "F"

	seen.add(number)

	const formResources = xobject.get("Resources").isDictionary() ? xobject.get("Resources") : resources
	const inner = parseContent(streamBytes(xobject))
		.map(child => drawSignature(formResources, child, depth + 1, seen))
		.join("")

	seen.delete(number)

	return `F(${inner})`
}

// The marked-content sections of a page's content, in order, with what each draws.
export function markedSections(page: Mupdf.PDFObject): { readonly operations: PdfOperation[]; readonly sections: MarkedSection[] } {
	const resources = page.getInheritable("Resources")
	const operations = parseContent(pageContent(page))
	const sections: MarkedSection[] = []
	const open: { index: number; mcid: number | null; signature: string }[] = []

	if (!resources.isDictionary()) return { operations, sections }

	operations.forEach((operation, index) => {
		if (operation.operator === "BDC" || operation.operator === "BMC") {
			open.push({ index, mcid: mcidOf(resources, operation), signature: "" })

			return
		}
		if (operation.operator === "EMC") {
			const closed = open.pop()

			if (closed !== undefined) sections.push({ open: closed.index, mcid: closed.mcid, signature: closed.signature })

			return
		}

		const part = drawSignature(resources, operation, 0, new Set())

		if (part.length > 0) for (const section of open) section.signature += part
	})

	for (const unclosed of open) sections.push({ open: unclosed.index, mcid: unclosed.mcid, signature: unclosed.signature })

	sections.sort((left, right) => left.open - right.open)

	return { operations, sections }
}

// The sections whose drawing changed between two snapshots of one page; all of them when the sections no longer
// line up one to one (the safe answer).
export function changedSections(before: readonly MarkedSection[], after: readonly MarkedSection[]): MarkedSection[] {
	if (before.length !== after.length) return [...after]

	return after.filter((section, index) => {
		const old = before[index]

		return old === undefined || old.signature !== section.signature || old.mcid !== section.mcid
	})
}

const ALTERNATIVES = ["ActualText", "Alt", "E"]

// Removes the text alternatives of the given sections from their marked-content properties (inline in the stream,
// or in the page's Properties resources). Returns whether the page changed.
export function stripSectionText(
	document: Mupdf.PDFDocument,
	page: Mupdf.PDFObject,
	operations: readonly PdfOperation[],
	sections: readonly MarkedSection[]
): boolean {
	const resources = page.getInheritable("Resources")
	const edits: ContentEdit[] = []
	let changed = false

	for (const section of sections) {
		const operation = operations[section.open]

		if (operation?.operator !== "BDC") continue

		const [tag, properties] = operation.operands

		if (properties?.kind === "dict" && ALTERNATIVES.some(key => properties.entries.has(key)) && tag !== undefined) {
			const entries = new Map([...properties.entries].filter(([key]) => !ALTERNATIVES.includes(key)))

			edits.push({ start: operation.start, end: operation.end, replacement: writeOperation("BDC", [tag, { kind: "dict", entries }]) })
		} else if (resources.isDictionary()) {
			const dict = propertyDict(resources, properties)

			for (const key of ALTERNATIVES) {
				if (dict !== null && !dict.get(key).isNull()) {
					dict.delete(key)
					changed = true
				}
			}
		}
	}

	if (edits.length > 0) setPageContent(document, page, spliceContent(pageContent(page), edits))

	return changed || edits.length > 0
}

// ——— Hidden layers (sanitize) ———

export type OcVisibility = (properties: Mupdf.PDFObject) => boolean

// Removes, in place, the marked-content sections and XObject draws of a stream whose optional content is hidden.
// Hidden is a property of the document, not of where a stream is used, so shared streams are rewritten once.
function removeHiddenIn(
	document: Mupdf.PDFDocument,
	stream: Mupdf.PDFObject | null,
	bytes: Uint8Array,
	resources: Mupdf.PDFObject,
	visible: OcVisibility,
	done: Set<number>,
	depth: number
): Uint8Array | null {
	const operations = parseContent(bytes)
	const edits: ContentEdit[] = []

	for (let index = 0; index < operations.length; index++) {
		const operation = operations[index]

		if (operation === undefined) continue
		if (operation.operator === "BDC" && operation.operands[0]?.kind === "name" && operation.operands[0].value === "OC") {
			const properties = propertyDict(resources, operation.operands[1])

			if (properties !== null && !visible(properties)) {
				const end = sectionEnd(operations, index)
				const last = operations[end]

				edits.push({ start: operation.start, end: last?.end ?? bytes.length })

				if (end < 0) break

				index = end

				continue
			}
		}
		if (operation.operator !== "Do") continue

		const name = operation.operands[0]?.kind === "name" ? operation.operands[0].value : ""
		const xobject = resources.get("XObject", name)

		if (!xobject.isStream()) continue

		const oc = xobject.get("OC")

		if (oc.isDictionary() && !visible(oc)) {
			edits.push({ start: operation.start, end: operation.end })

			continue
		}

		if (xobject.get("Subtype").asName() === "Form" && depth < MAX_FORM_DEPTH)
			removeHiddenStream(document, xobject, resources, visible, done, depth + 1)
	}

	// Patterns draw content of their own.
	resources.get("Pattern").forEach(pattern => {
		if (pattern.isStream() && depth < MAX_FORM_DEPTH) removeHiddenStream(document, pattern, resources, visible, done, depth + 1)
	})

	if (edits.length === 0) return null

	const out = spliceContent(bytes, edits)

	if (stream !== null) stream.writeStream(out)

	return out
}

function removeHiddenStream(
	document: Mupdf.PDFDocument,
	stream: Mupdf.PDFObject,
	parentResources: Mupdf.PDFObject,
	visible: OcVisibility,
	done: Set<number>,
	depth: number
): void {
	const number = stream.asIndirect()

	if (number !== 0) {
		if (done.has(number)) return

		done.add(number)
	}

	const resources = stream.get("Resources").isDictionary() ? stream.get("Resources") : parentResources

	removeHiddenIn(document, stream, streamBytes(stream), resources, visible, done, depth)
}

// Removes the page's hidden-layer content, its hidden annotations, and hidden content in its annotations'
// appearances. Returns whether the page changed.
export function removeHiddenContent(document: Mupdf.PDFDocument, page: Mupdf.PDFPage, visible: OcVisibility, done: Set<number>): boolean {
	const object = page.getObject()
	const resources = object.getInheritable("Resources")
	let changed = false

	if (resources.isDictionary()) {
		const out = removeHiddenIn(document, null, pageContent(object), resources, visible, done, 0)

		if (out !== null) {
			setPageContent(document, object, out)
			changed = true
		}
	}

	for (const annotation of page.getAnnotations()) {
		const annotObject = annotation.getObject()
		const oc = annotObject.get("OC")

		if (oc.isDictionary() && !visible(oc)) {
			page.deleteAnnotation(annotation)
			changed = true

			continue
		}

		annotObject.get("AP").forEach(appearance => {
			const streams = appearance.isStream() ? [appearance] : []

			if (appearance.isDictionary()) appearance.forEach(state => streams.push(state))

			for (const stream of streams) {
				if (stream.isStream()) removeHiddenStream(document, stream, document.newDictionary(), visible, done, 0)
			}
		})
	}

	return changed
}

// Removes thumbnails and the alternate and OPI versions of the page's images and forms (or, with `remove` false,
// only reports them). Returns whether there were any.
export function removeAlternates(page: Mupdf.PDFObject, remove = true): boolean {
	let found = false
	const seen = new Set<number>()
	const drop = (object: Mupdf.PDFObject, key: string): void => {
		if (object.get(key).isNull()) return

		found = true

		if (remove) object.delete(key)
	}
	const visit = (resources: Mupdf.PDFObject, depth: number): void => {
		if (!resources.isDictionary() || depth > MAX_FORM_DEPTH) return

		for (const group of ["XObject", "Pattern"]) {
			resources.get(group).forEach(object => {
				const number = object.asIndirect()

				if (number !== 0 && seen.has(number)) return
				if (number !== 0) seen.add(number)

				drop(object, "Alternates")
				drop(object, "OPI")
				visit(object.get("Resources"), depth + 1)
			})
		}
	}

	drop(page, "Thumb")
	visit(page.getInheritable("Resources"), 0)

	return found
}
