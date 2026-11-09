import { relationshipKind } from "../../docx/index"
import { parseRelationships, partKey } from "../../opc/index"
import type { RawPart } from "../../presentation/edit/ops"
import { refused, type PlaceholderType, type Refused } from "../../presentation/model"
import { NodeKind, parseXml, XmlEditor } from "../../xml/index"
import { G, partReader } from "../read/xml"
import { relationshipsPartBytes, type PendingRelationship } from "./parts"

// A slide of another deck pasted with this deck's theme (PowerPoint's "Use Destination Theme"): the parts its copy
// holds (splice.ts exportSlides) made this deck's. The slide is related to `layout` and its placeholders take the
// layout's placeholder indices by type (a placeholder whose written idx the layout lacks would inherit nothing:
// MS-OI29500 §2.1.1127(b)); its jumps to slides of its deck become "next slide" jumps, as a removal writes them; its
// notes are related to this deck's notes master, or left out where the deck has none in its package.

export interface ImportTarget {
	// Model part names.
	readonly layout: string
	readonly placeholders: readonly { readonly type: PlaceholderType; readonly idx: number }[]
	readonly notesMaster?: string
}

const NEXT_SLIDE = "ppaction://hlinkshowjump?jump=nextslide"

function zip(name: string): string {
	return name.startsWith("/") ? name.slice(1) : name
}

// Placeholders that stand in for one another on another layout (PowerPoint: a title for a centred title, a body or
// content placeholder for any other content one).
function family(type: PlaceholderType): string {
	switch (type) {
		case "title":
		case "ctrTitle":
			return "title"
		case "body":
		case "obj":
		case "subTitle":
		case "chart":
		case "tbl":
		case "clipArt":
		case "dgm":
		case "media":
		case "pic":
			return "body"
		default:
			return type
	}
}

function relationshipsOf(part: RawPart): PendingRelationship[] {
	if (part.rels === undefined) return []

	return parseRelationships(part.rels, zip(part.name)).all.flatMap(relationship => {
		const target = relationship.external ? relationship.target : relationship.partName

		return target === undefined ? [] : [{ id: relationship.id, type: relationship.type, target, external: relationship.external }]
	})
}

// The slide's markup with its jumps to `jumps` made "next slide" and its placeholders given the layout's indices.
function slideMarkup(bytes: Uint8Array, jumps: ReadonlySet<string>, target: ImportTarget): Uint8Array {
	const document = parseXml(bytes)
	const r = partReader(document)
	const editor = new XmlEditor(document)
	const placeholders: { readonly node: number; readonly type: PlaceholderType; readonly idx: number; readonly written: boolean }[] = []

	for (let node = 1; node < document.count; node++) {
		if (document.kinds[node] !== NodeKind.Element) continue

		if (r.group(node) === G.A && /^hlink(Click|Hover|MouseOver)$/u.test(r.local(node))) {
			const id = r.rel(node, "id")

			if (id === undefined || !jumps.has(id)) continue

			for (const attribute of document.attributes(node))
				if (attribute.value === id && attribute.name.endsWith(":id")) editor.setAttribute(node, attribute.name, "")

			editor.setAttribute(node, "action", NEXT_SLIDE)

			continue
		}

		if (r.is(node, G.P, "ph")) {
			const idx = r.attr(node, "idx")

			placeholders.push({
				node,
				type: (r.attr(node, "type") ?? "obj") as PlaceholderType,
				idx: idx === undefined ? 0 : Number(idx),
				written: idx !== undefined
			})
		}
	}

	// Kept where the layout has its index for the same kind of placeholder; else the first unused one of its type, then
	// of its family.
	const used = new Set<number>()
	const pending = placeholders.filter(ph => {
		const same = target.placeholders.find(each => each.idx === ph.idx && family(each.type) === family(ph.type))

		if (same === undefined || used.has(same.idx)) return true

		used.add(same.idx)

		return false
	})

	// An index for one the layout has nothing for: none of the layout's (a written idx matches by idx alone, whatever
	// its type) nor the slide's.
	let spare = Math.max(0, ...target.placeholders.map(each => each.idx), ...placeholders.map(each => each.idx))

	for (const ph of pending) {
		const match =
			target.placeholders.find(each => !used.has(each.idx) && each.type === ph.type) ??
			target.placeholders.find(each => !used.has(each.idx) && family(each.type) === family(ph.type))

		if (match === undefined) {
			// Inherits from the master by type instead.
			if (target.placeholders.some(each => each.idx === ph.idx)) editor.setAttribute(ph.node, "idx", String(++spare))

			continue
		}

		used.add(match.idx)

		// An implied index falls back by type (title, the footers): written only where the layout's differs.
		if (match.idx !== ph.idx || ph.written) editor.setAttribute(ph.node, "idx", String(match.idx))
	}

	return editor.changed ? editor.serialize() : bytes
}

export function importedSlideParts(parts: readonly RawPart[], target: ImportTarget): RawPart[] | Refused {
	const slide = parts[0]

	if (slide === undefined) return refused("malformed", "a pasted slide without its part")

	try {
		const jumps = new Set<string>()
		const dropped = new Set<string>()
		const slideRels: PendingRelationship[] = []

		for (const relationship of relationshipsOf(slide)) {
			const kind = relationship.external ? "" : (relationshipKind(relationship.type) ?? "")

			if (kind === "slideLayout") slideRels.push({ ...relationship, target: zip(target.layout) })
			else if (kind === "slide") jumps.add(relationship.id)
			else if (kind === "notesSlide" && target.notesMaster === undefined) dropped.add(partKey(relationship.target))
			else slideRels.push(relationship)
		}

		const out: RawPart[] = [
			{
				name: slide.name,
				contentType: slide.contentType,
				bytes: slideMarkup(slide.bytes, jumps, target),
				...(slideRels.length === 0 ? {} : { rels: relationshipsPartBytes(zip(slide.name), slideRels) })
			}
		]

		for (const part of parts.slice(1)) {
			if (dropped.has(partKey(part.name))) continue

			const relationships = relationshipsOf(part)

			if (!relationships.some(relationship => relationshipKind(relationship.type) === "notesMaster")) {
				out.push(part)

				continue
			}

			const notesMaster = target.notesMaster

			if (notesMaster === undefined) continue

			const retargeted = relationships.map(relationship =>
				!relationship.external && relationshipKind(relationship.type) === "notesMaster"
					? { ...relationship, target: zip(notesMaster) }
					: relationship
			)

			out.push({ ...part, rels: relationshipsPartBytes(zip(part.name), retargeted) })
		}

		return out
	} catch {
		return refused("malformed", "a pasted slide's markup")
	}
}
