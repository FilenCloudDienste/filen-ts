import type { TextBodyProps } from "../../drawingml/displayList"
import { drawingReader } from "../../drawingml/reader"
import { readBodyProps } from "../../drawingml/text"
import { Relationships, type Relationship } from "../../opc/index"
import { readTextBody, type ReadContext } from "../../pptx/read/drawing"
import { styleOf } from "../../pptx/read/slide"
import { G, partReader, type PartReader } from "../../pptx/read/xml"
import type { XmlDocument } from "../../xml/index"
import { classifyAction } from "../actions"
import { DeckTally } from "../budget"
import type { Deck, ShapeNode, SlideNode, TextBody } from "../model"
import type { RenderServices } from "./services"

// The text of a SmartArt diagram's cached drawing (dsp:sp dsp:txBody), laid out by the text adapter like a slide
// shape's: read into the model's TextBody, styled by the dsp:sp's own style reference (its font and colour), in the
// box the drawing gives it (dsp:txXfrm, else the geometry's text rectangle).

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
		const style = styleOf(reader, sp < 0 ? -1 : reader.child(sp, G.Dsp, "style"))
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
}
