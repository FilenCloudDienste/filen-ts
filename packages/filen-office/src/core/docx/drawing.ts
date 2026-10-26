import { convertChart } from "../drawingml/chart/index"
import { drawingTheme, type DrawingTheme } from "../drawingml/color"
import { DrawingList } from "../drawingml/displayList"
import type { ImageResolver } from "../drawingml/picture"
import { drawingReader } from "../drawingml/reader"
import { convertGraphic, type ShapeContext } from "../drawingml/shape"
import { convertSmartArt } from "../drawingml/smartart"
import { ommlToMathTree, type MathElement, type OmmlOptions } from "../math/index"
import { MetafileCache } from "../metafile/cache"
import { MAX_METAFILE_BYTES, convertMetafile, expandMetafiles, hasMetafileImages, type MetafileConversion } from "../metafile/index"
import { OpcError, ZipError, type Relationships } from "../opc/index"
import { convertVml, type VmlPlacement } from "../vml/index"
import { XmlError, type XmlDocument } from "../xml/index"
import type { DocxModel, DrawingInfo, VmlInfo } from "./model/index"
import { RevisionView } from "./model/kinds"
import { equationView } from "./layout/objects"
import { modelAuthors } from "./layout/styles"
import { DEFAULT_COLOR_SCHEME_MAPPING, parseTheme, type Theme } from "./theme/index"

// Bridges the docx model to the shared drawing layer: w:drawing (pictures, shapes, groups, canvases,
// charts, SmartArt), VML (w:pict, w:object) and OMML. Media are resolved to part names, never read, except
// EMF/WMF pictures, which are read and converted into the drawing; external targets resolve to nothing and
// draw as placeholders.

export interface DocxDrawingOptions {
	// Draw outer shadows (a:outerShdw, v:shadow).
	readonly effects?: boolean
	readonly math?: OmmlOptions
}

export type DrawingPlaceholderReason =
	// The graphic is of a kind not drawn (ink, chartex without fallback, 3D models).
	| "unsupported"
	// A part it needs (chart, SmartArt drawing) is missing.
	| "missing"
	// A part it needs could not be parsed.
	| "malformed"
	// Conversion failed unexpectedly (a defect, or input beyond a limit the layer does not check); the
	// drawing is left out rather than failing the document.
	| "failed"

export type DocxDrawingResult =
	| {
			readonly kind: "drawing"
			readonly list: DrawingList
			// Story indices of the drawing's text boxes, in drawing order (-1 for one the model has not read).
			readonly textboxes: readonly number[]
			// Elements inside the drawing that were left out.
			readonly unsupported: number
	  }
	| { readonly kind: "placeholder"; readonly reason: DrawingPlaceholderReason }

export type DocxVmlResult =
	| {
			readonly kind: "drawing"
			readonly list: DrawingList
			readonly placement: VmlPlacement
			readonly textboxes: readonly number[]
			readonly unsupported: number
	  }
	| { readonly kind: "placeholder"; readonly reason: DrawingPlaceholderReason }

function isDocumentError(error: unknown): boolean {
	return error instanceof XmlError || error instanceof OpcError || error instanceof ZipError
}

function resolver(model: DocxModel, part: number): ImageResolver {
	return relationshipId => {
		const ref = model.mediaRef(part, relationshipId)

		return ref === undefined || ref.external || ref.partName === undefined || !model.hasMedia(ref.partName)
			? undefined
			: { partName: ref.partName, contentType: ref.contentType }
	}
}

// Images of a part that is not a story part (a chart, a SmartArt drawing), through its own relationships.
function partResolver(model: DocxModel, relationships: Relationships): ImageResolver {
	return relationshipId => {
		const relationship = relationships.byId(relationshipId)
		const partName = relationship === undefined || relationship.external ? undefined : relationship.partName

		return partName === undefined || !model.package.has(partName)
			? undefined
			: { partName, contentType: model.package.contentTypes.typeOf(partName) }
	}
}

export class DocxDrawings {
	readonly model: DocxModel
	readonly theme: DrawingTheme
	private readonly effects: boolean
	private readonly mathOptions: OmmlOptions
	// Tracked changes' authors as reviewers are numbered (their colours), once an equation shows one.
	private authors: ((name: string | undefined) => number) | undefined
	// "part:node" of each w:txbxContent -> its story.
	private textboxStories: Map<string, number> | null = null
	private readonly metafiles = new MetafileCache(partName => this.loadMetafile(partName))

	constructor(model: DocxModel, theme: DrawingTheme, options: DocxDrawingOptions = {}) {
		this.model = model
		this.theme = theme
		this.effects = options.effects ?? false
		this.mathOptions = options.math ?? {}
	}

	// Loads the document's theme part (when it has one) for scheme colours, fonts and style references.
	static async open(model: DocxModel, options: DocxDrawingOptions = {}): Promise<DocxDrawings> {
		const pkg = model.package
		const themePart = pkg.part("theme")
		let document: XmlDocument | undefined
		let theme: Theme | undefined
		let images: ImageResolver = () => undefined

		if (themePart !== undefined) {
			try {
				document = await pkg.xml(themePart)
				theme = parseTheme(document)
				images = partResolver(model, await pkg.relationships(themePart))
			} catch (error) {
				if (!isDocumentError(error)) throw error
			}
		}

		const mapping = model.settings.colorSchemeMapping ?? DEFAULT_COLOR_SCHEME_MAPPING

		return new DocxDrawings(
			model,
			drawingTheme(document, name => theme?.schemeColor(name, mapping), images),
			options
		)
	}

	private storyOf(part: number, txbxContent: number): number {
		if (this.textboxStories === null) {
			const map = new Map<string, number>()

			for (const story of this.model.stories) {
				if (story.kind !== "textbox") continue

				const node = this.model.parts[story.part]?.nodes[story.item]

				if (node !== undefined) map.set(`${story.part}:${node}`, story.index)
			}

			this.textboxStories = map
		}

		return this.textboxStories.get(`${part}:${txbxContent}`) ?? -1
	}

	private context(part: number, images: ImageResolver): ShapeContext {
		return {
			list: new DrawingList(),
			theme: this.theme,
			images,
			effects: this.effects,
			story: txbxContent => this.storyOf(part, txbxContent)
		}
	}

	// Never throws: anything unexpected becomes a "failed" placeholder.
	async drawing(info: DrawingInfo): Promise<DocxDrawingResult> {
		let result: DocxDrawingResult

		try {
			result = await this.convert(info)
		} catch {
			return { kind: "placeholder", reason: "failed" }
		}

		return result.kind === "drawing" ? { ...result, list: await this.withMetafiles(result.list) } : result
	}

	// vml() with its metafile pictures (MathType equations, legacy objects) converted. Never throws.
	async vmlDrawing(info: VmlInfo): Promise<DocxVmlResult> {
		const result = this.vml(info)

		return result.kind === "drawing" ? { ...result, list: await this.withMetafiles(result.list) } : result
	}

	// The list with its EMF/WMF images replaced by their drawings; unchanged when none converts or anything
	// fails (the images then draw as placeholders).
	private async withMetafiles(list: DrawingList): Promise<DrawingList> {
		if (!hasMetafileImages(list)) return list

		try {
			return await expandMetafiles(list, image => this.metafiles.get(image.partName))
		} catch {
			return list
		}
	}

	private async loadMetafile(partName: string): Promise<MetafileConversion | undefined> {
		const opc = this.model.package.opc
		const entry = opc.entry(partName)

		if (entry === undefined || entry.uncompressedSize > MAX_METAFILE_BYTES) return undefined

		try {
			return convertMetafile(await opc.read(partName))
		} catch (error) {
			if (!isDocumentError(error)) throw error

			return undefined
		}
	}

	private async convert(info: DrawingInfo): Promise<DocxDrawingResult> {
		const part = this.model.parts[info.part]

		if (part === undefined || info.graphicData < 0) return { kind: "placeholder", reason: "unsupported" }

		switch (info.graphic) {
			case "picture":
			case "shape":
			case "group":
			case "canvas":
			case "lockedCanvas": {
				const context = this.context(info.part, resolver(this.model, info.part))

				// The drawing layer reuses the namespaces the model resolved for the part.
				drawingReader(part.document, part.reader.namespaces)

				const result = convertGraphic(context, part.document, info.graphicData, info.width, info.height)

				return {
					kind: "drawing",
					list: result.list,
					textboxes: result.textboxes.map(node => this.storyOf(info.part, node)),
					unsupported: result.unsupported
				}
			}
			case "chart":
				return this.chart(info)
			case "smartArt":
				return this.smartArt(info)
			default:
				return { kind: "placeholder", reason: "unsupported" }
		}
	}

	private async loadPart(
		partName: string | undefined
	): Promise<{ document: XmlDocument; relationships: Relationships } | DrawingPlaceholderReason> {
		const pkg = this.model.package

		if (partName === undefined || !pkg.has(partName)) return "missing"

		try {
			return { document: await pkg.xml(partName), relationships: await pkg.relationships(partName) }
		} catch (error) {
			if (!isDocumentError(error)) throw error

			return "malformed"
		}
	}

	private async chart(info: DrawingInfo): Promise<DocxDrawingResult> {
		const loaded = await this.loadPart(this.model.chartPart(info))

		if (typeof loaded === "string") return { kind: "placeholder", reason: loaded }

		const context = this.context(info.part, partResolver(this.model, loaded.relationships))
		const result = convertChart(context, loaded.document, info.width, info.height)

		return result.supported
			? { kind: "drawing", list: result.list, textboxes: [], unsupported: result.unsupported.length }
			: { kind: "placeholder", reason: "unsupported" }
	}

	private async smartArt(info: DrawingInfo): Promise<DocxDrawingResult> {
		let partName: string | undefined

		try {
			partName = await this.model.smartArtDrawingPart(info)
		} catch (error) {
			if (!isDocumentError(error)) throw error

			return { kind: "placeholder", reason: "malformed" }
		}

		const loaded = await this.loadPart(partName)

		if (typeof loaded === "string") return { kind: "placeholder", reason: loaded }

		const context = this.context(info.part, partResolver(this.model, loaded.relationships))
		const result = convertSmartArt(context, loaded.document, info.width, info.height)

		return result === undefined
			? { kind: "placeholder", reason: "malformed" }
			: { kind: "drawing", list: result.list, textboxes: [], unsupported: result.unsupported }
	}

	// Never throws: anything unexpected becomes a "failed" placeholder.
	vml(info: VmlInfo): DocxVmlResult {
		try {
			return this.convertVml(info)
		} catch {
			return { kind: "placeholder", reason: "failed" }
		}
	}

	private convertVml(info: VmlInfo): DocxVmlResult {
		const part = this.model.parts[info.part]

		if (part === undefined) return { kind: "placeholder", reason: "unsupported" }

		drawingReader(part.document, part.reader.namespaces)

		const result = convertVml(
			{
				theme: this.theme,
				images: resolver(this.model, info.part),
				story: node => this.storyOf(info.part, node),
				effects: this.effects
			},
			part.document,
			info.node
		)

		return result === undefined
			? { kind: "placeholder", reason: "unsupported" }
			: {
					kind: "drawing",
					list: result.list,
					placement: result.placement,
					textboxes: result.textboxes.map(node => this.storyOf(info.part, node)),
					unsupported: result.unsupported
				}
	}

	// The MathML tree of an m:oMath or m:oMathPara node of a story part; undefined when there is none or
	// conversion fails (never throws).
	// `view`: the revision view an equation holding tracked changes is shown in (layout's object index), -1 for one
	// without.
	math(part: number, node: number, view = -1): MathElement | undefined {
		const storyPart = this.model.parts[part]

		if (storyPart === undefined) return undefined

		try {
			const revisions =
				view === RevisionView.Markup || view === RevisionView.Final || view === RevisionView.Original
					? { revisions: { ...equationView(view), author: (this.authors ??= modelAuthors(this.model).index) } }
					: {}

			return ommlToMathTree(storyPart.document, node, { ...this.mathOptions, namespaces: storyPart.reader.namespaces, ...revisions })
		} catch {
			return undefined
		}
	}
}
