import type { XmlDocument } from "../../xml/index"
import { canonical } from "./digest"

// Style sheets compared across translations: style ids by name, and each style as its chain states it.

export function styleElement(styles: XmlDocument, id: string): number {
	const root = styles.documentElement()

	for (let child = styles.firstChildElement(root); child >= 0; child = styles.nextSiblingElement(child))
		if (styles.localName(child) === "style" && styles.attribute(child, "w:styleId") === id) return child

	return -1
}

// Style ids to their names (lower case: Word matches names so), what a style is across translations.
// Whether two style sheets name every style id alike (both absent counts).
export function sameNames(a: XmlDocument | undefined, b: XmlDocument | undefined): boolean {
	if (a === undefined || b === undefined) return a === b

	const x = styleNames(a)
	const y = styleNames(b)

	if (x.size !== y.size) return false

	for (const [id, name] of x) if (y.get(id) !== name) return false

	return true
}

export function styleNames(styles: XmlDocument): Map<string, string> {
	const out = new Map<string, string>()
	const root = styles.documentElement()

	for (let child = styles.firstChildElement(root); child >= 0; child = styles.nextSiblingElement(child)) {
		if (styles.localName(child) !== "style") continue

		const id = styles.attribute(child, "w:styleId") ?? ""
		const name = childNamed(styles, child, "name")

		out.set(id, (name < 0 ? id : (styles.attribute(name, "w:val") ?? id)).toLowerCase())
	}

	return out
}

export function idOfName(styles: XmlDocument, name: string): string | undefined {
	for (const [id, styleName] of styleNames(styles)) if (styleName === name) return id

	return undefined
}

// A style's chain: the styles it is based on, the first of them first, then the style itself.
export function styleChain(styles: XmlDocument, node: number): number[] {
	const chain = [node]

	for (let at = node; ;) {
		const basedOn = childNamed(styles, at, "basedOn")
		const base = basedOn < 0 ? -1 : styleElement(styles, styles.attribute(basedOn, "w:val") ?? "")

		if (base < 0 || chain.includes(base)) return chain.reverse()

		chain.push(base)
		at = base
	}
}

// Properties the chain gives (`local`: pPr or rPr), canonical: a style's own property replaces its base's,
// w:spacing and w:ind attribute by attribute (a first line and a hanging indent replace each other).
function chainProperties(styles: XmlDocument, chain: readonly number[], local: string): string {
	const elements = new Map<string, string>()
	const merged = new Map<string, Map<string, string>>()

	for (const node of chain) {
		const container = childNamed(styles, node, local)

		for (let child = container < 0 ? -1 : styles.firstChildElement(container); child >= 0; child = styles.nextSiblingElement(child)) {
			const form = canonical(styles, child)
			const name = styles.localName(child)

			// Theme fonts alone say nothing (as canonical() leaves them out of a container).
			if (form === "<rFonts>") continue

			if (name !== "spacing" && name !== "ind") {
				elements.set(name, form)
				continue
			}

			const attributes = merged.get(name) ?? new Map<string, string>()
			const head = /^<[^\s>]+([^>]*)>/u.exec(form)?.[1] ?? ""

			for (const match of head.matchAll(/(\S+?)="([^"]*)"/gu)) {
				const attribute = match[1] ?? ""

				if (attribute === "w:firstLine") attributes.delete("w:hanging")
				if (attribute === "w:hanging") attributes.delete("w:firstLine")

				attributes.set(attribute, match[2] ?? "")
			}

			merged.set(name, attributes)
		}
	}

	for (const [name, attributes] of merged) {
		const list = [...attributes].map(([attribute, value]) => `${attribute}="${value}"`).sort()

		elements.set(name, `<${name}${list.length === 0 ? "" : ` ${list.join(" ")}`}>`)
	}

	return [...elements.values()].sort().join("")
}

// What a style is: its type, what it is based on (by name), and the paragraph and run properties it gives with
// its chain (RTF states a style whole, a docx style inherits from its w:basedOn: the two agree on these).
export function styleDefinition(styles: XmlDocument, id: string, names: XmlDocument): string | undefined {
	const node = styleElement(styles, id)

	if (node < 0) return undefined

	const byName = styleNames(names)
	const basedOn = childNamed(styles, node, "basedOn")
	const parent = basedOn < 0 ? null : (byName.get(styles.attribute(basedOn, "w:val") ?? "") ?? null)
	const chain = styleChain(styles, node)

	return JSON.stringify([
		styles.attribute(node, "w:type"),
		// Based on Normal (\\s0) or on nothing: the same in RTF, where the style sheet may not name \\s0.
		parent === "normal" ? null : parent,
		chainProperties(styles, chain, "pPr"),
		chainProperties(styles, chain, "rPr")
	])
}

export function childNamed(document: XmlDocument, node: number, local: string): number {
	if (node < 0) return -1

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
		if (document.localName(child) === local) return child

	return -1
}
