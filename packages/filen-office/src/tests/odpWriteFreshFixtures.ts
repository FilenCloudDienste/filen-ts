import { bytesSource, memorySink } from "@filen/office/core/opc"
import { openPptx, type PptxParts } from "../core/pptx/package"
import { readBlipFill, readEffects, readFill, readLine, type ReadContext } from "../core/pptx/read/drawing"
import { G, partReader } from "../core/pptx/read/xml"
import { writeFreshOdp, type FreshOdpServices, type FreshReport } from "../core/odp/write/fresh"
import { themeOf } from "../core/presentation/theme"
import type { Deck, Geometry, Refused } from "../core/presentation/model"

// A pptx deck converted by the fresh ODP writer, with the services a pptx source gives it (its themes, its shapes'
// DrawingML groups read as the model's types, its pictures' bytes).

export function pptxServices(deck: Deck, parts: PptxParts): FreshOdpServices {
	const contexts = new Map<string, ReadContext>()
	const relationships = new Map<string, Awaited<ReturnType<PptxParts["opc"]["relationships"]>>>()
	const contextOf = (part: string): ReadContext | undefined => {
		const held = contexts.get(part)

		if (held !== undefined) return held

		const document = parts.document(part)
		const rels = relationships.get(part)

		if (document === undefined || rels === undefined) return undefined

		const context: ReadContext = {
			reader: partReader(document),
			part,
			epoch: parts.epoch,
			relationships: rels,
			tally: parts.tally,
			action: () => undefined
		}

		contexts.set(part, context)

		return context
	}

	return {
		documents: { document: part => parts.document(part) },
		theme: node => {
			const theme = themeOf(deck.nodes, node)

			return theme === undefined ? undefined : parts.theme(theme.part)
		},
		group(kind, src) {
			if (src.format !== "pptx") return undefined

			const context = contextOf(src.part)

			if (context === undefined) return undefined

			switch (kind) {
				case "fill":
					return readFill(context, src.node)
				case "ln":
					return readLine(context, src.node)
				case "effects":
					return readEffects(context, src.node)
				case "geometry": {
					const reader = context.reader

					if (reader.local(src.node) !== "prstGeom") return undefined

					const geometry: Geometry = { kind: "preset", preset: reader.attr(src.node, "prst") ?? "rect", guides: [] }

					return geometry
				}
			}
		},
		pictureFill(shape) {
			const src = shape.src

			if (src?.format !== "pptx") return undefined

			const context = contextOf(src.part)

			if (context === undefined) return undefined

			const fill = context.reader.child(src.node, G.P, "blipFill")

			return fill < 0 ? undefined : readBlipFill(context, fill)
		},
		async picture(part) {
			if (!parts.opc.has(part)) return undefined

			return { bytes: await parts.opc.read(part), mediaType: parts.contentTypes.typeOf(part.slice(1)) ?? "" }
		},
		preload: async () => {
			for (const node of deck.nodes.values()) {
				if (node.part === "" || relationships.has(node.part) || !parts.opc.has(node.part)) continue

				relationships.set(node.part, await parts.opc.relationships(node.part.slice(1)))
			}
		}
	} as FreshOdpServices & { preload(): Promise<void> }
}

export async function freshFromPptx(bytes: Uint8Array): Promise<{ readonly bytes: Uint8Array; readonly report: FreshReport } | Refused> {
	const opened = await openPptx(bytesSource(bytes))

	if (opened.kind !== "opened") return opened

	await opened.parts.parseAll()

	for (const ref of [...opened.deck.slides]) {
		const notes = opened.deck.nodes.get(ref)?.notes

		if (notes !== undefined) await opened.parts.slide(notes)
	}

	const services = pptxServices(opened.deck, opened.parts) as FreshOdpServices & { preload(): Promise<void> }

	await services.preload()

	const sink = memorySink()
	const written = await writeFreshOdp(opened.deck, services, sink)

	return "kind" in written ? written : { bytes: sink.bytes(), report: written.report }
}
