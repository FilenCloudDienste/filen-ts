import type { DrawingTheme, TextBodyProps } from "../../drawingml/index"
import type { XmlDocument } from "../../xml/index"
import type { Slicing } from "../../slicing"
import type { PresentationBudgets } from "../budget"
import type { Deck, FrameRef, ShapeNode, ShapeRef, SlideNode, TextBody } from "../model"
import type { TextPage } from "../output"

// What the slide renderer reads through its host: the parsed parts (parse before touch, so every read is
// synchronous), relationships, the text engine and the SmartArt engine. The presentation worker implements it over
// the open package; tests over in-memory parts.

export interface RenderRelationship {
	// The absolute part name of an internal target ("/ppt/media/image1.png"), or the raw target of an external one
	// (never fetched).
	readonly target: string
	readonly external: boolean
	readonly type?: string
}

// One text body to lay out (the adapter of core/presentation/text): the body as the model holds it, where it sits in
// the inheritance chain and the box it gets.
export interface TextLayoutRequest {
	readonly deck: Deck
	// The slide being rendered, and the level the shape belongs to (the slide, its layout or its master).
	readonly slide: SlideNode
	readonly owner: SlideNode
	readonly shape: ShapeNode
	// The placeholders the shape inherits from, nearest first (layout, then master); empty for other shapes.
	readonly chain: readonly PlaceholderLevel[]
	readonly body: TextBody
	// bodyPr resolved attribute by attribute along the chain.
	readonly bodyPr: TextBodyProps
	// The box the text is laid out in (px): the text rectangle minus the insets, swapped for vert and vert270.
	readonly width: number
	readonly height: number
	readonly theme: DrawingTheme
	// A table cell's text: its position, so the table style's text properties apply (tcTxStyle).
	readonly cell?: { readonly row: number; readonly column: number; readonly style: TableTextStyle | undefined }
	// The body is an empty placeholder's prompt (prompts.ts), not the shape's own.
	readonly prompt?: true
}

// The text properties a table style gives a cell (a:tcTxStyle): bold, italic and the colour, as written.
export interface TableTextStyle {
	readonly bold?: boolean
	readonly italic?: boolean
	// Six hex digits, theme colours resolved.
	readonly color?: string
	readonly font?: "major" | "minor"
}

export interface TextLayoutResult {
	readonly page: TextPage
	// The laid-out height (px), for rows and autofit shapes that grow with their text.
	readonly height: number
}

export interface PlaceholderLevel {
	readonly node: SlideNode
	readonly shape: ShapeNode
}

// A SmartArt diagram without a usable drawing cache, drawn by the SmartArt engine (registered through
// engine/smartart.ts). The renderer asks only when the cache is missing.
export interface SmartArtRenderer {
	relayout(
		target: ShapeRef,
		frame: Extract<FrameRef, { kind: "smartart" }>,
		slicing: Slicing
	): Promise<{ readonly drawingXml: string } | undefined>
}

export interface RenderServices {
	// A part's XML, parsed; undefined when the package has no such part (or it is not XML).
	xml(part: string): XmlDocument | undefined
	// A relationship of `part` by id.
	relationship(part: string, id: string): RenderRelationship | undefined
	contentType(part: string): string | undefined
	// The tableStyles part the presentation relates (§19.3.3.1); "/ppt/tableStyles.xml" when absent.
	readonly tableStylesPart?: string
	// The text adapter (layoutBody); without it text bodies get no TextPage (their layers still draw).
	layoutText?(request: TextLayoutRequest): TextLayoutResult | undefined
	// A part's bytes (EMF/WMF pictures, OLE previews, to convert into the drawing); undefined when the package has no
	// such part or it is larger than `limit`. Without it metafile pictures draw as placeholders.
	bytes?(part: string, limit: number): Promise<Uint8Array | undefined>
	smartart?: SmartArtRenderer
	// The deck's hostile-input budgets (path commands, display items, shapes per slide); the defaults when absent.
	readonly budgets?: PresentationBudgets
}
