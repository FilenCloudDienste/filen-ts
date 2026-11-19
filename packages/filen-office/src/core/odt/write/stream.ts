import { BytePieces } from "../../opc/index"
import { OdfNs, elementName } from "../../odf/index"
import { Namespaces, decodeUtf8, encodeUtf8, type XmlDocument } from "../../xml/index"
import { ListIds, OdtWriteRefusal, StyleRegistry } from "./emit"
import { OdtPlan, unescape } from "./plan"

// One written stream (content.xml, styles.xml): the source's bytes with spans replaced.

// The prefixes written markup uses.
const PREFIXES = ["office", "style", "text", "table", "draw", "fo", "svg", "xlink", "dc", "meta"] as const

export interface Replacement {
	readonly start: number
	readonly end: number
	readonly text: string
	// The segment it writes (-1: before the body).
	segment?: number
}

// One stream (content.xml, styles.xml) as written: its bytes, what replaces spans of them, its new automatic styles.
export class Stream {
	readonly bytes: Uint8Array
	readonly declarations: string
	readonly registry: StyleRegistry
	readonly lists: ListIds
	readonly replacements: Replacement[] = []
	private readonly automatic: { at: number; end: number; open: string; close: string }
	readonly fontFaces: { at: number; end: number; open: string; close: string }
	readonly newFaces: string[] = []
	readonly faceNames = new Map<string, string>()
	declaredFaces: Map<string, string> | undefined
	private readonly unbound: string[] = []
	// Where the root's start tag ends ("> "): declarations go before it.
	private readonly rootTagEnd: number
	private readonly rootStart: number

	constructor(plan: OdtPlan, bytes: Uint8Array, document: XmlDocument, taken: Set<string>) {
		this.bytes = bytes

		const namespaces = new Namespaces(document)
		const root = document.documentElement()
		let declarations = ""

		// A prefix the root leaves unbound is declared on it (when written markup uses it); one it binds to another
		// namespace is declared again on each written element.
		for (const prefix of PREFIXES) {
			const uri = namespaces.uri(root, prefix)

			if (uri === undefined) this.unbound.push(prefix)
			else if (uri !== OdfNs[prefix]) declarations += ` xmlns:${prefix}="${OdfNs[prefix]}"`
		}

		this.rootTagEnd = document.openEnd(root) - 1
		this.rootStart = document.start(root)
		this.declarations = declarations
		this.registry = new StyleRegistry(taken, declarations)
		this.lists = new ListIds(() => this.registry.name("list", true))

		// Names in the stream's body, indexed per prefix as a body element is first named with it.
		this.registry.inBody = (prefix, number) => plan.quotedNumbers(bytes, prefix).has(String(number))

		const officePrefix = namespaces.prefixFor(root, OdfNs.office)
		const office = officePrefix === undefined || officePrefix === "" ? "office:" : `${officePrefix}:`
		const declared = officePrefix === undefined ? ` xmlns:office="${OdfNs.office}"` : ""
		let automatic: { at: number; end: number; open: string; close: string } | undefined
		let fontFaces: { at: number; end: number; open: string; close: string } | undefined
		let before = -1
		let faceBefore = -1

		for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
			const canonical = elementName(document, namespaces, node)

			if (canonical === "office:automatic-styles") {
				automatic = document.isSelfClosing(node)
					? {
							at: document.start(node),
							end: document.end(node),
							open: `<${document.name(node)}>`,
							close: `</${document.name(node)}>`
						}
					: { at: document.contentEnd(node), end: document.contentEnd(node), open: "", close: "" }
			} else if (canonical === "office:font-face-decls") {
				fontFaces = document.isSelfClosing(node)
					? {
							at: document.start(node),
							end: document.end(node),
							open: `<${document.name(node)}>`,
							close: `</${document.name(node)}>`
						}
					: { at: document.contentEnd(node), end: document.contentEnd(node), open: "", close: "" }
			} else if (before < 0 && (canonical === "office:body" || canonical === "office:master-styles")) {
				before = document.start(node)
			}

			if (
				faceBefore < 0 &&
				(canonical === "office:styles" ||
					canonical === "office:automatic-styles" ||
					canonical === "office:body" ||
					canonical === "office:master-styles")
			) {
				faceBefore = document.start(node)
			}
		}

		const fallback = before < 0 ? document.contentEnd(root) : before

		this.automatic = automatic ?? {
			at: fallback,
			end: fallback,
			open: `<${office}automatic-styles${declared}>`,
			close: `</${office}automatic-styles>`
		}

		const faceAt = faceBefore < 0 ? fallback : faceBefore

		this.fontFaces = fontFaces ?? {
			at: faceAt,
			end: faceAt,
			open: `<${office}font-face-decls${declared}>`,
			close: `</${office}font-face-decls>`
		}
	}

	// Every replacement, the new automatic styles and font faces included.
	all(): Replacement[] {
		const all = this.replacements.map(replacement => {
			const text = this.lists.resolve(replacement.text)

			return text === replacement.text ? replacement : { ...replacement, text }
		})
		const styles = this.registry.markup.length === 0 ? "" : this.registry.used(all.map(replacement => replacement.text))

		if (styles !== "") {
			all.push({
				start: this.automatic.at,
				end: this.automatic.end,
				text: `${this.automatic.open}${styles}${this.automatic.close}`,
				segment: -1
			})
		}

		if (this.newFaces.length > 0) {
			all.push({
				start: this.fontFaces.at,
				end: this.fontFaces.end,
				text: `${this.fontFaces.open}${this.newFaces.join("")}${this.fontFaces.close}`,
				segment: -1
			})
		}

		if (all.length > 0 && this.unbound.length > 0) {
			const used = this.unbound.filter(prefix => all.some(replacement => replacement.text.includes(`${prefix}:`)))

			if (used.length > 0) {
				all.push({
					start: this.rootTagEnd,
					end: this.rootTagEnd,
					text: used.map(prefix => ` xmlns:${prefix}="${OdfNs[prefix as (typeof PREFIXES)[number]]}"`).join(""),
					segment: -1
				})
			}
		}

		return all
	}

	// The root's start tag as written (with the declarations `all` adds to it).
	rootTag(all: readonly Replacement[]): Uint8Array {
		const tag = this.bytes.subarray(this.rootStart, this.rootTagEnd + 1)
		const added = all
			.filter(replacement => replacement.start === this.rootTagEnd && replacement.end === this.rootTagEnd)
			.map(replacement => replacement.text)
			.join("")
		const at = this.rootTagEnd - this.rootStart

		return encodeUtf8(`${decodeUtf8(tag.subarray(0, at))}${added}${decodeUtf8(tag.subarray(at))}`)
	}

	// The stream as written, as views of its bytes between the new markup (never joined: the zip writer streams
	// them); undefined when nothing changed.
	output(all: Replacement[] = this.all()): BytePieces | undefined {
		if (all.length === 0) return undefined

		// Stable by start: an insertion at a position comes before a replacement starting there.
		all.sort((a, b) => a.start - b.start || a.end - a.start - (b.end - b.start))

		const pieces: Uint8Array[] = []
		let at = 0

		for (const replacement of all) {
			if (replacement.start < at) throw new OdtWriteRefusal("internal", "overlapping rewrites")

			pieces.push(this.bytes.subarray(at, replacement.start), encodeUtf8(replacement.text))
			at = replacement.end
		}

		pieces.push(this.bytes.subarray(at))

		return BytePieces.of(pieces)
	}
}

// The font faces a stream declares, by family.
export function declaredFaces(bytes: Uint8Array): Map<string, string> {
	const out = new Map<string, string>()
	const text = decodeUtf8(bytes)

	for (const match of text.matchAll(/<[A-Za-z0-9_.-]*:?font-face\s([^>]*)>/gu)) {
		const name = /(?:^|\s)[A-Za-z0-9_.-]*:?name="([^"]*)"/u.exec(match[1] ?? "")?.[1]
		const family = /font-family="([^"]*)"/u.exec(match[1] ?? "")?.[1]

		if (name !== undefined && family !== undefined) {
			const unquoted = unescape(family).replace(/^['"]|['"]$/gu, "")

			if (!out.has(unquoted)) out.set(unquoted, unescape(name))
		}
	}

	return out
}
