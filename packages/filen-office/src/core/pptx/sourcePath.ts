import type { SourceRef } from "../presentation/model"
import { NodeKind, type XmlDocument } from "../xml/index"

// An element of one document found again in another written from it (a save's rewrite, a slide's copy): by the path
// from the root, each step an element's name and its position among same-named siblings, and for a shape its cNvPr id
// too, and for a time node its cTn id (the position then counts only siblings with that id, which a source may
// repeat).

export interface PathStep {
	readonly name: string
	readonly id: string | undefined
	readonly ordinal: number
}

const ELEMENT = NodeKind.Element

// The identity of an element among its siblings: a shape-like element's cNvPr id (a p:nv*Pr child holding a
// p:cNvPr), a time node's p:cTn id (its own p:cTn child, or its behaviour's p:cBhvr/p:cMediaNode one; unique on a
// slide, ECMA-376 §19.5.33), or undefined.
function shapeId(document: XmlDocument, node: number): string | undefined {
	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "cTn") return timeId(document, child)

		if (local === "cBhvr" || local === "cMediaNode") {
			for (let inner = document.firstChildElement(child); inner >= 0; inner = document.nextSiblingElement(inner)) {
				if (document.localName(inner) === "cTn") return timeId(document, inner)
			}
		}

		if (!local.startsWith("nv") || !local.endsWith("Pr")) continue

		for (let inner = document.firstChildElement(child); inner >= 0; inner = document.nextSiblingElement(inner)) {
			if (document.localName(inner) === "cNvPr") return document.attribute(inner, "id")
		}
	}

	return undefined
}

function timeId(document: XmlDocument, cTn: number): string | undefined {
	const id = document.attribute(cTn, "id")

	return id === undefined ? undefined : `cTn:${id}`
}

export function structuralPath(document: XmlDocument, node: number): readonly PathStep[] | undefined {
	if (node < 0 || node >= document.count || document.kind(node) !== ELEMENT) return undefined

	const steps: PathStep[] = []

	for (let at = node; at > 0 && document.kind(at) === ELEMENT; at = document.parent(at)) {
		const name = document.name(at)
		const id = shapeId(document, at)
		let ordinal = 0

		for (
			let sibling = document.firstChildElement(document.parent(at));
			sibling >= 0 && sibling !== at;
			sibling = document.nextSiblingElement(sibling)
		) {
			if (document.name(sibling) === name && (id === undefined || shapeId(document, sibling) === id)) ordinal++
		}

		steps.push({ name, id, ordinal })
	}

	return steps.reverse()
}

export function resolvePath(document: XmlDocument, path: readonly PathStep[] | undefined): number | undefined {
	if (path === undefined || path.length === 0) return undefined

	let node = document.documentElement()
	const [root, ...rest] = path

	if (root === undefined || node < 0 || document.name(node) !== root.name) return undefined

	for (const step of rest) {
		let found = -1
		let ordinal = 0

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.name(child) !== step.name) continue
			if (step.id !== undefined && shapeId(document, child) !== step.id) continue

			if (ordinal++ === step.ordinal) {
				found = child

				break
			}
		}

		if (found < 0) return undefined

		node = found
	}

	return node
}

export function isSourceRef(value: unknown): value is SourceRef {
	if (typeof value !== "object" || value === null) return false

	const ref = value as Partial<Record<keyof SourceRef, unknown>>

	return (ref.format === "pptx" || ref.format === "odp") && typeof ref.part === "string" && typeof ref.node === "number"
}

// Rewrites every `src` under `root` in place (plain model objects, arrays and maps; typed arrays are skipped).
export function visitSources(root: unknown, remap: (src: SourceRef) => SourceRef): void {
	const seen = new Set<object>()
	const visit = (value: unknown): void => {
		if (typeof value !== "object" || value === null || ArrayBuffer.isView(value) || seen.has(value)) return

		seen.add(value)

		if (Array.isArray(value)) {
			for (const item of value) visit(item)

			return
		}

		if (value instanceof Map) {
			for (const item of value.values()) visit(item)

			return
		}

		if (value instanceof Set) return

		const record = value as Record<string, unknown>

		for (const key of Object.keys(record)) {
			const field = record[key]

			if (key === "src" && isSourceRef(field)) record[key] = remap(field)
			else visit(field)
		}
	}

	visit(root)
}
