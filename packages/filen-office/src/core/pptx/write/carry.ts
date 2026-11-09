import { partKey, type Relationship, Relationships } from "../../opc/index"
import type { CarriedRelationship } from "../../presentation/edit/ops"
import { refused, type Refused } from "../../presentation/model"
import { Namespaces, NodeKind, XmlEditor, parseXml, type XmlDocument } from "../../xml/index"
import { carryRelationship, heldRelationshipIds, heldRelationships } from "./parts"

// Pasted markup on a slide (the shape op "paste"): the relationships it names in the part it was copied from are given
// to the slide it lands on, each under an id the slide has free, and the markup's relationship attributes (r:embed,
// r:link, r:id… under any prefix bound to the relationships namespace) renamed to match. ECMA-376 Part 2 §9.3: an id is
// unique within its part's relationships, so the copied ids mean nothing on another slide until they are given.

const RELATIONSHIP_NAMESPACES: ReadonlySet<string> = new Set([
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships",
	"http://purl.oclc.org/ooxml/officeDocument/relationships"
])

// Every relationship attribute of the markup's elements: [element, qualified name, id].
function relationshipAttributes(document: XmlDocument): [number, string, string][] {
	const namespaces = new Namespaces(document, { lenient: true })
	const out: [number, string, string][] = []

	for (let node = 0; node < document.count; node++) {
		if (document.kinds[node] !== NodeKind.Element || document.attributeSpans(node).length === 0) continue

		for (const attribute of document.attributes(node)) {
			const colon = attribute.name.indexOf(":")

			if (colon <= 0 || attribute.value === "") continue

			const prefix = attribute.name.slice(0, colon)

			if (prefix !== "xmlns" && RELATIONSHIP_NAMESPACES.has(namespaces.uri(node, prefix) ?? ""))
				out.push([node, attribute.name, attribute.value])
		}
	}

	return out
}

// The relationship ids markup names (one self-contained element, its namespaces declared on it).
export function namedRelationshipIds(raw: Uint8Array): Set<string> {
	return new Set(relationshipAttributes(parseXml(raw)).map(([, , id]) => id))
}

// The markup with its relationship ids renamed by `rename` (ids it does not list kept).
export function renameRelationshipIds(raw: Uint8Array, rename: ReadonlyMap<string, string>): Uint8Array {
	if (rename.size === 0) return raw

	const document = parseXml(raw)
	const editor = new XmlEditor(document)

	for (const [node, name, id] of relationshipAttributes(document)) {
		const to = rename.get(id)

		if (to !== undefined) editor.setAttribute(node, name, to)
	}

	return editor.changed ? editor.serialize() : raw
}

// The slide's relationships with the ones held for it (released by a save for an undo, carried for a paste): what its
// held markup names until a save writes them.
export function withHeldRelationships(deck: object, part: string, base: Relationships): Relationships {
	const held = heldRelationships(deck, part)

	if (held.size === 0) return base

	const extra: Relationship[] = []

	for (const [id, entry] of held) {
		if (base.byId(id) !== undefined) continue

		const name = entry.name.startsWith("/") ? entry.name.slice(1) : entry.name

		extra.push({ id, type: entry.type, target: entry.name, external: entry.external, partName: entry.external ? undefined : name })
	}

	return extra.length === 0 ? base : new Relationships([...base.all, ...extra])
}

export interface CarryInput {
	readonly deck: object
	// The slide part (a model name, "/ppt/slides/slide2.xml").
	readonly part: string
	// Its relationships in the package (none for a slide the session made).
	readonly relationships: Relationships
	// Whether this deck has a part by that name now (the package's, or one a save let go of whose bytes are held).
	readonly has: (name: string) => boolean
	// A name of this deck's own for a part of another deck (its stem and extension kept, its number a free one).
	readonly name: (like: string) => string
}

const ID = /^[A-Za-z_][\w.-]*$/u

function sameTarget(relationship: Relationship, type: string, target: string, external: boolean): boolean {
	return (
		relationship.type === type &&
		relationship.external === external &&
		(external ? relationship.target === target : partKey(relationship.partName ?? "") === partKey(target))
	)
}

// The relationships given to the slide and the markup renamed to the ids they took. A relationship the slide has under
// the same id keeps it; one whose id the slide holds for another target takes the next free "rIdN".
export function carryRelationships(
	input: CarryInput,
	raws: readonly Uint8Array[],
	relationships: readonly CarriedRelationship[]
): { readonly raws: readonly Uint8Array[]; readonly relationships: readonly CarriedRelationship[] } | Refused {
	const held = heldRelationships(input.deck, input.part)
	const taken = new Set<string>([
		...input.relationships.all.map(relationship => relationship.id),
		...heldRelationshipIds(input.deck, input.part)
	])
	let highest = 0

	for (const id of taken) {
		const numbered = /^rId(\d+)$/u.exec(id)

		if (numbered !== null) highest = Math.max(highest, Number(numbered[1]))
	}

	const free = (): string => {
		let id = `rId${String(++highest)}`

		while (taken.has(id)) id = `rId${String(++highest)}`

		return id
	}
	const rename = new Map<string, string>()
	const out: CarriedRelationship[] = []
	const seen = new Set<string>()

	for (const relationship of relationships) {
		const external = relationship.external === true

		if (!ID.test(relationship.id) || seen.has(relationship.id)) return refused("malformed", "a pasted relationship id")
		if (relationship.target === "") return refused("malformed", "a pasted relationship target")

		seen.add(relationship.id)

		const own = held.get(relationship.id)
		// A part of another deck comes with its bytes: named in this deck, unless the op as applied names it already.
		const placed =
			!external &&
			relationship.bytes !== undefined &&
			own !== undefined &&
			!own.external &&
			partKey(own.name) === partKey(relationship.target)
		let target = relationship.target

		if (!external && relationship.bytes !== undefined && !placed) target = input.name(relationship.target)
		if (!external && relationship.bytes === undefined && !input.has(target))
			return refused("stale", `the pasted part ${relationship.target} is not in the deck`)

		const base = input.relationships.byId(relationship.id)
		let id = relationship.id

		if (base === undefined || !sameTarget(base, relationship.type, target, external)) {
			const ownSame =
				own !== undefined &&
				own.type === relationship.type &&
				own.external === external &&
				(external ? own.name === target : partKey(own.name) === partKey(target))

			if (base !== undefined || (taken.has(id) && !ownSame)) id = free()

			carryRelationship(input.deck, input.part, id, {
				type: relationship.type,
				target,
				external,
				...(relationship.contentType === undefined ? {} : { contentType: relationship.contentType }),
				...(relationship.bytes === undefined ? {} : { bytes: relationship.bytes })
			})
			taken.add(id)
		}

		if (id !== relationship.id) rename.set(relationship.id, id)

		out.push({ ...relationship, id, target })
	}

	try {
		return { raws: raws.map(raw => renameRelationshipIds(raw, rename)), relationships: out }
	} catch {
		return refused("malformed", "pasted markup")
	}
}
