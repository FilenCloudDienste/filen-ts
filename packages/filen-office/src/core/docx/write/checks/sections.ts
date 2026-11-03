import { NodeKind, decodeUtf8, type XmlDocument } from "../../../xml/index"
import type { StoryPart } from "../../model/index"
import { Ns } from "../../model/namespaces"
import { partReader, type PartReader } from "../../model/reader"
import { DocxVerifyError } from "../failure"
import { ownedByCopy } from "../newStory"
import { joinBytes, type Relationship } from "../../../opc/index"
import type { CheckInput, CheckedPart, DocxCheck } from "./index"
import { sameBytes } from "../bytes"

// The section properties a save wrote (new or spliced w:sectPr; the source's, copied or written again as they
// were, are not looked at again): each header and footer reference resolves to a part of its content type that the package has, a
// section refers to at most one of each type, page size and margins leave room for text, columns fit in it,
// line numbering counts from no negative value, and a recorded change has an author and holds no references.
// A header or footer part the save creates as a copy of another (stories/clone.ts) relates what it holds as
// the original does: each relationship it keeps, by id, of the same type to the same target, or for a part a
// copy owns (a chart, an embedded object: write/newStory.ts ownedByCopy) to a part the save added holding the
// same bytes of the same content type, whose own relationships read so in turn.

const WML = "application/vnd.openxmlformats-officedocument.wordprocessingml"
const CONTENT_TYPES: Readonly<Record<string, string>> = { headerReference: `${WML}.header+xml`, footerReference: `${WML}.footer+xml` }
// ST_TwipsMeasure / ST_SignedTwipsMeasure as Word bounds a page (22 inches).
const MAX_PAGE = 31680

function fail(reason: "content" | "danglingReference" | "duplicateId", message: string): never {
	throw new DocxVerifyError(reason, message)
}

function children(document: XmlDocument, reader: PartReader, node: number, local: string): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
		if (reader.is(child, Ns.W, local)) out.push(child)

	return out
}

// The first of the rules above (bar references) a section's properties break, as text, or undefined: what gate 2
// refuses and what a command must not make.
export function sectionFault(reader: PartReader, node: number): string | undefined {
	const document = reader.document
	const number = (holder: number, local: string): number | undefined => {
		const value = reader.attr(holder, Ns.W, local)

		if (value === undefined) return undefined

		return /^-?\d{1,10}$/.test(value) ? Number(value) : Number.NaN
	}
	const size = children(document, reader, node, "pgSz")[0]
	const width = size === undefined ? 12240 : (number(size, "w") ?? 12240)
	const height = size === undefined ? 15840 : (number(size, "h") ?? 15840)

	if (!(width > 0 && height > 0 && width <= MAX_PAGE && height <= MAX_PAGE)) return `A section's page is ${width} x ${height} twips`

	const margins = children(document, reader, node, "pgMar")[0]
	const margin = (local: string, fallback: number): number => (margins === undefined ? fallback : (number(margins, local) ?? fallback))
	const text = width - margin("left", 1440) - margin("right", 1440) - margin("gutter", 0)

	if (!(text > 0 && height - Math.abs(margin("top", 1440)) - Math.abs(margin("bottom", 1440)) > 0))
		return "A section's margins leave no room for text"

	for (const columns of children(document, reader, node, "cols")) {
		const count = number(columns, "num") ?? 1
		const space = number(columns, "space") ?? 720
		const own = children(document, reader, columns, "col")
		const equal = reader.attr(columns, Ns.W, "equalWidth")

		if (!(count >= 1 && count <= 45)) return `A section has ${count} columns`

		// Unequal columns (w:equalWidth off, ECMA-376 17.6.4) are as wide as their w:col say, spaced as they say.
		if (own.length > 0 && (equal === "0" || equal === "false" || equal === "off")) {
			let total = 0

			for (let k = 0; k < own.length; k++) {
				const column = own[k] as number
				const wide = number(column, "w") ?? 0

				if (!(wide > 0)) return `A section has a column ${wide} twips wide`

				total += wide + (k < own.length - 1 ? (number(column, "space") ?? 0) : 0)
			}

			if (!(total <= text)) return `Columns ${total} twips wide do not fit a ${text} twips wide text`
		} else if (!((count - 1) * space < text)) {
			return `${count} columns ${space} twips apart do not fit a ${text} twips wide text`
		}
	}

	for (const lines of children(document, reader, node, "lnNumType")) {
		// ST_DecimalNumber; what a command writes Word bounds further (MS-OI29500 2.1.215), files have 0 (LibreOffice).
		if (!((number(lines, "countBy") ?? 0) >= 0 && (number(lines, "start") ?? 0) >= 0))
			return "A section numbers lines from a negative value"
	}

	return undefined
}

async function checkSection(input: CheckInput, part: string, reader: PartReader, node: number, nested: boolean): Promise<void> {
	const document = reader.document
	const relationships = await input.relationshipsOf(part)
	const seen = new Set<string>()

	for (const local of ["headerReference", "footerReference"] as const) {
		for (const reference of children(document, reader, node, local)) {
			if (nested) fail("content", "A recorded section change holds a header or footer reference")

			const type = reader.attr(reference, Ns.W, "type") ?? "default"
			const id = reader.attr(reference, Ns.R, "id")
			const key = `${local}:${type}`

			if (seen.has(key)) fail("duplicateId", `A section has two ${type} ${local}s`)

			seen.add(key)

			const target = id === undefined ? undefined : relationships.byId(id)
			const name = target?.partName

			if (target === undefined || target.external || name === undefined || !input.exists(name))
				fail("danglingReference", `A section's ${local} ${id ?? ""} resolves to no part`)
			if (input.types.typeOf(name) !== CONTENT_TYPES[local])
				fail(
					"danglingReference",
					`A section's ${local} ${id ?? ""} is ${name}, no ${local === "headerReference" ? "header" : "footer"}`
				)
		}
	}

	const fault = sectionFault(reader, node)

	if (fault !== undefined) fail("content", fault)

	for (const change of children(document, reader, node, "sectPrChange")) {
		if ((reader.attr(change, Ns.W, "author") ?? "") === "") fail("content", "A recorded section change has no author")

		for (const before of children(document, reader, change, "sectPr")) await checkSection(input, part, reader, before, true)
	}
}

// Whether part `copy` the save added is a copy of the original's part `source` (see above).
async function copiedPart(input: CheckInput, source: string, copy: string, seen: Set<string>): Promise<boolean> {
	const added = input.changes.add.find(change => change.name === copy)

	if (
		added === undefined ||
		input.original.has(copy) ||
		input.types.typeOf(copy) !== (await input.original.opc.contentTypes()).typeOf(source)
	)
		return false
	if (!sameBytes(await joinBytes(added.bytes), await input.original.opc.read(source))) return false
	if (seen.has(copy)) return true

	seen.add(copy)

	return await sameRelationships(input, (await input.original.relationships(source)).all, copy, seen)
}

// Whether part `name` as written relates as `kept` does (see above).
async function sameRelationships(input: CheckInput, kept: readonly Relationship[], name: string, seen: Set<string>): Promise<boolean> {
	const written = await input.relationshipsOf(name)

	for (const relationship of kept) {
		const now = written.byId(relationship.id)

		if (now === undefined || now.type !== relationship.type || now.external !== relationship.external) return false
		if (relationship.external) {
			if (now.target !== relationship.target) return false

			continue
		}

		if (relationship.partName === undefined) {
			if (now.target !== relationship.target) return false

			continue
		}

		const target = now.partName

		if (target === undefined || !input.exists(target)) return false
		if (target === relationship.partName) continue
		if (!ownedByCopy(relationship, input.original) || !(await copiedPart(input, relationship.partName, target, seen))) return false
	}

	return true
}

async function copiedRelationships(input: CheckInput, checked: CheckedPart): Promise<void> {
	const kept = checked.part?.relationships.all ?? []

	if (kept.length === 0 || input.original.has(checked.name)) return

	if (!(await sameRelationships(input, kept, checked.name, new Set())))
		fail("danglingReference", `${checked.name}: a relationship reads otherwise than in the part it was copied from`)
}

async function part(input: CheckInput, checked: CheckedPart): Promise<void> {
	await copiedRelationships(input, checked)

	if (checked.part === undefined || checked.part.name !== input.original.mainPart) return

	const document = checked.document
	const reader = partReader(document)
	let source: Set<string> | undefined

	for (let node = 0; node < document.count; node++) {
		if (document.kinds[node] !== NodeKind.Element || !reader.is(node, Ns.W, "sectPr")) continue
		// Those inside a recorded change are checked with theirs.
		if (reader.is(document.parent(node), Ns.W, "sectPrChange")) continue

		// A source section's properties written again as they were (a rewritten paragraph keeps its break).
		source ??= sourceSections(input, checked.part)

		if (source.has(decodeUtf8(document.bytes, document.start(node), document.end(node)))) continue

		await checkSection(input, checked.part.name, reader, node, false)
	}
}

// The w:sectPr markup of the source's sections, as the main part has it.
function sourceSections(input: CheckInput, part: StoryPart): Set<string> {
	const out = new Set<string>()
	const document = part.document

	for (const section of input.context.model.sections)
		if (section.document === undefined && section.sectPr >= 0)
			out.add(decodeUtf8(document.bytes, document.start(section.sectPr), document.end(section.sectPr)))

	return out
}

export const sectionChecks: readonly DocxCheck[] = [{ part }]
