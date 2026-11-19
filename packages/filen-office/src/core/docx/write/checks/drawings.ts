import { joinBytes } from "../../../opc/index"
import { NodeKind, decodeUtf8, type XmlDocument } from "../../../xml/index"
import { partReader } from "../../model/reader"
import { Ns } from "../../model/namespaces"
import { sniffImage } from "../../objects/images"
import { DocxVerifyError } from "../failure"
import type { CheckInput, DocxCheck } from "./index"

// Drawings the save added (new drawing ids; gate 2 counts docPr ids for duplicates itself): extents and ids
// in range. Every crop (a:srcRect) the save wrote leaves something of its picture on each axis. Every
// picture relationship the save added points at a part typed as a picture, and every picture part it added
// holds the picture its content type says. Drawings copied from the source are left as they were, whatever
// their values (a crop too, written again as the source has it).

// ST_PositiveCoordinate, ST_DrawingElementId.
const MAX_COORDINATE = 27273042316900
const MAX_DRAWING_ID = 4294967295
const INTEGER = /^\d+$/
const SIGNED = /^-?\d+$/
// ST_Percentage: 100000 is the whole side.
const WHOLE = 100000

// Whether a:srcRect `node` leaves part of its picture on both axes, its sides whole numbers.
function sensibleSrcRect(reader: ReturnType<typeof partReader>, node: number): boolean {
	const sides = ["l", "t", "r", "b"].map(name => reader.attr(node, Ns.None, name) ?? "0")

	if (!sides.every(side => SIGNED.test(side))) return false

	const [l, t, r, b] = sides.map(Number)

	return (l ?? 0) + (r ?? 0) < WHOLE && (t ?? 0) + (b ?? 0) < WHOLE
}

// The markup of element `node` as written.
function markupOf(document: XmlDocument, node: number): string {
	return decodeUtf8(document.bytes, document.start(node), document.end(node))
}

function inRange(value: string | undefined, max: number): boolean {
	return value !== undefined && INTEGER.test(value) && Number(value) <= max
}

// The r:embed ids of every picture (a:blip, svgBlip) in `document`.
function blipEmbeds(document: XmlDocument): Set<string> {
	const reader = partReader(document)
	const ids = new Set<string>()

	for (let node = 0; node < document.count; node++) {
		if (document.kinds[node] !== NodeKind.Element) continue

		const local = document.localName(node)

		if (!((reader.group(node) === Ns.A && local === "blip") || local === "svgBlip")) continue

		const id = reader.attr(node, Ns.R, "embed")

		if (id !== undefined) ids.add(id)
	}

	return ids
}

// Drawing ids (as written) whose drawing has values out of range, per save, for done() to match with the ids
// the save added.
const outOfRange = new WeakMap<CheckInput, Set<string>>()

export const drawingChecks: readonly DocxCheck[] = [
	{
		newMarkupOnly: true,
		async part(input, checked) {
			// Copies of source nodes are what they were; only the save's own markup is looked at.
			if (checked.part === undefined || (!checked.skeleton && input.original.has(checked.name))) return

			const document = checked.document
			const reader = partReader(document)
			const added = new Set<string>()
			// The source part's markup, read only when a crop that leaves nothing is to be told from a copy.
			let sourceText: string | undefined
			const source = input.original.has(checked.name) ? await input.original.relationships(checked.name) : undefined
			const written = await input.relationshipsOf(checked.name)

			for (let node = 0; node < document.count; node++) {
				if (document.kinds[node] !== NodeKind.Element) continue

				const group = reader.group(node)
				const local = document.localName(node)

				if (group === Ns.WP && (local === "inline" || local === "anchor")) {
					const extent = reader.child(node, Ns.WP, "extent")
					const docPr = reader.child(node, Ns.WP, "docPr")
					const id = docPr < 0 ? undefined : reader.attr(docPr, Ns.None, "id")
					const valid =
						extent >= 0 &&
						inRange(reader.attr(extent, Ns.None, "cx"), MAX_COORDINATE) &&
						inRange(reader.attr(extent, Ns.None, "cy"), MAX_COORDINATE) &&
						inRange(id, MAX_DRAWING_ID)

					if (!valid) {
						let found = outOfRange.get(input)

						if (found === undefined) {
							found = new Set()
							outOfRange.set(input, found)
						}

						found.add(id ?? "")
					}
				} else if (group === Ns.A && local === "srcRect") {
					if (sensibleSrcRect(reader, node)) continue

					const source = checked.part !== undefined && input.original.has(checked.name) ? checked.part.document : undefined

					sourceText ??= source === undefined ? "" : decodeUtf8(source.bytes, 0, source.bytes.length)

					if (!sourceText.includes(markupOf(document, node)))
						throw new DocxVerifyError("content", `${checked.name}: a picture crop leaves nothing of it`)
				} else if ((group === Ns.A && local === "blip") || local === "svgBlip") {
					const id = reader.attr(node, Ns.R, "embed")

					if (id !== undefined && source?.byId(id) === undefined) added.add(id)
				}
			}

			// The source's own pictures whose relationship it lacks, read only when one is still missing as written.
			let danglingInSource: Set<string> | undefined

			for (const id of added) {
				const relationship = written.byId(id)

				if (relationship === undefined && checked.part !== undefined && source !== undefined) {
					danglingInSource ??= blipEmbeds(checked.part.document)

					// A copy of a picture the source already left without its part (as gate 2 allows a dangling id).
					if (danglingInSource.has(id)) continue
				}

				const type = relationship?.partName === undefined ? undefined : input.types.typeOf(relationship.partName)

				if (relationship === undefined || relationship.external || type?.toLowerCase().startsWith("image/") !== true)
					throw new DocxVerifyError("relationship", `${checked.name}: picture ${id} does not point at a picture part`)
			}
		},
		async done(input) {
			const problems = outOfRange.get(input)

			if (problems !== undefined) {
				for (const id of input.added("docPr")) {
					if (problems.has(id)) throw new DocxVerifyError("content", `A new drawing (${id}) has an extent or id out of range`)
				}
			}

			for (const change of input.changes.add) {
				const type = input.types.typeOf(change.name)?.toLowerCase()

				if (type?.startsWith("image/") !== true) continue

				const image = sniffImage(await joinBytes(change.bytes))

				if (typeof image === "string" || image.contentType !== type)
					throw new DocxVerifyError("contentType", `${change.name} does not hold the ${type} picture it is typed as`)
			}
		}
	}
]
