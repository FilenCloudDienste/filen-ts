import { partKey, type Relationship, Relationships } from "../../opc/index"
import type { CarriedPart, CarriedRelationship } from "../../presentation/edit/ops"
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

// The data part's drawing reference (dsp:dataModelExt@relId, MS-ODRAWXML §2.3.4: an id of the slide's relationships)
// renamed by `rename`; undefined when it names none of them.
function renameDrawingReference(bytes: Uint8Array, rename: ReadonlyMap<string, string>): Uint8Array {
	if (rename.size === 0) return bytes

	const document = parseXml(bytes)
	const editor = new XmlEditor(document)

	for (let node = 0; node < document.count; node++) {
		if (document.kinds[node] !== NodeKind.Element || document.localName(node) !== "dataModelExt") continue

		for (const attribute of document.attributes(node)) {
			const to = attribute.name === "relId" ? rename.get(attribute.value) : undefined

			if (to !== undefined) editor.setAttribute(node, "relId", to)
		}
	}

	return editor.changed ? editor.serialize() : bytes
}

const DIAGRAM_DATA = /\/diagramData$/u

// The relationships given to the slide and the markup renamed to the ids they took. A relationship the slide has under
// the same id keeps it; one whose id the slide holds for another target takes the next free "rIdN". A carried tree
// (a pasted chart, diagram, embedded object or ink) is named anew in this deck, part by part, and each part is given the
// relationships it had (held for it as their owner until a save writes it); a redo keeps the names it took.
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
	const placedOut: { relationship: CarriedRelationship; id: string; target: string; tree?: CarriedPart[]; carry: boolean }[] = []
	const seen = new Set<string>()

	for (const relationship of relationships) {
		const external = relationship.external === true
		const tree = relationship.tree

		if (!ID.test(relationship.id) || seen.has(relationship.id)) return refused("malformed", "a pasted relationship id")
		if (relationship.target === "") return refused("malformed", "a pasted relationship target")
		if (
			tree !== undefined &&
			(external ||
				relationship.bytes === undefined ||
				tree.length === 0 ||
				partKey(tree[0]?.name ?? "") !== partKey(relationship.target))
		)
			return refused("malformed", "a pasted part tree")

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

		let named: CarriedPart[] | undefined

		if (tree !== undefined) {
			// Every part of the tree under a name of this deck (the target's taken above), its links to them renamed.
			const names = new Map<string, string>([[partKey(relationship.target), target]])

			for (const part of tree.slice(1)) {
				if (names.has(partKey(part.name))) return refused("malformed", "a pasted part tree names a part twice")

				names.set(partKey(part.name), placed ? part.name : input.name(part.name))
			}

			named = []

			for (const part of tree) {
				const links: CarriedPart["links"][number][] = []

				for (const link of part.links) {
					if (link.external === true) {
						links.push({ id: link.id, type: link.type, target: link.target, external: true })

						continue
					}

					const to = names.get(partKey(link.target))

					if (to === undefined || !ID.test(link.id)) return refused("malformed", "a pasted part tree relates outside itself")

					links.push({ id: link.id, type: link.type, target: to })
				}

				named.push({ name: names.get(partKey(part.name)) ?? part.name, contentType: part.contentType, bytes: part.bytes, links })
			}
		}

		const base = input.relationships.byId(relationship.id)
		let id = relationship.id
		let carry = false

		if (base === undefined || !sameTarget(base, relationship.type, target, external)) {
			const ownSame =
				own !== undefined &&
				own.type === relationship.type &&
				own.external === external &&
				(external ? own.name === target : partKey(own.name) === partKey(target))

			if (base !== undefined || (taken.has(id) && !ownSame)) id = free()

			taken.add(id)
			carry = true
		}

		if (id !== relationship.id) rename.set(relationship.id, id)

		placedOut.push({ relationship, id, target, ...(named === undefined ? {} : { tree: named }), carry })
	}

	const out: CarriedRelationship[] = []

	try {
		for (const entry of placedOut) {
			const { relationship, id, target } = entry
			// A diagram's data part names its drawing by the slide's id for it.
			const tree = entry.tree?.map(part =>
				DIAGRAM_DATA.test(relationship.type) && part.name === target
					? { ...part, bytes: renameDrawingReference(part.bytes, rename) }
					: part
			)
			const bytes = tree?.[0]?.bytes ?? relationship.bytes
			const accompanies = relationship.with === undefined ? undefined : (rename.get(relationship.with) ?? relationship.with)

			if (entry.carry) {
				carryRelationship(input.deck, input.part, id, {
					type: relationship.type,
					target,
					external: relationship.external === true,
					...(relationship.contentType === undefined ? {} : { contentType: relationship.contentType }),
					...(bytes === undefined ? {} : { bytes }),
					...(accompanies === undefined ? {} : { with: accompanies })
				})
			}

			// Each part of the tree holds its own relationships, with the bytes of the parts they reach.
			for (const part of tree ?? [])
				for (const link of part.links) {
					const reached = link.external === true ? undefined : tree?.find(each => each.name === link.target)

					carryRelationship(input.deck, part.name, link.id, {
						type: link.type,
						target: link.target,
						external: link.external === true,
						...(reached === undefined ? {} : { bytes: reached.bytes, contentType: reached.contentType })
					})
				}

			out.push({
				...relationship,
				id,
				target,
				...(bytes === undefined ? {} : { bytes }),
				...(tree === undefined ? {} : { tree }),
				...(accompanies === undefined ? {} : { with: accompanies })
			})
		}

		return { raws: raws.map(raw => renameRelationshipIds(raw, rename)), relationships: out }
	} catch {
		return refused("malformed", "pasted markup")
	}
}
