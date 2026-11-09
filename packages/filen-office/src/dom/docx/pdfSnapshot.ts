import {
	Item,
	Region,
	SOURCE_INTS,
	SourceInt,
	type DocumentLayout,
	type DocxModel,
	type PageDisplayList,
	type PropertyResolver,
	type PropsStore,
	type RevisionView,
	type StoryPart
} from "../../core/docx/index"
import type {
	DocxPdfCell,
	DocxPdfColumn,
	DocxPdfDocument,
	DocxPdfFace,
	DocxPdfLinkTarget,
	DocxPdfObject,
	DocxPdfOutlineEntry,
	DocxPdfPage,
	DocxPdfRole,
	DocxPdfStyle
} from "../../core/docx/pdf/types"
import { Emphasis, RunEffect } from "../../core/docx/layout/effects"
import { symbolTable, type FontManager, type FontRequest, type FontSlot } from "../../core/fonts/index"
import { FRAGMENT_FLOATS, FRAGMENT_INTS, FRAGMENT_KIND_MASK, FragmentKind, LINE_FLOATS, LINE_INTS, LineInt } from "../../core/text/index"
import { sliceClock, type Slicing } from "../../core/slicing"
import { pdfLanguage } from "../../core/docx/pdf/lang"
import { coreProperties } from "../../core/opc/coreTitle"
import { bookmarkIndex, paragraphLinks, paragraphOf, sourceLinkMap } from "./links"
import type { DocxMedia, DocxObjectData } from "./protocol"

// A laid-out document as DocxPdfDocument: what the pages show (the layout's display lists, its styles with the
// face each draws with, the objects and pictures on them), with what a tagged PDF needs from the model beside
// them (each paragraph's role, the bookmarks, the headings). Built where the layout lives; plain data, so the
// painter may run in another realm (`copy` then gives every page arrays of its own, to transfer).

export interface DocxPdfLive {
	// The model the layout reads (an editor's overlay parts included).
	readonly model: DocxModel
	readonly layout: DocumentLayout
	readonly fonts: FontManager
	readonly resolver: PropertyResolver
	readonly store: PropsStore
	readonly view: RevisionView
	objects(ids: readonly number[]): Promise<readonly DocxObjectData[]>
	media(partName: string): Promise<DocxMedia | null>
}

export interface DocxPdfSnapshotOptions {
	// Copies the layout's arrays (the snapshot is transferred; the layout keeps its own).
	readonly copy?: boolean
	// The title when the document names none: its file name without the extension.
	readonly title: string
	readonly signal?: { readonly aborted: boolean }
	// Gives the host a turn between pages once a slice is up (none: never).
	readonly slicing?: Slicing
}

export class DocxPdfSnapshotError extends Error {
	constructor(message: string) {
		super(message)

		this.name = "DocxPdfSnapshotError"
	}
}

const MAX_EMBEDDED_FACE = 32 * 1024 * 1024
const SLOTS: readonly FontSlot[] = ["ascii", "hAnsi", "eastAsia", "cs"]
const BLACK = 0x000000ff
const HEX = /^[0-9A-Fa-f]{6}$/
const IMAGE_FORMATS = new Set(["png", "jpeg", "gif", "bmp", "webp", "tiff"])

function checkAbort(signal: { readonly aborted: boolean } | undefined): void {
	if (signal?.aborted === true) throw Object.assign(new Error("The PDF export was aborted"), { name: "AbortError" })
}

// The request a layout style was made from (layout/styles.ts RunStyles.make): the slot whose family resolves
// to the style's font. A style made for a symbol override (w:sym) matches none and keeps its resolved face.
function requestOf(layout: DocumentLayout, fonts: FontManager, id: number): FontRequest | undefined {
	const style = layout.styles.get(id)
	const run = layout.styleInfo[id]?.run

	if (run === undefined) return undefined

	for (const slot of SLOTS) {
		const complex = slot === "cs"
		const family =
			slot === "ascii"
				? run.fonts.ascii
				: slot === "hAnsi"
					? run.fonts.hAnsi
					: slot === "eastAsia"
						? run.fonts.eastAsiaUsesAscii
							? run.fonts.ascii
							: run.fonts.eastAsia
						: run.fonts.cs
		const request: FontRequest = { family, bold: complex ? run.boldCs : run.bold, italic: complex ? run.italicCs : run.italic, slot }

		if (fonts.resolve(request) === style.font) return request
	}

	return undefined
}

async function stylesOf(
	layout: DocumentLayout,
	fonts: FontManager,
	signal: { readonly aborted: boolean } | undefined
): Promise<{ styles: DocxPdfStyle[]; faces: DocxPdfFace[] }> {
	const table = layout.styles
	const faces: DocxPdfFace[] = []
	const faceIndex = new Map<string, number>()
	const styles: DocxPdfStyle[] = []
	const addFace = (key: string, face: () => Promise<DocxPdfFace>): Promise<number> => {
		const known = faceIndex.get(key)

		if (known !== undefined) return Promise.resolve(known)

		return face().then(value => {
			const again = faceIndex.get(key)

			if (again !== undefined) return again

			faces.push(value)
			faceIndex.set(key, faces.length - 1)

			return faces.length - 1
		})
	}

	for (let id = 0; id < table.count; id++) {
		checkAbort(signal)

		const style = table.get(id)
		const info = layout.styleInfo[id]
		const run = info?.run
		const request = requestOf(layout, fonts, id)
		const font = style.font
		const slot: FontSlot = request?.slot ?? "ascii"
		let face: number

		if (request === undefined) {
			face = await addFace(`resolved:${font.id}`, () =>
				Promise.resolve({
					kind: "bundled",
					family: font.generic === "monospace" ? "cousine" : font.generic === "serif" ? "tinos" : "arimo",
					weight: font.weight,
					italic: font.italic
				})
			)
		} else {
			const source = fonts.pdfFace(request)

			if (source.kind === "bundled") {
				face = await addFace(`bundled:${source.family}:${source.weight}:${source.italic ? 1 : 0}`, () => Promise.resolve(source))
			} else if ((source.fsType & 0x0202) !== 0) {
				// Restricted or bitmap-only: never embedded again, drawn with the substitute (OS/2 fsType).
				face = await addFace(`bundled:${source.substitute}:${source.weight}:${source.italic ? 1 : 0}`, () =>
					Promise.resolve({ kind: "bundled", family: source.substitute, weight: source.weight, italic: source.italic })
				)
			} else {
				face = await addFace(`embedded:${source.key}`, async () => ({
					kind: "embedded",
					key: source.key,
					bytes: await source.read(MAX_EMBEDDED_FACE),
					fsType: source.fsType,
					weight: source.weight,
					italic: source.italic,
					substitute: source.substitute
				}))
			}
		}

		const color = info?.color
		const effect = info?.effect
		const emphasis = info?.emphasis
		const symbolFont =
			request !== undefined && faces[face]?.kind === "bundled" && symbolTable(request.family) !== undefined
				? request.family
				: undefined

		styles.push({
			face,
			bold: request?.bold ?? font.weight >= 700,
			italic: request?.italic ?? font.italic,
			slot,
			language:
				run === undefined ? undefined : slot === "eastAsia" ? run.lang.eastAsia : slot === "cs" ? run.lang.bidi : run.lang.latin,
			size: style.size * font.scale,
			color: color !== undefined && HEX.test(color) ? (Number.parseInt(color, 16) * 256 + 255) >>> 0 : BLACK,
			letterSpacing: table.letterSpacing[id] ?? 0,
			scaleX: table.scaleX[id] ?? 1,
			shift: table.shift[id] ?? 0,
			fit: font.source === "local" ? "scale" : "spread",
			...(symbolFont === undefined ? {} : { symbolFont }),
			...(effect === undefined || effect === RunEffect.NONE ? {} : { effect }),
			...(emphasis === undefined || emphasis === Emphasis.NONE
				? {}
				: {
						emphasis,
						// The middle of the room the line keeps for the marks, over the ascent or under the descent.
						markY:
							emphasis === Emphasis.UNDER_DOT
								? (table.descent[id] ?? 0) + (table.markBelow[id] ?? 0) / 2
								: -((table.ascent[id] ?? 0) + (table.markAbove[id] ?? 0) / 2)
					})
		})
	}

	return { styles, faces }
}

// The paragraph item and part a source names, or undefined for generated text.
function sourceParagraph(
	model: DocxModel,
	page: PageDisplayList,
	source: number
): { part: StoryPart; partIndex: number; item: number } | undefined {
	const at = source * SOURCE_INTS
	const story = page.sourceInts[at + SourceInt.STORY] ?? -1
	const item = page.sourceInts[at + SourceInt.ITEM] ?? -1
	const own = page.sourceParts[source] ?? -1
	const partIndex = own >= 0 ? own : (model.stories[story]?.part ?? -1)
	const part = model.parts[partIndex]

	if (part === undefined || item < 0 || part.kinds[item] !== Item.Paragraph) return undefined

	return { part, partIndex, item }
}

// The items of `kind` under a table or row, through wrappers (w:sdt, w:customXml) but not into nested tables.
function childrenOf(part: StoryPart, parent: number, kind: number): number[] {
	const out: number[] = []
	const visit = (at: number): void => {
		for (let child = part.firstChild(at); child >= 0; child = part.nextSibling(child)) {
			const childKind = part.kinds[child]

			if (childKind === kind) out.push(child)
			else if (childKind === Item.Sdt || childKind === Item.CustomXml) visit(child)
		}
	}

	visit(parent)

	return out
}

// A table as the structure tree tags it: per row, its cells as grid columns (what w:gridBefore and w:gridAfter
// skip, and what a row narrower than the widest leaves, as cells of their own), each with its span (w:gridSpan)
// and the rows of its vertical merge (w:vMerge), and where each cell item sits among them.
interface TableShape {
	readonly rows: ReadonlyMap<number, number>
	readonly columns: readonly DocxPdfColumn[][]
	readonly cells: ReadonlyMap<number, number>
	readonly headers: readonly boolean[]
}

const tableShapes = new WeakMap<StoryPart, Map<number, TableShape>>()

function tableShape(part: StoryPart, table: number, store: PropsStore): TableShape {
	let shapes = tableShapes.get(part)

	if (shapes === undefined) {
		shapes = new Map()
		tableShapes.set(part, shapes)
	}

	const known = shapes.get(table)

	if (known !== undefined) return known

	const rows = new Map<number, number>()
	const cells = new Map<number, number>()
	const columns: DocxPdfColumn[][] = []
	const headers: boolean[] = []
	let width = 0
	const starts: { column: number; grid: number; merge: "restart" | "continue" | undefined }[][] = []

	for (const row of childrenOf(part, table, Item.Row)) {
		const index = rows.size
		const trPr = part.rows.trPr[part.aux[row] ?? -1] ?? -1
		const rowProps = trPr >= 0 ? store.rowLook(part.document, trPr) : undefined
		const before = Math.max(0, rowProps?.gridBefore ?? 0)
		const after = Math.max(0, rowProps?.gridAfter ?? 0)
		const own: DocxPdfColumn[] = []
		const placed: { column: number; grid: number; merge: "restart" | "continue" | undefined }[] = []
		let grid = 0

		rows.set(row, index)
		headers.push(rowProps?.header === true)

		if (before > 0) {
			own.push({ span: before, top: index, end: index })
			grid += before
		}

		for (const cell of childrenOf(part, row, Item.Cell)) {
			const tcPr = part.cells.tcPr[part.aux[cell] ?? -1] ?? -1
			const props = tcPr >= 0 ? store.cellLook(part.document, tcPr) : undefined
			const span = Math.max(1, props?.gridSpan ?? 1)

			cells.set(cell, own.length)
			placed.push({ column: own.length, grid, merge: props?.vMerge })
			own.push({ span, top: index, end: index })
			grid += span
		}

		if (after > 0) own.push({ span: after, top: index, end: index })

		width = Math.max(
			width,
			own.reduce((sum, column) => sum + column.span, 0)
		)
		columns.push(own)
		starts.push(placed)
	}

	// Vertical merges: a continuing cell belongs to the merge started above it in its grid column; the merge's
	// first cell spans down to its last continuing one.
	let running = new Map<number, { top: number; column: number }>()
	const ends = new Map<string, number>()
	// Each merged cell's merge, by the first cell's "row:column".
	const heads = new Map<string, string>()

	starts.forEach((placed, index) => {
		const next = new Map<number, { top: number; column: number }>()

		for (const { column, grid, merge } of placed) {
			const above = merge === "continue" ? running.get(grid) : undefined
			const head = above ?? { top: index, column }

			if (merge === "restart" || above !== undefined) next.set(grid, head)
			if (above !== undefined) ends.set(`${head.top}:${head.column}`, index)

			const own = columns[index]
			const cell = own?.[column]

			if (own !== undefined && cell !== undefined) own[column] = { ...cell, top: head.top }

			heads.set(`${index}:${column}`, `${head.top}:${head.column}`)
		}

		running = next
	})

	columns.forEach((own, index) => {
		own.forEach((cell, k) => {
			const end = ends.get(heads.get(`${index}:${k}`) ?? "")

			if (end !== undefined) own[k] = { ...cell, end }
		})
	})

	columns.forEach((own, index) => {
		const missing = width - own.reduce((sum, column) => sum + column.span, 0)

		if (missing > 0) own.push({ span: missing, top: index, end: index })
	})

	const shape = { rows, columns, cells, headers }

	shapes.set(table, shape)

	return shape
}

// The table cells around a paragraph, outermost first.
function cellsOf(part: StoryPart, partIndex: number, item: number, store: PropsStore): DocxPdfCell[] {
	const out: DocxPdfCell[] = []

	for (let at = part.parent(item); at >= 0; at = part.parent(at)) {
		if (part.kinds[at] !== Item.Cell) continue

		let row = part.parent(at)

		while (row >= 0 && part.kinds[row] !== Item.Row) row = part.parent(row)

		let table = row < 0 ? -1 : part.parent(row)

		while (table >= 0 && part.kinds[table] !== Item.Table) table = part.parent(table)

		if (row < 0 || table < 0) continue

		const shape = tableShape(part, table, store)
		const index = shape.rows.get(row) ?? 0

		out.push({
			table: partIndex * 0x4000000 + table,
			row: index,
			cell: shape.cells.get(at) ?? 0,
			header: shape.headers[index] === true,
			columns: shape.columns[index] ?? []
		})
	}

	return out.reverse()
}

interface RoleContext {
	readonly model: DocxModel
	readonly resolver: PropertyResolver
	readonly store: PropsStore
}

function roleOf(context: RoleContext, page: PageDisplayList, source: number): { role: DocxPdfRole; key: string } {
	const region = page.sourceInts[source * SOURCE_INTS + SourceInt.REGION] ?? 0

	if (region === Region.HEADER || region === Region.FOOTER) {
		return {
			role: { kind: "artifact", level: 0, list: -1, cells: [], artifact: region === Region.HEADER ? "Header" : "Footer" },
			key: ""
		}
	}

	if (region === Region.LINE_NUMBER || region === Region.GENERATED)
		return { role: { kind: "artifact", level: 0, list: -1, cells: [] }, key: "" }

	const found = sourceParagraph(context.model, page, source)

	if (found === undefined) return { role: { kind: "paragraph", level: 0, list: -1, cells: [] }, key: "" }

	const { part, partIndex, item } = found
	const row = part.paragraphRow(item)
	const pPr = row < 0 ? -1 : (part.paragraphs.pPr[row] ?? -1)
	const props = context.resolver.paragraph(context.store.paragraphLook(part.document, pPr)).props
	const cells = cellsOf(part, partIndex, item, context.store)
	const outline = props.outlineLevel
	const key = `${partIndex}:${item}`

	if (region === Region.BODY && outline !== undefined && outline >= 0 && outline < 9) {
		return { role: { kind: "heading", level: outline + 1, list: -1, cells }, key }
	}

	if (props.numbering !== undefined && props.numbering.numId > 0) {
		return { role: { kind: "listItem", level: 0, list: props.numbering.numId, cells }, key }
	}

	return { role: { kind: "paragraph", level: 0, list: -1, cells }, key }
}

function copied<T extends Float32Array | Int32Array>(array: T, copy: boolean): T {
	return (copy ? array.slice() : array) as T
}

// The page's placed objects plus its inline ones, which the text layout carries as object fragments (as the
// renderer's pages have them).
function objectsOf(layout: DocumentLayout, page: PageDisplayList): { count: number; floats: Float32Array; ints: Int32Array } {
	const table = layout.objects
	const text = page.text
	const floats = Array.from(page.objectFloats.subarray(0, page.objectCount * 4))
	const ints = Array.from(page.objectInts.subarray(0, page.objectCount * 3))

	for (let line = 0; line < text.lineCount; line++) {
		const baseline = text.lineFloats[line * LINE_FLOATS + 2] ?? 0
		const first = text.lineInts[line * LINE_INTS + LineInt.FIRST_FRAGMENT] ?? 0
		const count = text.lineInts[line * LINE_INTS + LineInt.FRAGMENT_COUNT] ?? 0

		for (let k = first; k < first + count; k++) {
			if (((text.fragmentInts[k * FRAGMENT_INTS + 3] ?? 0) & FRAGMENT_KIND_MASK) !== FragmentKind.OBJECT) continue

			const id = text.fragmentInts[k * FRAGMENT_INTS + 4] ?? -1
			const height = table.heights[id] ?? 0

			if (id < 0 || !(height > 0)) continue

			floats.push(
				text.fragmentFloats[k * FRAGMENT_FLOATS] ?? 0,
				baseline - (table.ascents[id] ?? height),
				text.fragmentFloats[k * FRAGMENT_FLOATS + 1] ?? table.widths[id] ?? 0,
				height
			)
			ints.push(id, 1, text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? -1)
		}
	}

	return { count: ints.length / 3, floats: Float32Array.from(floats), ints: Int32Array.from(ints) }
}

// The renderer's object data as the painter takes it (core/drawingml/pdf.ts reads its lists as arrays).
function pdfObject(object: DocxObjectData): DocxPdfObject {
	if (object.kind !== "drawing") return object

	const { clips, ...drawing } = object.drawing

	return {
		...object,
		drawing: {
			...drawing,
			paints: [...drawing.paints],
			strokes: [...drawing.strokes],
			images: [...drawing.images],
			texts: [...drawing.texts],
			...(clips === undefined ? {} : { clips: [...clips] })
		}
	}
}

function drawingImages(object: DocxPdfObject): string[] {
	if (object.kind !== "drawing") return []

	return object.drawing.images.flatMap(image =>
		image.partName !== undefined && IMAGE_FORMATS.has(image.format) && image.handling !== "placeholder" && image.handling !== "metafile"
			? [image.partName]
			: []
	)
}

export async function docxPdfSnapshot(live: DocxPdfLive, options: DocxPdfSnapshotOptions): Promise<DocxPdfDocument> {
	const { model, layout, fonts, resolver, store, view } = live
	const signal = options.signal
	const copy = options.copy === true
	const clock = options.slicing === undefined ? undefined : sliceClock(options.slicing)

	await layout.done

	checkAbort(signal)

	if (layout.cancelled || !layout.final) throw new DocxPdfSnapshotError("The document is not laid out")

	const { styles, faces } = await stylesOf(layout, fonts, signal)
	const links: DocxPdfLinkTarget[] = []
	const linkKeys = new Map<string, number>()
	const linkIndex = (target: DocxPdfLinkTarget): number => {
		const key = target.kind === "external" ? `e${target.href}` : `i${target.anchor}`
		let index = linkKeys.get(key)

		if (index === undefined) {
			index = links.length
			links.push(target)
			linkKeys.set(key, index)
		}

		return index
	}
	const roleContext: RoleContext = { model, resolver, store }
	const pages: DocxPdfPage[] = []
	const objectIds = new Set<number>()
	const outline: DocxPdfOutlineEntry[] = []
	const headingsSeen = new Set<string>()
	// Where each paragraph starts ("part:item" of its first line), for bookmarks.
	const starts = new Map<string, { page: number; y: number }>()

	for (const page of layout.pages) {
		checkAbort(signal)

		const roles: DocxPdfRole[] = []
		const keys: string[] = []
		const linkInts: number[] = []

		for (let source = 0; source < page.sourceCount; source++) {
			const { role, key } = roleOf(roleContext, page, source)

			roles.push(role)
			keys.push(key)

			const found = sourceParagraph(model, page, source)

			if (found === undefined) continue

			const text = page.sourceTexts[source] ?? ""

			for (const range of paragraphLinks(found.part, found.item, text, view, sourceLinkMap(page, source))) {
				const target: DocxPdfLinkTarget =
					range.target.kind === "external"
						? { kind: "external", href: range.target.href }
						: { kind: "internal", anchor: range.target.anchor }

				linkInts.push(source, range.start, range.end, linkIndex(target))
			}
		}

		const text = page.text

		for (let line = 0; line < text.lineCount; line++) {
			const source = text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? -1
			const key = keys[source] ?? ""
			const y = text.lineFloats[line * LINE_FLOATS] ?? 0

			if (key === "") continue

			if (!starts.has(key)) starts.set(key, { page: page.index, y })

			const role = roles[source]

			if (role?.kind === "heading" && !headingsSeen.has(key)) {
				headingsSeen.add(key)

				const title = (page.sourceTexts[source] ?? "").replace(/\s+/g, " ").trim()

				if (title.length > 0) outline.push({ title, level: role.level, page: page.index, y })
			}
		}

		const objects = objectsOf(layout, page)

		for (let o = 0; o < objects.count; o++) objectIds.add(objects.ints[o * 3] ?? -1)

		pages.push({
			index: page.index,
			width: page.width,
			height: page.height,
			lineCount: text.lineCount,
			fragmentCount: text.fragmentCount,
			decorationCount: text.decorationCount,
			lineFloats: copied(text.lineFloats, copy),
			lineInts: copied(text.lineInts, copy),
			fragmentFloats: copied(text.fragmentFloats, copy),
			fragmentInts: copied(text.fragmentInts, copy),
			decorationFloats: copied(text.decorationFloats, copy),
			decorationInts: copied(text.decorationInts, copy),
			graphicCount: page.graphicCount,
			graphicFloats: copied(page.graphicFloats, copy),
			graphicInts: copied(page.graphicInts, copy),
			objectCount: objects.count,
			objectFloats: objects.floats,
			objectInts: objects.ints,
			sourceCount: page.sourceCount,
			sourceInts: copied(page.sourceInts, copy),
			sourceTexts: page.sourceTexts,
			...(page.sourceOwners.some(owner => owner >= 0) ? { sourceOwners: copied(page.sourceOwners, copy) } : {}),
			linkCount: linkInts.length / 4,
			linkInts: Int32Array.from(linkInts),
			clipCount: page.clipCount,
			clipFloats: copied(page.clipFloats, copy),
			clipInts: copied(page.clipInts, copy),
			roles,
			keys
		})

		if (clock?.due === true) await clock.pause()
	}

	objectIds.delete(-1)

	const objects = new Map<number, DocxPdfObject>()

	for (const object of await live.objects([...objectIds])) objects.set(object.id, pdfObject(object))

	checkAbort(signal)

	const media = new Map<string, Uint8Array>()

	for (const object of objects.values()) {
		for (const part of drawingImages(object)) {
			if (media.has(part)) continue

			const found = await live.media(part)

			checkAbort(signal)

			if (found !== null) media.set(part, found.bytes)
		}
	}

	const destinations = new Map<string, { page: number; y: number }>()

	for (const [name, target] of bookmarkIndex(model)) {
		const part = model.parts[target.part]

		if (part === undefined) continue

		const start = starts.get(`${target.part}:${paragraphOf(part, target.item)}`)

		if (start !== undefined) destinations.set(name, start)
	}

	// The document defaults' language, else the one its theme fonts are picked for (w:themeFontLang, §17.15.1.88).
	const defaults = resolver.run(resolver.paragraph({}), {}).lang
	const theme = model.settings.themeFontLanguages
	const lang = [defaults.latin, defaults.eastAsia, defaults.bidi, theme?.latin, theme?.eastAsia, theme?.bidi]
		.map(pdfLanguage)
		.find(value => value !== undefined)
	const core = await coreProperties(model.package.opc)

	return {
		pages,
		styles,
		faces,
		decorations: layout.decorations.slice(),
		links,
		objects,
		media,
		destinations,
		outline,
		lang,
		title: core.title ?? options.title,
		properties: { author: core.author, subject: core.subject, keywords: core.keywords }
	}
}

// The buffers a snapshot built with `copy` can transfer (its pages' arrays, its media and faces are its own).
export function snapshotTransfer(doc: DocxPdfDocument): ArrayBuffer[] {
	const out = new Set<ArrayBuffer>()
	const add = (array: ArrayBufferView): void => {
		if (array.buffer instanceof ArrayBuffer && array.byteLength > 0) out.add(array.buffer)
	}

	for (const page of doc.pages) {
		for (const array of [
			page.lineFloats,
			page.lineInts,
			page.fragmentFloats,
			page.fragmentInts,
			page.decorationFloats,
			page.decorationInts,
			page.graphicFloats,
			page.graphicInts,
			page.objectFloats,
			page.objectInts,
			page.sourceInts,
			page.linkInts,
			page.clipFloats,
			page.clipInts
		])
			add(array)
	}

	return [...out]
}
