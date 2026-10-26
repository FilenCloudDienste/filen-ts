import type { TextBodyProps } from "../../drawingml/displayList"
import { drawingReader } from "../../drawingml/reader"
import { readBodyProps } from "../../drawingml/text"
import { Relationships, type Relationship } from "../../opc/index"
import { readColor, readTextBody, type ReadContext } from "../../pptx/read/drawing"
import { styleOf } from "../../pptx/read/slide"
import { G, partReader, type PartReader } from "../../pptx/read/xml"
import type { XmlDocument } from "../../xml/index"
import { classifyAction } from "../actions"
import { DeckTally } from "../budget"
import type { ColorModel, Deck, ShapeNode, SlideNode, TextBody } from "../model"
import type { RenderServices } from "./services"

// The text of a SmartArt diagram's cached drawing (dsp:sp dsp:txBody), laid out by the text adapter like a slide
// shape's: read into the model's TextBody, styled by the dsp:sp's own style reference (its font and colour), in the
// box the drawing gives it (dsp:txXfrm, else the geometry's text rectangle). The text colour is the colour
// definition's for the shape's style label (§21.4.4.13 dgm:txFillClrLst, picked by the presentation point's
// presStyleIdx of presStyleCnt), as the diagram is drawn from its definitions; the cache's fontRef colour only when
// the colour definition gives none.

export interface SmartArtText {
	readonly owner: SlideNode
	readonly shape: ShapeNode
	readonly body: TextBody
	readonly bodyPr: TextBodyProps
}

// Relationship attributes a text body uses: hyperlinks and picture bullets.
const LINKED = ["id", "embed"]

function relationshipsOf(reader: PartReader, services: RenderServices, part: string, txBody: number): Relationships {
	const out: Relationship[] = []
	const seen = new Set<string>()
	const document = reader.document
	const walk = (node: number, depth: number): void => {
		if (depth > 64) return

		for (const name of LINKED) {
			const id = reader.rel(node, name)
			const found = id === undefined || seen.has(id) ? undefined : services.relationship(part, id)

			if (id === undefined || found === undefined) continue

			seen.add(id)
			out.push({
				id,
				type: found.type ?? "",
				target: found.target,
				external: found.external,
				partName: found.external || !found.target.startsWith("/") ? undefined : found.target.slice(1)
			})
		}

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) walk(child, depth + 1)
	}

	walk(txBody, 0)

	return new Relationships(out)
}

// Collects the text bodies of one drawing part as the converter meets them; `story` numbers them.
export class SmartArtTexts {
	readonly texts: SmartArtText[] = []
	private readonly deck: Deck
	private readonly owner: SlideNode
	private readonly frame: ShapeNode
	private readonly services: RenderServices
	private readonly tally = new DeckTally()

	constructor(deck: Deck, owner: SlideNode, frame: ShapeNode, services: RenderServices) {
		this.deck = deck
		this.owner = owner
		this.frame = frame
		this.services = services
	}

	// The story of `txBody` in `document` (the drawing `part`, "" for an engine layout), or undefined when it has no
	// text to lay out.
	add(document: XmlDocument, part: string, txBody: number): number | undefined {
		const reader = partReader(document)
		const relationships = relationshipsOf(reader, this.services, part, txBody)
		const deck = this.deck
		const context: ReadContext = {
			reader,
			part,
			epoch: 0,
			relationships,
			tally: this.tally,
			action: node => {
				const id = reader.rel(node, "id")
				const target = id === undefined || id === "" ? undefined : relationships.byId(id)
				const action = reader.attr(node, "action")

				return classifyAction(
					{
						...(action === undefined ? {} : { action }),
						...(target === undefined
							? {}
							: {
									target: {
										external: target.external,
										target: target.target,
										...(target.partName === undefined ? {} : { partName: `/${target.partName}` })
									}
								})
					},
					{ slideOf: name => deck.slides.find(ref => deck.nodes.get(ref)?.part === name) }
				)
			}
		}
		const body = readTextBody(context, txBody)

		if (!body.paragraphs.some(paragraph => paragraph.runs.some(run => run.kind !== "br" && run.text !== ""))) return undefined

		const sp = document.parent(txBody)
		const cached = styleOf(reader, sp < 0 ? -1 : reader.child(sp, G.Dsp, "style"))
		const color = part === "" || sp < 0 ? undefined : this.textColor(reader.attr(sp, "modelId"))
		const style = cached === undefined || color === undefined ? cached : { ...cached, font: { ...cached.font, color } }
		const bodyPrNode = reader.child(txBody, G.A, "bodyPr")

		this.texts.push({
			owner: this.owner,
			shape: {
				id: this.frame.id,
				name: this.frame.name,
				hidden: false,
				kind: "sp",
				...(style === undefined ? {} : { style }),
				text: body
			},
			body,
			bodyPr: readBodyProps(drawingReader(document), bodyPrNode)
		})

		return this.texts.length - 1
	}

	private colors: Map<string, ColorModel> | undefined

	// The colour definition's text fill of the presentation point `modelId`; built once per diagram.
	private textColor(modelId: string | undefined): ColorModel | undefined {
		if (modelId === undefined) return undefined

		this.colors ??= diagramTextColors(this.services, this.frame)

		return this.colors.get(modelId)
	}
}

// Per presentation point (modelId) with a style label, the text colour the diagram's colour definition gives it.
function diagramTextColors(services: RenderServices, frame: ShapeNode): Map<string, ColorModel> {
	const out = new Map<string, ColorModel>()
	const smartart = frame.frame?.kind === "smartart" ? frame.frame : undefined
	const data = smartart === undefined ? undefined : services.xml(smartart.data)
	const colors = smartart === undefined ? undefined : services.xml(smartart.colors)

	if (data === undefined || colors === undefined) return out

	const colorReader = partReader(colors)
	const labels = new Map<string, number>()

	for (const label of colorReader.children(colors.documentElement(), G.Dgm, "styleLbl")) {
		const name = colorReader.attr(label, "name")

		if (name !== undefined && !labels.has(name)) labels.set(name, colorReader.child(label, G.Dgm, "txFillClrLst"))
	}

	const dataReader = partReader(data)
	const points = dataReader.child(data.documentElement(), G.Dgm, "ptLst")

	for (const point of dataReader.children(points, G.Dgm, "pt")) {
		const modelId = dataReader.attr(point, "modelId")
		const props = dataReader.child(point, G.Dgm, "prSet")
		const label = props < 0 ? undefined : dataReader.attr(props, "presStyleLbl")
		const list = label === undefined ? undefined : labels.get(label)

		if (modelId === undefined || list === undefined || list < 0) continue

		const entries: number[] = []

		for (let child = colorReader.first(list); child >= 0; child = colorReader.next(child)) entries.push(child)
		if (entries.length === 0) continue

		const color = readColor(
			colorReader,
			entries[
				pickColor(
					colorReader.attr(list, "meth"),
					dataReader.int(props, "presStyleIdx") ?? 0,
					dataReader.int(props, "presStyleCnt") ?? 1,
					entries.length
				)
			] ?? -1
		)

		if (color !== undefined) out.set(modelId, color)
	}

	return out
}

// Which of `count` listed colours the `index`th of `total` styled shapes takes (§21.4.7.16 ST_ClrAppMethod): "repeat"
// runs through the list and starts over, "cycle" runs there and back, "span" (the default) spreads the list over the
// shapes; its interpolation between listed colours is drawn as the nearest one.
export function pickColor(method: string | undefined, index: number, total: number, count: number): number {
	const at = Math.max(0, Math.floor(index))

	if (count <= 1) return 0
	if (method === "repeat") return at % count

	if (method === "cycle") {
		const turn = at % (2 * (count - 1))

		return turn < count ? turn : 2 * (count - 1) - turn
	}

	return total <= 1 ? 0 : Math.min(count - 1, Math.round((Math.min(at, total - 1) / (total - 1)) * (count - 1)))
}
