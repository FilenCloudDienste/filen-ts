import { Namespaces, XmlEditor, encodeUtf8, escapeAttribute, parseXml, type XmlDocument } from "../xml/index"
import { OpcError } from "./errors"
import { resolvePartName } from "./partNames"

export const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships"

export interface Relationship {
	readonly id: string
	readonly type: string
	// As written: percent-encoded, relative to the source part, possibly with a fragment.
	readonly target: string
	readonly external: boolean
	// The internal target part (no leading "/"); undefined for external targets and targets that leave the
	// package. External targets are never fetched: they are kept only to be written back.
	readonly partName: string | undefined
}

export class Relationships {
	readonly all: readonly Relationship[]
	private readonly byIdMap = new Map<string, Relationship>()

	constructor(all: readonly Relationship[]) {
		this.all = all

		// Repeated ids are invalid, but readers keep the first and so do we.
		for (const relationship of all) {
			if (!this.byIdMap.has(relationship.id)) this.byIdMap.set(relationship.id, relationship)
		}
	}

	byId(id: string): Relationship | undefined {
		return this.byIdMap.get(id)
	}

	byType(type: string): Relationship[] {
		return this.all.filter(relationship => relationship.type === type)
	}
}

// Relationships of `sourcePart` ("" for the package) from its .rels part.
function relationshipsRoot(bytes: Uint8Array, sourcePart: string): { document: XmlDocument; namespaces: Namespaces; root: number } {
	const document = parseXml(bytes)
	const namespaces = new Namespaces(document)
	const root = document.documentElement()

	if (!namespaces.is(root, RELATIONSHIPS_NAMESPACE, "Relationships")) {
		throw new OpcError("invalidRelationships", `Relationships of ${sourcePart || "the package"} have no Relationships root`)
	}

	return { document, namespaces, root }
}

export function parseRelationships(bytes: Uint8Array, sourcePart: string): Relationships {
	const { document, namespaces, root } = relationshipsRoot(bytes, sourcePart)

	const all: Relationship[] = []

	for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
		if (!namespaces.is(node, RELATIONSHIPS_NAMESPACE, "Relationship")) continue

		const id = document.attribute(node, "Id")
		const type = document.attribute(node, "Type")
		const target = document.attribute(node, "Target")

		if (id === undefined || type === undefined || target === undefined) {
			throw new OpcError("invalidRelationships", "Relationship without Id, Type or Target")
		}

		const external = document.attribute(node, "TargetMode") === "External"

		all.push({ id, type, target, external, partName: external ? undefined : resolvePartName(sourcePart, target) })
	}

	return new Relationships(all)
}

export interface NewRelationship {
	readonly type: string
	// Relative to the source part, percent-encoded (see relativeTarget), or an external URL.
	readonly target: string
	readonly external?: boolean
}

// Ids numbered past this are only taken, not counted on: counting on from them would leave the safe integers,
// where adding one no longer makes a new number.
const COUNTED_ID_LIMIT = 2 ** 52

// New relationship ids for a part: each the next free "rId<n>" above every numeric id taken. One numbered past
// what counting can reach (COUNTED_ID_LIMIT) is only taken.
export class RelationshipIds {
	private readonly taken = new Set<string>()
	private highest = 0

	take(id: string): void {
		this.taken.add(id)

		const numbered = /^rId(\d+)$/.exec(id)
		const value = numbered === null ? Number.NaN : Number(numbered[1])

		if (value <= COUNTED_ID_LIMIT) this.highest = Math.max(this.highest, value)
	}

	next(): string {
		let id = `rId${String(++this.highest)}`

		while (this.taken.has(id)) id = `rId${String(++this.highest)}`

		this.taken.add(id)

		return id
	}
}

const EMPTY_RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}"></Relationships>`

// A .rels part (`bytes`, or a new one when null) with relationships appended. Each gets the next free
// "rId<n>" above every existing numeric id (`removals` included, RelationshipIds), which `ids` returns in order. Existing bytes
// are kept, but for the relationships whose ids `removals` holds.
export function addRelationships(
	bytes: Uint8Array | null,
	additions: readonly NewRelationship[],
	removals: ReadonlySet<string> = new Set()
): { bytes: Uint8Array; ids: string[] } {
	const { document, namespaces, root } = relationshipsRoot(bytes ?? encodeUtf8(EMPTY_RELATIONSHIPS), "")
	const editor = new XmlEditor(document)
	const allocated = new RelationshipIds()

	for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
		const id = document.attribute(node, "Id")

		if (id === undefined) continue

		allocated.take(id)

		if (removals.has(id)) editor.remove(node)
	}

	const prefix = namespaces.prefixFor(root, RELATIONSHIPS_NAMESPACE) ?? ""
	const name = prefix === "" ? "Relationship" : `${prefix}:Relationship`
	const ids: string[] = []

	for (const addition of additions) {
		const id = allocated.next()

		ids.push(id)
		editor.append(
			root,
			`<${name} Id="${id}" Type="${escapeAttribute(addition.type)}" Target="${escapeAttribute(addition.target)}"${addition.external === true ? ' TargetMode="External"' : ""}/>`
		)
	}

	return { bytes: editor.serialize(), ids }
}
