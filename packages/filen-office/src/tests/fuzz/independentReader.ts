import { inflateSync } from "fflate"

// A reader of written packages that shares no code with @filen/office: its own zip central-directory
// parser, its own namespace-aware XML parser, and checks for what makes Word refuse or repair a document.
// The damage fuzz compares what it reads in a saved file with the editor's document and with the source.

// ---- zip ----

export interface ZipEntry {
	readonly name: string
	readonly method: number
	readonly crc: number
	readonly compressedSize: number
	readonly size: number
	readonly raw: Uint8Array
}

const utf8 = new TextDecoder()

export function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let end = -1

	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			end = i
			break
		}
	}

	if (end < 0) throw new Error("No end of central directory")

	const count = view.getUint16(end + 10, true)
	let at = view.getUint32(end + 16, true)
	const out = new Map<string, ZipEntry>()

	for (let k = 0; k < count; k++) {
		if (view.getUint32(at, true) !== 0x02014b50) throw new Error("Bad central directory header")

		const method = view.getUint16(at + 10, true)
		const crc = view.getUint32(at + 16, true)
		const compressedSize = view.getUint32(at + 20, true)
		const size = view.getUint32(at + 24, true)
		const nameLength = view.getUint16(at + 28, true)
		const extraLength = view.getUint16(at + 30, true)
		const commentLength = view.getUint16(at + 32, true)
		const local = view.getUint32(at + 42, true)
		const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength))

		if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`Bad local header: ${name}`)
		if (out.has(name)) throw new Error(`Duplicate zip entry: ${name}`)

		const data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)

		out.set(name, { name, method, crc, compressedSize, size, raw: bytes.subarray(data, data + compressedSize) })
		at += 46 + nameLength + extraLength + commentLength
	}

	return out
}

export function entryData(entry: ZipEntry): Uint8Array {
	if (entry.method === 0) return entry.raw
	if (entry.method === 8) return inflateSync(entry.raw)

	throw new Error(`Compression method ${entry.method}`)
}

export function sameRaw(a: ZipEntry, b: ZipEntry): boolean {
	if (a.method !== b.method || a.crc !== b.crc || a.compressedSize !== b.compressedSize || a.size !== b.size) return false

	for (let i = 0; i < a.compressedSize; i++) if (a.raw[i] !== b.raw[i]) return false

	return true
}

// ---- XML ----

export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
export const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml"
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
const XML_NS = "http://www.w3.org/XML/1998/namespace"
const XMLNS_NS = "http://www.w3.org/2000/xmlns/"

export interface XAttribute {
	readonly name: string
	readonly prefix: string
	readonly local: string
	readonly ns: string | null
	readonly value: string
}

export interface XElement {
	readonly name: string
	readonly prefix: string
	readonly local: string
	// null when unbound (or unprefixed with no default namespace).
	readonly ns: string | null
	readonly attributes: readonly XAttribute[]
	// Elements and decoded text.
	readonly children: (XElement | string)[]
	readonly parent: XElement | undefined
	readonly start: number
	end: number
}

export interface XDocument {
	readonly root: XElement | undefined
	// Well-formedness and namespace errors.
	readonly errors: string[]
	readonly source: string
}

const NAME = /[^\s/>=<]+/y
const SPACE = /\s*/y
const ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }

function decode(raw: string, errors: string[]): string {
	if (!raw.includes("&")) return raw

	let out = ""
	let at = 0

	for (let amp = raw.indexOf("&"); amp >= 0; amp = raw.indexOf("&", at)) {
		out += raw.slice(at, amp)

		const semi = raw.indexOf(";", amp)
		const body = semi < 0 ? "" : raw.slice(amp + 1, semi)
		let value: string | undefined = ENTITIES[body]

		if (value === undefined && /^#[0-9]+$/.test(body)) value = codePoint(Number(body.slice(1)))
		else if (value === undefined && /^#x[0-9a-fA-F]+$/.test(body)) value = codePoint(parseInt(body.slice(2), 16))

		if (value === undefined) {
			errors.push(`bad reference: ${raw.slice(amp, amp + 12)}`)
			out += "&"
			at = amp + 1
		} else {
			out += value
			at = semi + 1
		}
	}

	return out + raw.slice(at)
}

function codePoint(value: number): string | undefined {
	const legal =
		value === 0x9 || value === 0xa || value === 0xd || (value >= 0x20 && value <= 0xd7ff) || (value >= 0xe000 && value <= 0xfffd)

	return legal || (value >= 0x10000 && value <= 0x10ffff) ? String.fromCodePoint(value) : undefined
}

function split(name: string): { prefix: string; local: string } {
	const colon = name.indexOf(":")

	return colon < 0 ? { prefix: "", local: name } : { prefix: name.slice(0, colon), local: name.slice(colon + 1) }
}

export function parseXml(bytes: Uint8Array): XDocument {
	// Line ends normalised as XML 1.0 (2.11) reads them.
	const source = utf8.decode(bytes).replace(/\r\n?/g, "\n")
	const errors: string[] = []
	const stack: XElement[] = []
	const scopes: Map<string, string | null>[] = [new Map<string, string | null>([["xml", XML_NS]])]
	let root: XElement | undefined
	let at = source.charCodeAt(0) === 0xfeff ? 1 : 0

	const lookup = (prefix: string): string | null | undefined => {
		for (let k = scopes.length - 1; k >= 0; k--) {
			const scope = scopes[k] as Map<string, string | null>

			if (scope.has(prefix)) return scope.get(prefix)
		}

		return undefined
	}
	const text = (raw: string): void => {
		const parent = stack[stack.length - 1]

		if (parent === undefined) {
			if (raw.trim() !== "") errors.push("text outside the root element")

			return
		}

		if (raw.includes("]]>")) errors.push("]]> in text")

		const value = decode(raw, errors)
		const last = parent.children.length - 1

		if (typeof parent.children[last] === "string") parent.children[last] += value
		else parent.children.push(value)
	}
	const skipTo = (marker: string, from: number, what: string): number => {
		const end = source.indexOf(marker, from)

		if (end >= 0) return end + marker.length

		errors.push(`unterminated ${what}`)

		return source.length
	}

	while (at < source.length) {
		const open = source.indexOf("<", at)

		if (open < 0) {
			text(source.slice(at))
			break
		}

		if (open > at) text(source.slice(at, open))

		if (source.startsWith("<!--", open)) {
			at = skipTo("-->", open + 4, "comment")
		} else if (source.startsWith("<![CDATA[", open)) {
			const end = source.indexOf("]]>", open + 9)
			const parent = stack[stack.length - 1]

			if (parent === undefined) errors.push("CDATA outside the root element")
			else parent.children.push(source.slice(open + 9, end < 0 ? source.length : end))

			at = end < 0 ? source.length : end + 3

			if (end < 0) errors.push("unterminated CDATA")
		} else if (source.startsWith("<?", open)) {
			at = skipTo("?>", open + 2, "processing instruction")
		} else if (source.startsWith("<!DOCTYPE", open)) {
			const bracket = source.indexOf("[", open)
			const close = source.indexOf(">", open)

			at = bracket >= 0 && bracket < close ? skipTo(">", skipTo("]", bracket, "DOCTYPE"), "DOCTYPE") : skipTo(">", open, "DOCTYPE")
		} else if (source[open + 1] === "/") {
			const close = source.indexOf(">", open)
			const name = source.slice(open + 2, close < 0 ? source.length : close).trim()
			const element = stack.pop()

			scopes.pop()

			if (element === undefined) errors.push(`end tag </${name}> without a start tag`)
			else {
				if (element.name !== name) errors.push(`end tag </${name}> closes <${element.name}>`)

				element.end = close < 0 ? source.length : close + 1
			}

			if (close < 0) errors.push("unterminated end tag")

			at = close < 0 ? source.length : close + 1
		} else {
			NAME.lastIndex = open + 1

			const name = NAME.exec(source)?.[0]

			if (name === undefined) {
				errors.push(`bad markup at ${open}`)
				at = open + 1
				continue
			}

			let cursor = open + 1 + name.length
			const raw: { name: string; value: string }[] = []
			let empty = false
			let closed = false

			while (cursor < source.length) {
				SPACE.lastIndex = cursor
				SPACE.exec(source)
				cursor = SPACE.lastIndex

				const c = source[cursor]

				if (c === ">") {
					cursor++
					closed = true
					break
				}

				if (c === "/" && source[cursor + 1] === ">") {
					cursor += 2
					empty = true
					closed = true
					break
				}

				NAME.lastIndex = cursor

				const attribute = NAME.exec(source)?.[0]

				if (attribute === undefined) break

				cursor += attribute.length
				SPACE.lastIndex = cursor
				SPACE.exec(source)
				cursor = SPACE.lastIndex

				if (source[cursor] !== "=") break

				SPACE.lastIndex = cursor + 1
				SPACE.exec(source)
				cursor = SPACE.lastIndex

				const quote = source[cursor]

				if (quote !== '"' && quote !== "'") break

				const close = source.indexOf(quote, cursor + 1)

				if (close < 0) break

				const value = source.slice(cursor + 1, close)

				if (value.includes("<")) errors.push(`< in attribute ${attribute}`)
				if (raw.some(item => item.name === attribute)) errors.push(`duplicate attribute ${attribute} on <${name}>`)

				// Attribute-value normalisation (3.3.3): literal whitespace reads as spaces.
				raw.push({ name: attribute, value: decode(value.replace(/[\t\n]/g, " "), errors) })
				cursor = close + 1
			}

			if (!closed) {
				errors.push(`malformed start tag <${name}>`)

				const gt = source.indexOf(">", cursor)

				cursor = gt < 0 ? source.length : gt + 1
				empty = gt > 0 && source[gt - 1] === "/"
			}

			const scope = new Map<string, string | null>()

			for (const attribute of raw) {
				if (attribute.name === "xmlns") scope.set("", attribute.value === "" ? null : attribute.value)
				else if (attribute.name.startsWith("xmlns:")) scope.set(attribute.name.slice(6), attribute.value)
			}

			scopes.push(scope)

			const { prefix, local } = split(name)
			let ns = lookup(prefix)

			if (ns === undefined) {
				if (prefix !== "") errors.push(`unbound prefix ${prefix} on <${name}>`)

				ns = null
			}

			const attributes = raw.map(attribute => {
				const parts = split(attribute.name)
				let attributeNs: string | null = null

				if (attribute.name === "xmlns" || parts.prefix === "xmlns") attributeNs = XMLNS_NS
				else if (parts.prefix !== "") {
					attributeNs = lookup(parts.prefix) ?? null

					if (attributeNs === null) errors.push(`unbound prefix ${parts.prefix} on ${attribute.name}`)
				}

				return { name: attribute.name, prefix: parts.prefix, local: parts.local, ns: attributeNs, value: attribute.value }
			})
			const parent = stack[stack.length - 1]
			const element: XElement = { name, prefix, local, ns, attributes, children: [], parent, start: open, end: cursor }

			if (parent !== undefined) parent.children.push(element)
			else if (root === undefined) root = element
			else errors.push(`second root element <${name}>`)

			if (empty) scopes.pop()
			else stack.push(element)

			at = cursor
		}
	}

	for (const element of stack) errors.push(`unclosed <${element.name}>`)
	if (root === undefined) errors.push("no root element")

	return { root, errors, source }
}

export function childElements(element: XElement): XElement[] {
	const out: XElement[] = []

	for (const child of element.children) if (typeof child !== "string") out.push(child)

	return out
}

// Descendants in document order (not `element` itself).
export function* descendants(element: XElement): Generator<XElement> {
	for (const child of element.children) {
		if (typeof child === "string") continue

		yield child
		yield* descendants(child)
	}
}

export function textContent(element: XElement): string {
	let out = ""

	for (const child of element.children) out += typeof child === "string" ? child : textContent(child)

	return out
}

export function attribute(element: XElement, name: string): string | null {
	return element.attributes.find(item => item.name === name)?.value ?? null
}

export function attributeNS(element: XElement, ns: string, local: string): string | null {
	return element.attributes.find(item => item.ns === ns && item.local === local)?.value ?? null
}

function isW(element: XElement | undefined, local?: string): element is XElement {
	return element !== undefined && element.ns === W && (local === undefined || element.local === local)
}

function wAttribute(element: XElement, local: string): string | null {
	return attributeNS(element, W, local)
}

// Up to 300 characters of the element's source, for reports.
function sample(document: XDocument, element: XElement | undefined): string {
	if (element === undefined) return ""

	const text = document.source.slice(element.start, Math.min(element.end, element.start + 301))

	return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

// ---- paragraph signatures ----

const SKIP_SUBTREES = new Set([
	"drawing",
	"pict",
	"object",
	"txbxContent",
	"fldSimple",
	"rPrChange",
	"pPrChange",
	"instrText",
	"delInstrText"
])

function onOff(element: XElement | undefined): string {
	if (element === undefined) return ""

	const value = wAttribute(element, "val")

	if (value === null) return "1"

	return value === "0" || value === "false" || value === "off" ? "0" : "1"
}

function runFormat(run: XElement): string {
	const properties = childElements(run).find(child => isW(child, "rPr"))

	if (properties === undefined) return "|||"

	const children = childElements(properties).filter(child => isW(child))
	const get = (local: string): XElement | undefined => children.find(child => child.local === local)
	const underline = get("u")

	return [
		onOff(get("b")),
		onOff(get("i")),
		underline === undefined ? "" : (wAttribute(underline, "val") ?? "single"),
		onOff(get("strike"))
	].join("|")
}

function paragraphProps(paragraph: XElement): string {
	const properties = childElements(paragraph).find(child => isW(child, "pPr"))

	if (properties === undefined) return JSON.stringify([null, null, null, null])

	const children = childElements(properties).filter(child => isW(child))
	const get = (local: string): XElement | undefined => children.find(child => child.local === local)
	const numbering = get("numPr")
	let numId: string | null = null
	let level: string | null = null

	if (numbering !== undefined) {
		for (const child of childElements(numbering)) {
			if (isW(child, "numId")) numId = wAttribute(child, "val")
			if (isW(child, "ilvl")) level = wAttribute(child, "val")
		}
	}

	const style = get("pStyle")
	const align = get("jc")

	return JSON.stringify([
		style === undefined ? null : wAttribute(style, "val"),
		numId === null ? null : Number(numId),
		level === null ? null : Number(level),
		// As the writer writes it and Word reads it: start and end are the left and right edges.
		align === undefined ? null : writtenAlign(wAttribute(align, "val"))
	])
}

function preserved(element: XElement): boolean {
	for (let at: XElement | undefined = element; at !== undefined; at = at.parent) {
		const value = attribute(at, "xml:space")

		if (value) return value === "preserve"
	}

	return false
}

export interface ParagraphSignature {
	readonly props: string
	readonly text: string
	readonly fmt: string
}

const WRITTEN_ALIGN: Readonly<Record<string, string>> = { start: "left", end: "right" }

function writtenAlign(value: string | null): string | null {
	return value === null ? null : (WRITTEN_ALIGN[value] ?? value)
}

// Text (w:t and w:delText outside fields, drawings and alternate content) with per-character run formatting.
export function paragraphSignature(paragraph: XElement): ParagraphSignature {
	let text = ""
	let fmt = ""
	const fields: ("instr" | "result")[] = []
	const walk = (node: XElement, run: XElement | undefined): void => {
		for (const child of childElements(node)) {
			if (child.ns === MC && child.local === "AlternateContent") continue
			if (!isW(child)) continue

			const local = child.local

			if (SKIP_SUBTREES.has(local) || local === "pPr" || local === "rPr") continue

			if (local === "fldChar") {
				const type = wAttribute(child, "fldCharType")

				if (type === "begin") fields.push("instr")
				else if (type === "separate" && fields.length > 0) fields[fields.length - 1] = "result"
				else if (type === "end") fields.pop()

				continue
			}

			if (local === "t" || local === "delText") {
				if (run !== undefined && fields.length === 0) {
					const raw = textContent(child)
					// Word's reading: edge whitespace counts only under xml:space="preserve".
					const value = preserved(child) ? raw : raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "")

					text += value
					fmt += `${runFormat(run)}${local === "delText" ? "|D" : ""};`.repeat(value.length)
				}

				continue
			}

			walk(child, local === "r" ? child : run)
		}
	}

	walk(paragraph, undefined)

	return { props: paragraphProps(paragraph), text, fmt }
}

// Story paragraphs in document order under `container`, not those in text boxes or alternate content.
export function storyParagraphs(container: XElement): XElement[] {
	const out: XElement[] = []
	const walk = (node: XElement): void => {
		for (const child of childElements(node)) {
			if (child.ns === MC && child.local === "AlternateContent") continue

			if (isW(child)) {
				if (SKIP_SUBTREES.has(child.local) && child.local !== "fldSimple") continue

				if (child.local === "p") {
					out.push(child)
					continue
				}

				if (child.local === "r") continue
			}

			walk(child)
		}
	}

	walk(container)

	return out
}

export function bodyOf(document: XDocument): XElement | undefined {
	return document.root === undefined ? undefined : childElements(document.root).find(child => isW(child, "body"))
}

// ---- what Word refuses or repairs, counted so a source's own problems can be told from new ones ----

const RPR_ORDER = (
	"rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color " +
	"spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath"
).split(" ")
const PARAGRAPH_RPR_ORDER = ["ins", "del", "moveFrom", "moveTo", ...RPR_ORDER, "rPrChange"]
const PPR_ORDER = (
	"pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens " +
	"kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing " +
	"mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange"
).split(" ")
const NUMPR_ORDER = ["ilvl", "numId", "numberingChange", "ins"]
const REVISIONS = new Set([
	"ins",
	"del",
	"moveFrom",
	"moveTo",
	"rPrChange",
	"pPrChange",
	"sectPrChange",
	"tblPrChange",
	"trPrChange",
	"tcPrChange",
	"tblGridChange",
	"tblPrExChange",
	"numberingChange",
	"cellIns",
	"cellDel",
	"cellMerge",
	"moveFromRangeStart",
	"moveToRangeStart"
])

// Characters XML 1.0 does not allow (tab, line feed and carriage return aside).
function hasIllegalCharacter(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)

		if ((code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd) || code === 0xfffe || code === 0xffff) return true
	}

	return false
}

function outOfOrder(element: XElement, order: readonly string[]): boolean {
	let last = -1

	for (const child of childElements(element)) {
		if (!isW(child)) continue

		const k = order.indexOf(child.local)

		if (k < 0) continue
		if (k < last) return true

		last = k
	}

	return false
}

function duplicateChildren(element: XElement): boolean {
	const names = childElements(element)
		.filter(child => isW(child))
		.map(child => child.local)

	return new Set(names).size !== names.length
}

export type Counts = Map<string, number>

function bump(counts: Counts, key: string): void {
	counts.set(key, (counts.get(key) ?? 0) + 1)
}

export interface Relationship {
	readonly type: string
	readonly external: boolean
	readonly target: string
}

export interface ViolationContext {
	readonly numIds?: ReadonlySet<string>
	readonly styleIds?: ReadonlySet<string> | undefined
	readonly relationships?: ReadonlyMap<string, Relationship>
}

// Violation counts of one story part, with a sample of each kind.
export function violations(document: XDocument, context: ViolationContext): { counts: Counts; samples: Map<string, string> } {
	const counts: Counts = new Map()
	const samples = new Map<string, string>()
	const note = (kind: string, example: string): void => {
		bump(counts, kind)

		if (!samples.has(kind)) samples.set(kind, example)
	}
	const ids: Counts = new Map()
	const bookmarkStarts: Counts = new Map()
	const bookmarkEnds: Counts = new Map()
	const commentStarts: Counts = new Map()
	const commentEnds: Counts = new Map()
	const commentReferences: Counts = new Map()
	const bookmarkStartAt = new Map<string, number>()
	const bookmarkEndAt = new Map<string, number>()
	const commentStartAt = new Map<string, number>()
	const commentEndAt = new Map<string, number>()
	const commentReferenceAt = new Map<string, number>()
	let order = 0
	let fieldDepth = 0
	let fieldUnderflow = 0

	if (document.root === undefined) return { counts, samples }

	for (const element of descendants(document.root)) {
		if (element.prefix !== "" && element.ns === null) note("unboundPrefix", element.name)

		for (const item of element.attributes)
			if (item.prefix !== "" && item.prefix !== "xmlns" && item.prefix !== "xml" && item.ns === null)
				note("unboundAttrPrefix", `${element.name}@${item.name}`)

		if (!isW(element)) continue

		const local = element.local
		const id = wAttribute(element, "id") ?? "?"
		const parent = element.parent

		order++

		switch (local) {
			case "t":
			case "delText":
			case "instrText": {
				const value = textContent(element)

				if (/^[ \t\r\n]|[ \t\r\n]$/.test(value) && attribute(element, "xml:space") !== "preserve")
					note("t-space-unpreserved", sample(document, element))
				if (hasIllegalCharacter(value)) note("t-controlChar", JSON.stringify(value.slice(0, 40)))
				if (/[\uD800-\uDFFF]/.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")))
					note("t-loneSurrogate", JSON.stringify(value))
				if (local === "t" && isW(parent) && parent.local !== "r") note("t-outsideRun", sample(document, parent))
				break
			}
			case "r": {
				if (parent === undefined || parent.local === "body") note("r-misplaced", sample(document, element))

				const children = childElements(element)
				const properties = children.findIndex(child => isW(child, "rPr"))

				if (!children.some(child => !isW(child, "rPr"))) note("r-empty", sample(document, element))
				if (properties > 0) note("r-rPrNotFirst", sample(document, element))
				if (children.filter(child => isW(child, "rPr")).length > 1) note("r-multiRPr", sample(document, element))

				const rPr = children[properties]

				if (rPr !== undefined && outOfOrder(rPr, [...RPR_ORDER, "rPrChange"])) note("rPr-order", sample(document, rPr))
				if (rPr !== undefined && duplicateChildren(rPr)) note("rPr-dupChild", sample(document, rPr))
				break
			}
			case "p": {
				const children = childElements(element)

				if (children.findIndex(child => isW(child, "pPr")) > 0) note("p-pPrNotFirst", sample(document, element))
				if (children.filter(child => isW(child, "pPr")).length > 1) note("p-multiPPr", sample(document, element))
				if (isW(parent) && ["p", "r", "hyperlink"].includes(parent.local)) note("p-nested", sample(document, parent))
				break
			}
			case "pPr": {
				if (isW(parent, "p")) {
					if (outOfOrder(element, PPR_ORDER)) note("pPr-order", sample(document, element))
					if (duplicateChildren(element)) note("pPr-dupChild", sample(document, element))

					const rPr = childElements(element).find(child => isW(child, "rPr"))

					if (rPr !== undefined && outOfOrder(rPr, PARAGRAPH_RPR_ORDER)) note("paraRPr-order", sample(document, rPr))
				}
				break
			}
			case "numPr":
				if (outOfOrder(element, NUMPR_ORDER)) note("numPr-order", sample(document, element))
				break
			case "numId": {
				const value = wAttribute(element, "val")

				if (context.numIds && value !== null && value !== "0" && isW(parent, "numPr") && !context.numIds.has(value))
					note("numId-missing", value)
				break
			}
			case "pStyle":
			case "rStyle":
			case "tblStyle": {
				const value = wAttribute(element, "val")

				if (context.styleIds && value !== null && !context.styleIds.has(value)) note(`${local}-missing`, value)
				break
			}
			case "hyperlink": {
				const relationship = attributeNS(element, R, "id") || null

				if (!relationship && !wAttribute(element, "anchor") && !wAttribute(element, "docLocation"))
					note("hyperlink-noTarget", sample(document, element))

				if (relationship && context.relationships) {
					const target = context.relationships.get(relationship)

					if (!target) note("hyperlink-relMissing", relationship)
					else if (!target.type.endsWith("/hyperlink")) note("hyperlink-relWrongType", `${relationship} ${target.type}`)
				}

				if (childElements(element).length === 0) note("hyperlink-empty", sample(document, element))
				break
			}
			case "bookmarkStart":
				bump(bookmarkStarts, id)
				bookmarkStartAt.set(id, order)
				break
			case "bookmarkEnd":
				bump(bookmarkEnds, id)
				bookmarkEndAt.set(id, order)
				break
			case "commentRangeStart":
				bump(commentStarts, id)
				commentStartAt.set(id, order)
				break
			case "commentRangeEnd":
				bump(commentEnds, id)
				commentEndAt.set(id, order)
				break
			case "commentReference":
				bump(commentReferences, id)
				commentReferenceAt.set(id, order)
				break
			case "fldChar": {
				const type = wAttribute(element, "fldCharType")

				if (type === "begin") fieldDepth++

				if (type === "end") {
					fieldDepth--

					if (fieldDepth < 0) {
						fieldUnderflow++
						fieldDepth = 0
					}
				}
				break
			}
			case "tc": {
				const children = childElements(element).filter(child => isW(child))
				let last = children[children.length - 1]

				// A block-level content control or custom XML element may hold the cell's last paragraph (Word writes
				// cells ending in a content control).
				while (last !== undefined && (last.local === "sdt" || last.local === "customXml")) {
					const holder = last.local === "sdt" ? childElements(last).find(child => isW(child, "sdtContent")) : last
					const inner =
						holder === undefined
							? []
							: childElements(holder).filter(child => isW(child) && child.local !== "sdtPr" && child.local !== "customXmlPr")

					last = inner[inner.length - 1]
				}

				if (last?.local !== "p") note("tc-notEndingInP", sample(document, element).slice(0, 200))
				if (children.findIndex(child => child.local === "tcPr") > 0) note("tc-tcPrNotFirst", "")
				break
			}
			case "tr":
				if (!childElements(element).some(child => isW(child, "tc") || isW(child, "sdt") || isW(child, "customXml")))
					note("tr-noCell", sample(document, element))
				break
			case "tbl": {
				const children = childElements(element).filter(child => isW(child))

				if (!children.some(child => child.local === "tblGrid")) note("tbl-noGrid", "")
				if (!children.some(child => child.local === "tr" || child.local === "sdt" || child.local === "customXml"))
					note("tbl-noRow", "")
				break
			}
			case "sectPr": {
				const placed =
					parent !== undefined &&
					((parent.ns === W && ["pPr", "body", "pPrChange"].includes(parent.local)) || parent.local === "sectPrChange")

				if (!placed) note("sectPr-misplaced", parent?.name ?? "")

				if (
					isW(parent, "body") &&
					childElements(parent)
						.filter(child => isW(child))
						.at(-1) !== element
				)
					note("sectPr-notLast", "")
				break
			}
		}

		if (REVISIONS.has(local) && wAttribute(element, "id") !== null) bump(ids, `rev:${id}`)

		if (local === "p" || local === "tr") {
			const paraId = attributeNS(element, W14, "paraId")

			if (paraId) bump(ids, `paraId:${paraId.toUpperCase()}`)
		}
	}

	for (const [key, times] of ids) if (times > 1) note(`dupId-${key.split(":")[0]}`, `${key} x${times}`)

	for (const [key, times] of bookmarkStarts) {
		if (times > 1) note("dupId-bookmark", key)
		if (!bookmarkEnds.has(key)) note("bookmark-noEnd", key)
	}

	for (const key of bookmarkEnds.keys()) if (!bookmarkStarts.has(key)) note("bookmarkEnd-noStart", key)

	for (const [key, times] of commentStarts) {
		if (times > 1) note("dupId-commentRange", key)
		if (!commentEnds.has(key)) note("commentRange-noEnd", key)
		if (!commentReferences.has(key)) note("commentRange-noRef", key)
	}

	for (const [key, times] of commentReferences) if (times > 1) note("dupId-commentRef", key)

	for (const [key, at] of bookmarkStartAt) if ((bookmarkEndAt.get(key) ?? Infinity) < at) note("bookmark-endBeforeStart", key)

	for (const [key, at] of commentStartAt) {
		if ((commentEndAt.get(key) ?? Infinity) < at) note("comment-endBeforeStart", key)
		if ((commentReferenceAt.get(key) ?? Infinity) < at) note("comment-refBeforeStart", key)
	}

	if (fieldDepth !== 0) note("fld-unbalanced", String(fieldDepth))
	if (fieldUnderflow > 0) note("fld-endBeforeBegin", String(fieldUnderflow))

	return { counts, samples }
}

export function relationshipsOf(bytes: Uint8Array | undefined): Map<string, Relationship> {
	const out = new Map<string, Relationship>()
	const root = bytes === undefined ? undefined : parseXml(bytes).root

	if (root === undefined) return out

	for (const element of descendants(root)) {
		if (element.local !== "Relationship") continue

		const id = attribute(element, "Id") ?? ""

		if (out.has(id)) out.set(`${id}#DUP`, { type: "dup", external: false, target: "" })

		out.set(id, {
			type: attribute(element, "Type") ?? "",
			external: attribute(element, "TargetMode") === "External",
			target: attribute(element, "Target") ?? ""
		})
	}

	return out
}

const O = "urn:schemas-microsoft-com:office:office"

// Values of the relationships-namespace attributes of a part, and of VML's o:relid.
function relationshipIdsUsed(bytes: Uint8Array): Set<string> {
	const out = new Set<string>()
	const root = parseXml(bytes).root

	if (root === undefined) return out

	for (const element of [root, ...descendants(root)])
		for (const attribute of element.attributes)
			if (attribute.ns === R || (attribute.ns === O && attribute.local === "relid")) out.add(attribute.value)

	return out
}

// The part a relationships part belongs to ("" for the package's).
function relationshipsOwner(entry: string): string | undefined {
	const match = /^(.*?)_rels\/([^/]*)\.rels$/.exec(entry)

	return match === null ? undefined : `${match[1] ?? ""}${match[2] ?? ""}`
}

// The entry an internal relationship of `owner` targets, lower-cased (part names compare case-insensitively).
function targetEntry(owner: string, target: string): string {
	const path = target.startsWith("/") ? target.slice(1) : owner.replace(/[^/]*$/, "") + target
	const segments: string[] = []

	for (const segment of path.split("/")) {
		if (segment === "..") segments.pop()
		else if (segment !== "." && segment !== "") segments.push(segment)
	}

	const joined = segments.join("/")

	try {
		return decodeURIComponent(joined).toLowerCase()
	} catch {
		return joined.toLowerCase()
	}
}

// A package's entry names and their data.
export interface PackageView {
	readonly names: readonly string[]
	read(name: string): Uint8Array | undefined
}

// Ids `part` of `view` uses: in its markup (relationshipIdsUsed), and through the SmartArt data parts its
// relationships point at, which name their drawing's relationship of `part` by dsp:dataModelExt relId.
export function partRelationshipIdsUsed(view: PackageView, part: string): Set<string> {
	const bytes = view.read(part)
	const out = bytes === undefined ? new Set<string>() : relationshipIdsUsed(bytes)

	for (const relationship of relationshipsOf(view.read(part.replace(/([^/]+)$/, "_rels/$1.rels"))).values()) {
		if (relationship.external || !relationship.type.endsWith("/diagramData")) continue

		const key = targetEntry(part, relationship.target)
		const name = view.names.find(entry => entry.toLowerCase() === key)
		const root = name === undefined ? undefined : parseXml(view.read(name) ?? new Uint8Array()).root

		if (root === undefined) continue

		for (const element of descendants(root)) {
			const id = element.local === "dataModelExt" ? attribute(element, "relId") : null

			if (id !== null) out.add(id)
		}
	}

	return out
}

interface Inbound {
	readonly owner: string
	readonly rels: string
	readonly id: string
}

// The source entries a save may leave out: parts every source relationship to which the save dropped once
// nothing in its part used it (Word drops such relationships and the parts only they point at), and the
// relationships parts of parts left out that way, transitively. A part no source relationship targets, or one a
// relationship of the output still targets, is never among them.
export function droppedParts(source: PackageView, output: PackageView): Set<string> {
	const outputNames = new Set(output.names)
	const inbound = new Map<string, Inbound[]>()
	const outputTargets = new Set<string>()
	// The ids of the output's relationships parts.
	const outputIds = new Map<string, Set<string>>()
	const edges = (view: PackageView, onEdge: (entry: string, edge: Inbound) => void): void => {
		for (const rels of view.names) {
			const owner = relationshipsOwner(rels)

			if (owner === undefined) continue

			const relationships = relationshipsOf(view.read(rels))

			if (view === output) outputIds.set(rels, new Set(relationships.keys()))

			for (const [id, relationship] of relationships)
				if (!relationship.external) onEdge(targetEntry(owner, relationship.target), { owner, rels, id })
		}
	}

	edges(source, (entry, edge) => {
		const list = inbound.get(entry)

		if (list === undefined) inbound.set(entry, [edge])
		else list.push(edge)
	})
	edges(output, entry => outputTargets.add(entry))

	const lost = source.names.filter(name => !outputNames.has(name))
	const allowed = new Set<string>()
	const usedIds = new Map<string, Set<string>>()
	const used = (view: PackageView, part: string): Set<string> => {
		const key = `${view === source ? "s" : "o"}:${part}`
		let ids = usedIds.get(key)

		if (ids === undefined) {
			ids = partRelationshipIdsUsed(view, part)
			usedIds.set(key, ids)
		}

		return ids
	}
	// Whether the save dropped `edge` once nothing in its part used it, or left out the part it belongs to.
	const unused = (edge: Inbound): boolean => {
		if (allowed.has(edge.owner)) return true
		if (!outputNames.has(edge.owner) || outputIds.get(edge.rels)?.has(edge.id) === true) return false

		return used(source, edge.owner).has(edge.id) && !used(output, edge.owner).has(edge.id)
	}

	for (let grown = true; grown;) {
		grown = false

		for (const entry of lost) {
			if (allowed.has(entry)) continue

			const owner = relationshipsOwner(entry)
			const key = entry.toLowerCase()
			const to = inbound.get(key) ?? []
			const left = owner === undefined ? to.length > 0 && !outputTargets.has(key) && to.every(unused) : allowed.has(owner)

			if (left) {
				allowed.add(entry)
				grown = true
			}
		}
	}

	return allowed
}

// Numbering instances, and problems: duplicate instances, instances of missing abstracts, abstracts after instances.
export function numberingOf(bytes: Uint8Array | undefined): { ids: Set<string>; problems: string[] } {
	const ids = new Set<string>()
	const problems: string[] = []
	const root = bytes === undefined ? undefined : parseXml(bytes).root

	if (root === undefined) return { ids, problems }

	const abstracts = new Set<string>()

	for (const element of descendants(root)) if (isW(element, "abstractNum")) abstracts.add(wAttribute(element, "abstractNumId") ?? "?")

	for (const element of descendants(root)) {
		if (!isW(element, "num")) continue

		const id = wAttribute(element, "numId") ?? "?"

		if (ids.has(id)) problems.push(`dupNum ${id}`)

		ids.add(id)

		const abstract = childElements(element).find(child => isW(child, "abstractNumId"))

		if (abstract === undefined || !abstracts.has(wAttribute(abstract, "val") ?? "")) problems.push(`num->missing abstract ${id}`)
	}

	let instances = false

	for (const child of childElements(root)) {
		if (isW(child, "num")) instances = true

		if (isW(child, "abstractNum") && instances) {
			problems.push("abstractNum after num")
			break
		}
	}

	return { ids, problems }
}

// Style ids, and problems: duplicates, basedOn/next/link to missing styles, children out of order.
export function stylesOf(bytes: Uint8Array | undefined): { ids: Set<string>; problems: string[] } {
	const ids = new Set<string>()
	const problems: string[] = []
	const root = bytes === undefined ? undefined : parseXml(bytes).root

	if (root === undefined) return { ids, problems }

	const references: [string, string][] = []

	for (const element of childElements(root)) {
		if (!isW(element, "style")) continue

		const id = wAttribute(element, "styleId") ?? ""

		if (ids.has(id)) problems.push(`dupStyle ${id}`)

		ids.add(id)

		for (const child of childElements(element))
			if (isW(child) && ["basedOn", "next", "link"].includes(child.local))
				references.push([child.local, wAttribute(child, "val") ?? ""])
	}

	for (const [kind, target] of references) if (!ids.has(target)) problems.push(`${kind}->${target}`)

	const order = ["docDefaults", "latentStyles", "style"]
	let last = -1

	for (const child of childElements(root)) {
		if (!isW(child)) continue

		const k = order.indexOf(child.local)

		if (k < last) problems.push("styles child order")

		last = Math.max(last, k)
	}

	return { ids, problems }
}

export function contentTypes(bytes: Uint8Array): { defaults: Map<string, string>; overrides: Map<string, string> } {
	const defaults = new Map<string, string>()
	const overrides = new Map<string, string>()
	const root = parseXml(bytes).root

	if (root === undefined) return { defaults, overrides }

	for (const element of descendants(root)) {
		if (element.local === "Default")
			defaults.set((attribute(element, "Extension") ?? "").toLowerCase(), attribute(element, "ContentType") ?? "")
		if (element.local === "Override")
			overrides.set((attribute(element, "PartName") ?? "").toLowerCase(), attribute(element, "ContentType") ?? "")
	}

	return { defaults, overrides }
}

const UNIQUE_IDS = /\bw14:paraId="([^"]+)"|<w:sdtPr\b(?:(?!<\/w:sdtPr>)[\s\S])*?<w:id w:val="([^"]+)"|<wp:docPr\b[^>]*?\bid="([^"]+)"/g

// A text box's mc:Fallback (its VML) repeats its mc:Choice's content, ids included, as Word writes it
// (write/checks/forms.ts): only the content outside fallbacks counts.
export function withoutFallbacks(xml: string): string {
	const out: string[] = []
	let at = 0
	let depth = 0
	const tags = /<(\/?)mc:Fallback\b[^>]*?(\/?)>/g

	for (const tag of xml.matchAll(tags)) {
		const index = tag.index
		const closing = tag[1] === "/"
		const empty = tag[2] === "/"

		if (empty) {
			if (depth === 0) out.push(xml.slice(at, index))
			if (depth === 0) at = index + tag[0].length

			continue
		}

		if (!closing) {
			if (depth === 0) out.push(xml.slice(at, index))

			depth++
		} else if (depth > 0) {
			depth--

			if (depth === 0) at = index + tag[0].length
		}
	}

	if (depth === 0) out.push(xml.slice(at))

	return out.join("")
}

// Ids that must be unique in a story part (w14:paraId, a content control's w:id, wp:docPr ids) seen more than
// once, by key.
export function repeatedIds(document: Uint8Array): Map<string, number> {
	const counts = new Map<string, number>()

	for (const match of withoutFallbacks(new TextDecoder().decode(document)).matchAll(UNIQUE_IDS)) {
		const key = match[1] !== undefined ? `paraId:${match[1]}` : match[2] !== undefined ? `sdt:${match[2]}` : `docPr:${match[3] ?? ""}`

		counts.set(key, (counts.get(key) ?? 0) + 1)
	}

	return new Map([...counts].filter(([, times]) => times > 1))
}
