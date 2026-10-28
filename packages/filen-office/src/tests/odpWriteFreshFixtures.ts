import { bytesSource, memorySink } from "@filen/office/core/opc"
import { openPptx } from "../core/pptx/package"
import { pptxServices } from "../core/convert/presentation/pptxServices"
import { writeFreshOdp, type FreshReport } from "../core/odp/write/fresh"
import type { Refused } from "../core/presentation/model"
import { AVERAGE_MEASURER, relayoutDiagram } from "../dom/presentation/engine/smartart"

// A pptx deck converted by the fresh ODP writer, with the services a pptx source gives it (its themes, its shapes'
// DrawingML groups read as the model's types, its pictures' bytes).

export { pptxServices }

export async function freshFromPptx(bytes: Uint8Array): Promise<{ readonly bytes: Uint8Array; readonly report: FreshReport } | Refused> {
	const opened = await openPptx(bytesSource(bytes))

	if (opened.kind !== "opened") return opened

	await opened.parts.parseAll()

	for (const ref of [...opened.deck.slides]) {
		const notes = opened.deck.nodes.get(ref)?.notes

		if (notes !== undefined) await opened.parts.slide(notes)
	}

	const opc = opened.parts.opc
	// A diagram without a drawing cache is laid out by the SmartArt engine, text measured by average advances.
	const services = pptxServices(opened.deck, opened.parts, {
		relayout: async (frame, box) => {
			if (!opc.has(frame.data) || !opc.has(frame.layout)) return undefined

			const optional = async (part: string) => (part !== "" && opc.has(part) ? await opc.xml(part) : undefined)

			try {
				const sources = {
					data: await opc.xml(frame.data),
					layout: await opc.xml(frame.layout),
					style: await optional(frame.style),
					colors: await optional(frame.colors)
				}

				return relayoutDiagram(sources, box, () => AVERAGE_MEASURER).drawingXml
			} catch {
				return undefined
			}
		}
	})

	await services.preload()

	const sink = memorySink()
	const written = await writeFreshOdp(opened.deck, services, sink)

	return "kind" in written ? written : { bytes: sink.bytes(), report: written.report }
}
