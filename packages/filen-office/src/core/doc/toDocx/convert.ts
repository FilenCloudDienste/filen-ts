import { appendAll } from "../../arrays"
import type { DocModel, DocBlock, DocParagraph, DocPlaceholder, DocRun, DocStoryKind, DocTable, DocTextBox } from "../model"
import type { DocChar, DocCell, DocRevision, DocRow, DocWidth } from "../props"
import type { DocFile } from "../read"
import { anchor, EMU_PER_TWIP, inline, pictureGraphic, shapeGraphic, type DrawingName, type ShapeLook, type Transform } from "./drawing"
import { crop, inlinePicture, type MediaStore, shapeBlip } from "./media"
import { type ArtContent, type ArtShape, artColor, booleanProperty, complexText, PID } from "./officeArt"
import { type PropsContext, border, paragraphProperties, runProperties, shading } from "./props"
import type { ConversionReport } from "./report"
import { type HeaderReferences, sectionProperties } from "./sections"
import type { StyleMap } from "./styles"
import { attr, clamp, NS_R, text, val } from "./xml"

// The stories of a Word binary document as WordprocessingML block content: paragraphs and their runs, fields as
// complex fields, bookmarks and comment ranges, note and comment references, tables, revisions, pictures and
// floating shapes.

const FIELD_BEGIN = 0x13
const FIELD_SEPARATOR = 0x14
const FIELD_END = 0x15
const MAX_FIELD_DEPTH = 64

// A part being written and the relationships its content needs.
export class PartRelationships {
	readonly entries: { readonly id: string; readonly type: string; readonly target: string; readonly external: boolean }[] = []
	private readonly byTarget = new Map<string, string>()

	add(type: string, target: string, external = false): string {
		const key = `${type} ${target}`
		const known = this.byTarget.get(key)

		if (known !== undefined) return known

		const id = `rId${String(this.entries.length + 1)}`

		this.entries.push({ id, type, target, external })
		this.byTarget.set(key, id)

		return id
	}
}

export const REL_IMAGE = `${NS_R}/image`

export interface NoteRef {
	readonly kind: "footnote" | "endnote"
	readonly id: number
	readonly auto: boolean
}

// Everything the story writer reads, shared across parts.
export interface Conversion {
	readonly model: DocModel
	readonly file: DocFile
	readonly styles: StyleMap
	readonly props: PropsContext
	readonly numIds: ReadonlySet<number>
	readonly art: ArtContent
	readonly media: MediaStore
	readonly report: ConversionReport
	// Note references in the main story (and the note's own mark at its text start) by CP.
	readonly noteRefs: ReadonlyMap<number, NoteRef>
	readonly noteMarks: ReadonlyMap<number, NoteRef>
	// Comment ids by reference CP, and comment range markup by CP.
	readonly commentRefs: ReadonlyMap<number, number>
	readonly textBoxes: ReadonlyMap<number, DocTextBox>
	readonly placeholders: ReadonlyMap<number, DocPlaceholder>
	readonly fieldMarks: ReadonlySet<number>
	readonly fieldFlags: ReadonlyMap<number, number>
	// Section breaks: the CP of each non-final section's last character, by section index.
	readonly sectionEnds: ReadonlyMap<number, number>
	readonly sectionReferences: readonly HeaderReferences[]
	// Range markup (bookmarks, comment ranges) to write before the character at each CP, and those CPs sorted.
	readonly events: Map<number, string[]>
	readonly eventCps: readonly number[]
	// ffData of form fields by the CP of their field begin.
	readonly formFields: ReadonlyMap<number, string>
	readonly ids: { docPr: number; revision: number; order: number }
	readonly objectPreviews: ReadonlyMap<number, string>
	// Text boxes a group's text box shows (the others show from their own anchor, or after the body).
	readonly shownBoxes: Set<number>
}

// The shapes of a group, its subgroups' included.
function members(group: ArtShape): ArtShape[] {
	return (group.children ?? []).flatMap(child => (child.children === undefined ? [child] : members(child)))
}

const GTEXT_UNICODE = 0x00c0

function wordArtText(shape: ArtShape): string | undefined {
	const text = complexText(shape.properties.get(GTEXT_UNICODE))

	return text === undefined || text.trim() === "" ? undefined : text
}

function wordArtParagraph(value: string): string {
	const runs = value
		.split(/\r\n|\r|\n/u)
		.map(line => `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">${text(line)}</w:t></w:r></w:p>`)

	return runs.join("")
}

function revisionAttrs(conversion: Conversion, revision: DocRevision): string {
	const author = conversion.model.revisionAuthors[revision.author] ?? "Unknown"

	return `${attr("w:id", conversion.ids.revision++)}${attr("w:author", author === "" ? "Unknown" : author)}${revision.date === undefined ? "" : attr("w:date", `${revision.date}Z`)}`
}

// One story range written as block content.
export class StoryWriter {
	private readonly conversion: Conversion
	private readonly part: PartRelationships
	private readonly story: DocStoryKind
	private readonly out: string[] = []
	// Per open field: true while in its instruction.
	private readonly fields: boolean[] = []
	private instruction = 0
	private readonly rprCache = new Map<DocChar, Map<number, string>>()
	private runIndex = 0
	private eventIndex: number
	private readonly start: number
	private readonly end: number

	constructor(conversion: Conversion, part: PartRelationships, story: DocStoryKind, start: number, end: number) {
		this.conversion = conversion
		this.part = part
		this.story = story
		this.start = start
		this.end = end

		const cps = conversion.eventCps
		let low = 0
		let high = cps.length

		while (low < high) {
			const middle = (low + high) >> 1

			if ((cps[middle] ?? 0) < start) low = middle + 1
			else high = middle
		}

		this.eventIndex = low
	}

	// The blocks of the range, written; a story that ends inside an open field closes it.
	write(): string {
		const blocks = this.conversion.model.blocks.get(this.story) ?? []

		this.blocks(blocksIn(this.conversion.model, blocks, this.start, this.end), false)

		while (this.fields.length > 0) {
			this.fields.pop()
		}

		// Range markup at CPs no paragraph wrote (row marks, the story's end).
		const rest = this.takeEvents(this.end + 1)

		if (rest !== "") this.out.push(rest)

		return this.out.join("")
	}

	// Writes blocks; returns whether the last one written was a paragraph.
	private blocks(blocks: readonly DocBlock[], inCell: boolean): boolean {
		let lastParagraph = false

		for (const block of blocks) {
			if (block.kind === "paragraph") {
				lastParagraph = this.paragraph(block.index, inCell) || lastParagraph
			} else {
				this.table(block)
				lastParagraph = false
			}
		}

		return lastParagraph
	}

	// The range markup before CP `to` not written yet (CPs are visited in order).
	private takeEvents(to: number): string {
		const { events, eventCps } = this.conversion
		let out = ""

		for (; this.eventIndex < eventCps.length && (eventCps[this.eventIndex] ?? 0) < to; this.eventIndex++) {
			const cp = eventCps[this.eventIndex] ?? 0
			const markup = events.get(cp)

			if (markup !== undefined) {
				out += markup.join("")
				events.delete(cp)
			}
		}

		return out
	}

	private runPr(run: DocRun, paragraphStyle: number): string {
		let byStyle = this.rprCache.get(run.props)

		if (byStyle === undefined) {
			byStyle = new Map()
			this.rprCache.set(run.props, byStyle)
		}

		let rpr = byStyle.get(paragraphStyle)

		if (rpr === undefined) {
			rpr = this.baseRunPr(run, paragraphStyle)
			byStyle.set(paragraphStyle, rpr)
		}

		// A format change has an id of its own in every run.
		if (run.props.formatChange !== undefined)
			rpr += `<w:rPrChange${revisionAttrs(this.conversion, run.props.formatChange)}><w:rPr/></w:rPrChange>`

		return rpr
	}

	private baseRunPr(run: DocRun, paragraphStyle: number): string {
		const styles = this.conversion.styles
		const charStyle = run.props.istd !== 10 && styles.isCharacterStyle(run.props.istd) ? run.props.istd : 10
		const base = styles.resolver.charBase(paragraphStyle, charStyle)
		return runProperties(
			run.props,
			base,
			this.conversion.props,
			charStyle === 10 ? {} : { style: styles.id(charStyle) ?? "", absoluteToggles: styles.resolver.resolve(paragraphStyle).char }
		)
	}

	private firstRun(cp: number): number {
		const runs = this.conversion.model.runs
		let index = this.runIndex

		if (index >= runs.length || (runs[index]?.start ?? 0) > cp) index = 0

		if ((runs[index]?.end ?? 0) <= cp) {
			let low = index
			let high = runs.length

			while (low < high) {
				const middle = (low + high) >> 1

				if ((runs[middle]?.end ?? 0) <= cp) low = middle + 1
				else high = middle
			}

			index = low
		}

		this.runIndex = index

		return index
	}

	// Returns true when a paragraph was written (row marks write none).
	private paragraph(index: number, inCell: boolean): boolean {
		const conversion = this.conversion
		const { model, styles } = conversion
		const paragraph = model.paragraphs[index]

		if (paragraph === undefined) return false

		const contentEnd = paragraph.ending === "none" ? paragraph.end : paragraph.end - 1

		if (paragraph.ending === "row") return false

		const styleIstd = styles.paragraphStyle(paragraph.props.istd)
		const base = styles.resolver.resolve(styleIstd).para
		const out = this.out
		const ilfo = paragraph.props.ilfo
		const numbered = ilfo > 0 && conversion.numIds.has(ilfo)
		const numbering = numbered
			? { numId: ilfo, ilvl: Math.min(8, paragraph.props.ilvl) }
			: base.ilfo > 0 && ilfo === 0
				? { numId: 0, ilvl: 0 }
				: undefined
		const styleId = styleIstd === 0 ? undefined : styles.id(styleIstd)
		const ppr = paragraphProperties(paragraph.props, base, conversion.props, {
			...(styleId === undefined ? {} : { style: styleId }),
			...(numbering === undefined ? {} : { numbering }),
			forceIndent: numbered
		})

		const markRun = paragraph.ending === "none" ? undefined : model.runs[this.firstRun(contentEnd)]
		let markPr = ""

		if (markRun !== undefined && markRun.start <= contentEnd && markRun.end > contentEnd) {
			let revision = ""

			if (markRun.props.inserted !== undefined) revision += `<w:ins${revisionAttrs(conversion, markRun.props.inserted)}/>`
			if (markRun.props.deleted !== undefined) revision += `<w:del${revisionAttrs(conversion, markRun.props.deleted)}/>`

			const rpr = this.runPr(markRun, styleIstd).replace(/^<w:rStyle w:val="[^"]*"\/>/u, "")

			if (revision !== "" || rpr !== "") markPr = `<w:rPr>${revision}${rpr}</w:rPr>`
		}

		const section = inCell ? undefined : conversion.sectionEnds.get(paragraph.end - 1)
		let sectPr = ""

		if (section !== undefined) {
			const props = model.sections[section]?.props

			if (props !== undefined) sectPr = sectionProperties(props, conversion.sectionReferences[section] ?? {}, conversion.props)
		}

		const change =
			paragraph.props.formatChange === undefined
				? ""
				: `<w:pPrChange${revisionAttrs(conversion, paragraph.props.formatChange)}><w:pPr/></w:pPrChange>`

		out.push("<w:p>")

		if (ppr !== "" || markPr !== "" || sectPr !== "" || change !== "") out.push(`<w:pPr>${ppr}${markPr}${sectPr}${change}</w:pPr>`)

		const events = this.takeEvents(paragraph.start)

		if (events !== "") out.push(events)

		this.content(paragraph, Math.max(paragraph.start, this.start), Math.min(contentEnd, this.end), styleIstd)

		const after = this.takeEvents(Math.min(paragraph.end, this.end + 1))

		if (after !== "") out.push(after)

		out.push("</w:p>")

		return true
	}

	private content(paragraph: DocParagraph, from: number, to: number, styleIstd: number): void {
		const conversion = this.conversion
		const { model } = conversion
		const runs = model.runs
		const textAll = model.text
		const out = this.out

		for (let index = this.firstRun(from); index < runs.length; index++) {
			const run = runs[index]

			if (run === undefined || run.start >= to) break

			const start = Math.max(run.start, from)
			const stop = Math.min(run.end, to)

			if (stop <= start) continue

			const rpr = this.runPr(run, styleIstd)
			const deleted = run.props.deleted !== undefined
			const open = (): string => (rpr === "" ? "<w:r>" : `<w:r><w:rPr>${rpr}</w:rPr>`)
			// Each w:ins / w:del written gets an id of its own.
			const wrapOpen = (): string => {
				const inserted = run.props.inserted
				const removed = run.props.deleted

				return (
					(inserted === undefined ? "" : `<w:ins${revisionAttrs(conversion, inserted)}>`) +
					(removed === undefined ? "" : `<w:del${revisionAttrs(conversion, removed)}>`)
				)
			}
			const wrapClose = (deleted ? "</w:del>" : "") + (run.props.inserted === undefined ? "" : "</w:ins>")

			// Children of the w:r being built, and the text not yet written.
			let children = ""
			let chunk = ""
			let chunkInstruction = false

			const flushText = (): void => {
				if (chunk === "") return

				const element = chunkInstruction ? (deleted ? "w:delInstrText" : "w:instrText") : deleted ? "w:delText" : "w:t"

				children += `<${element} xml:space="preserve">${text(chunk)}</${element}>`
				chunk = ""
			}

			const flushRun = (): void => {
				flushText()

				if (children !== "") out.push(`${wrapOpen()}${open()}${children}</w:r>${wrapClose}`)

				children = ""
			}

			// A run of its own (field characters, references, drawings).
			const own = (markup: string): void => {
				flushRun()
				out.push(`${wrapOpen()}${open()}${markup}</w:r>${wrapClose}`)
			}

			for (let cp = start; cp < stop; cp++) {
				if (conversion.events.has(cp)) {
					flushRun()
					out.push(this.takeEvents(cp + 1))
				}

				const code = textAll.charCodeAt(cp)

				if ((code === FIELD_BEGIN || code === FIELD_SEPARATOR || code === FIELD_END) && conversion.fieldMarks.has(cp)) {
					if (code === FIELD_BEGIN) {
						if (this.fields.length >= MAX_FIELD_DEPTH) continue

						this.fields.push(true)
						this.instruction++

						const flags = conversion.fieldFlags.get(cp) ?? 0
						const data = conversion.formFields.get(cp) ?? ""

						own(
							`<w:fldChar w:fldCharType="begin"${(flags & 0x10) !== 0 ? ' w:fldLock="1"' : ""}${data === "" ? "/>" : `>${data}</w:fldChar>`}`
						)
					} else if (code === FIELD_SEPARATOR) {
						if (this.fields.at(-1) !== true) continue

						this.fields[this.fields.length - 1] = false
						this.instruction--
						own('<w:fldChar w:fldCharType="separate"/>')
					} else {
						if (this.fields.length === 0) continue

						if (this.fields.pop() === true) this.instruction--

						own('<w:fldChar w:fldCharType="end"/>')
					}

					continue
				}

				if (this.instruction > 0 && this.fields.at(-1) === true) {
					// Characters of a field instruction: text, without the form field data marker.
					if (code === 0x01 && run.props.special) continue

					if (!chunkInstruction) flushText()

					chunkInstruction = true
					chunk += code < 0x20 && code !== 0x09 ? " " : textAll.charAt(cp)
					continue
				}

				if (chunkInstruction) {
					flushText()
					chunkInstruction = false
				}

				const note = this.story === "main" ? conversion.noteRefs.get(cp) : undefined

				if (note !== undefined) {
					own(`<w:${note.kind}Reference${note.auto ? "" : ' w:customMarkFollows="1"'}${attr("w:id", note.id)}/>`)

					if (!note.auto && !run.props.special) chunk += textAll.charAt(cp)

					continue
				}

				// fSpec marks special characters; other text in such a run is plain text.
				if (run.props.special && (code < 0x20 || code === 0x28)) {
					this.special(run, cp, code, own, paragraph)
					continue
				}

				if (run.props.symbol !== undefined) {
					flushText()

					const font = conversion.props.fonts[run.props.symbol.font]?.name
					const char = (run.props.symbol.char & 0xffff).toString(16).toUpperCase().padStart(4, "0")

					children += `<w:sym${font === undefined || font === "" ? "" : attr("w:font", font)}${attr("w:char", char)}/>`
					continue
				}

				switch (code) {
					case 0x09:
						flushText()
						children += "<w:tab/>"
						break
					case 0x0b:
						flushText()
						children += "<w:br/>"
						break
					case 0x0c:
						flushText()
						children += '<w:br w:type="page"/>'
						break
					case 0x0e:
						flushText()
						children += '<w:br w:type="column"/>'
						break
					case 0x1e:
						flushText()
						children += "<w:noBreakHyphen/>"
						break
					case 0x1f:
						flushText()
						children += "<w:softHyphen/>"
						break
					default:
						if (code < 0x20 || code === 0xfffe || code === 0xffff) {
							// Control characters other than the ones above mean nothing outside fSpec runs.
							conversion.report.note("specialCharacter")
						} else {
							chunk += textAll.charAt(cp)
						}
				}
			}

			flushRun()
		}
	}

	private special(run: DocRun, cp: number, code: number, own: (markup: string) => void, paragraph: DocParagraph): void {
		const conversion = this.conversion

		switch (code) {
			case 0x01:
			case 0x08: {
				const drawing = this.drawing(cp, paragraph)

				if (drawing !== undefined) own(drawing)

				return
			}
			case 0x02: {
				const mark = conversion.noteMarks.get(cp)

				if (mark !== undefined) own(`<w:${mark.kind}Ref/>`)
				else conversion.report.note("specialCharacter")

				return
			}
			case 0x03:
				own("<w:separator/>")
				return
			case 0x04:
				own("<w:continuationSeparator/>")
				return
			case 0x05: {
				const id = conversion.commentRefs.get(cp)

				if (id !== undefined && this.story === "main") own(`<w:commentReference${attr("w:id", id)}/>`)
				else if (this.story === "comments") own("<w:annotationRef/>")
				else conversion.report.note("specialCharacter")

				return
			}
			case 0x28:
				if (run.props.symbol !== undefined) {
					const font = conversion.props.fonts[run.props.symbol.font]?.name
					const char = (run.props.symbol.char & 0xffff).toString(16).toUpperCase().padStart(4, "0")

					own(`<w:sym${font === undefined || font === "" ? "" : attr("w:font", font)}${attr("w:char", char)}/>`)
				} else {
					own("<w:t>(</w:t>")
				}

				return
			default:
				// Separators, page numbers and dates written as fSpec characters by older versions.
				conversion.report.note("specialCharacter")
		}
	}

	private name(kind: string, description: string | undefined): DrawingName {
		const id = this.conversion.ids.docPr++

		return { id, name: `${kind} ${String(id)}`, description }
	}

	private placeholderDrawing(width: number, height: number, floating: Extract<DocPlaceholder, { kind: "shape" }> | undefined): string {
		const media = this.conversion.media.placeholder()
		const rel = this.part.add(REL_IMAGE, media.part.slice("word/".length))
		const w = Math.max(EMU_PER_TWIP, width)
		const h = Math.max(EMU_PER_TWIP, height)
		const name = this.name("Placeholder", "Not converted")
		const graphic = pictureGraphic(rel, w, h, name, undefined)

		return floating === undefined ? inline(graphic, w, h, name) : anchor(graphic, w, h, name, this.placement(floating, undefined))
	}

	private placement(shape: Extract<DocPlaceholder, { kind: "shape" }>, art: ArtShape | undefined) {
		const distance = (pid: number, fallback: number): number => art?.properties.get(pid)?.value ?? fallback

		return {
			relativeH: shape.relativeH,
			relativeV: shape.relativeV,
			x: shape.left * EMU_PER_TWIP,
			y: shape.top * EMU_PER_TWIP,
			wrap: shape.wrap,
			wrapSide: shape.wrapSide,
			behindText: shape.behindText,
			// A shape no drawing lists stacks above those that are listed, in text order.
			order: this.conversion.art.stacking.get(shape.spid) ?? this.conversion.ids.order++,
			// dyWrapDistTop, dyWrapDistBottom, dxWrapDistLeft, dxWrapDistRight (EMUs; Word's defaults).
			distances: [distance(0x0385, 0), distance(0x0387, 0), distance(0x0384, 114300), distance(0x0386, 114300)] as const
		}
	}

	private drawing(cp: number, paragraph: DocParagraph): string | undefined {
		const conversion = this.conversion
		const placeholder = conversion.placeholders.get(cp)

		if (placeholder === undefined || placeholder.kind === "unresolvedObject") {
			conversion.report.note("damagedContent")

			return undefined
		}

		if (placeholder.kind === "formField") return undefined

		if (placeholder.kind === "picture") {
			const picture = inlinePicture(conversion.file, placeholder.dataOffset, conversion.art)

			if (picture === undefined || picture.blip === undefined) {
				conversion.report.note("picture")

				return this.placeholderDrawing((picture?.width ?? 1440) * EMU_PER_TWIP, (picture?.height ?? 1440) * EMU_PER_TWIP, undefined)
			}

			const media = conversion.media.add(picture.source, picture.blip)
			const rel = this.part.add(REL_IMAGE, media.part.slice("word/".length))
			const width = Math.max(1, picture.width) * EMU_PER_TWIP
			const height = Math.max(1, picture.height) * EMU_PER_TWIP
			const name = this.name("Picture", complexText(picture.shape?.properties.get(PID.description)))

			return inline(pictureGraphic(rel, width, height, name, picture.crop), width, height, name)
		}

		if (placeholder.kind === "ole") {
			const preview = conversion.objectPreviews.get(placeholder.objectId)

			if (preview === undefined) return this.placeholderDrawing(1440 * EMU_PER_TWIP, 1440 * EMU_PER_TWIP, undefined)

			const rel = this.part.add(REL_IMAGE, preview.slice("word/".length))
			const name = this.name("Object", undefined)
			const size = 1440 * EMU_PER_TWIP

			return inline(pictureGraphic(rel, size, size, name, undefined), size, size, name)
		}

		return this.floating(placeholder, paragraph)
	}

	private floating(placeholder: Extract<DocPlaceholder, { kind: "shape" }>, paragraph: DocParagraph): string {
		const conversion = this.conversion
		const width = Math.max(1, placeholder.right - placeholder.left) * EMU_PER_TWIP
		const height = Math.max(1, placeholder.bottom - placeholder.top) * EMU_PER_TWIP
		const shape = conversion.art.shapes.get(placeholder.spid)

		void paragraph

		if (shape === undefined) {
			conversion.report.note("shape")

			return this.placeholderDrawing(width, height, placeholder)
		}

		if (shape.children !== undefined) {
			conversion.report.note("group")

			// The group drawn as a placeholder; the text its shapes hold (text boxes, WordArt) in text boxes of the
			// group's size where the group is, so no text is left out.
			let out = this.placeholderDrawing(width, height, placeholder)

			for (const member of members(shape)) {
				const text = this.boxText(member)

				if (text === undefined) continue

				const look = shapeLook(member, PRESETS.get(member.shapeType) ?? "rect", true)

				out += anchor(
					shapeGraphic(width, height, look, text, {}),
					width,
					height,
					this.name("Text Box", complexText(member.properties.get(PID.description))),
					this.placement(placeholder, shape)
				)
			}

			return out
		}

		const transform = shapeTransform(shape)
		const description = complexText(shape.properties.get(PID.description))
		const picture = shape.shapeType === 75 || shape.properties.has(PID.pib) ? shapeBlip(conversion.art, shape) : undefined

		if (picture !== undefined) {
			const media = conversion.media.add(picture.source, picture.blip)
			const rel = this.part.add(REL_IMAGE, media.part.slice("word/".length))
			const name = this.name("Picture", description)

			return anchor(
				pictureGraphic(rel, width, height, name, crop(shape), transform),
				width,
				height,
				name,
				this.placement(placeholder, shape)
			)
		}

		const preset = PRESETS.get(shape.shapeType)
		const box = conversion.textBoxes.get(placeholder.spid)
		const wordArt = box === undefined ? wordArtText(shape) : undefined

		if (wordArt !== undefined) {
			// WordArt (gtextUNICODE, MS-ODRAW geometry text): its text in a text box of the shape's size.
			conversion.report.note("wordArt")

			const look: ShapeLook = { preset: "rect", fill: undefined, line: undefined, lineWidth: 0, textBox: true, insets: [0, 0, 0, 0] }

			return anchor(
				shapeGraphic(width, height, look, wordArtParagraph(wordArt), transform),
				width,
				height,
				this.name("WordArt", description),
				this.placement(placeholder, shape)
			)
		}

		if (preset === undefined && box === undefined) {
			conversion.report.note(shape.shapeType === 75 ? "picture" : "shape")

			return this.placeholderDrawing(width, height, placeholder)
		}

		let content: string | undefined

		if (box !== undefined) {
			const writer = new StoryWriter(conversion, this.part, box.story.kind, box.story.start, box.story.end)

			content = writer.write()

			if (!content.includes("<w:p>") && !content.includes("<w:p/>")) content += "<w:p/>"
		}

		const look = shapeLook(shape, preset ?? "rect", box !== undefined)
		const name = this.name(box !== undefined ? "Text Box" : "Shape", description)

		return anchor(shapeGraphic(width, height, look, content, transform), width, height, name, this.placement(placeholder, shape))
	}

	// A group member's text, as text box content: its text box story's, or its WordArt text; undefined for none.
	private boxText(member: ArtShape): string | undefined {
		const conversion = this.conversion
		const box = conversion.textBoxes.get(member.spid)

		if (box !== undefined) {
			conversion.shownBoxes.add(member.spid)

			const content = new StoryWriter(conversion, this.part, box.story.kind, box.story.start, box.story.end).write()

			return content.includes("<w:p>") || content.includes("<w:p/>") ? content : `${content}<w:p/>`
		}

		const wordArt = wordArtText(member)

		if (wordArt === undefined) return undefined

		conversion.report.note("wordArt")

		return wordArtParagraph(wordArt)
	}

	private table(table: DocTable): void {
		const conversion = this.conversion
		const { model } = conversion
		const out = this.out
		const rows = table.rows.map(row => ({ row, props: row.mark >= 0 ? model.paragraphs[row.mark]?.row : undefined }))
		const edges = new Set<number>()

		for (const { props } of rows) {
			if (props === undefined || props.cells.length === 0) continue

			edges.add(props.cells[0]?.left ?? 0)

			for (const cell of props.cells) edges.add(cell.right)
		}

		let grid = [...edges].sort((a, b) => a - b)
		const widest = Math.max(1, ...rows.map(({ row }) => row.cells.length))

		if (grid.length < 2) grid = Array.from({ length: widest + 1 }, (_, k) => k * 2000)

		const first = rows.find(entry => entry.props !== undefined)?.props
		const columnIndex = new Map(grid.map((edge, k) => [edge, k]))

		out.push("<w:tbl>")
		out.push(`<w:tblPr>${tablePr(first, conversion)}</w:tblPr>`)
		out.push("<w:tblGrid>")

		for (let k = 0; k + 1 < grid.length; k++)
			out.push(`<w:gridCol${attr("w:w", clamp((grid[k + 1] ?? 0) - (grid[k] ?? 0), 0, 31680))}/>`)

		out.push("</w:tblGrid>")

		for (const { row, props } of rows) {
			out.push("<w:tr>")

			const definitions = props?.cells ?? []
			const startColumn = definitions.length > 0 ? (columnIndex.get(definitions[0]?.left ?? 0) ?? 0) : 0
			let endColumn = startColumn
			const cells: { blocks: DocBlock[]; cell: DocCell | undefined; span: number; column: number }[] = []

			row.cells.forEach((blocks, k) => {
				const cell = definitions[k]

				let span = 1

				if (cell !== undefined) {
					const left = columnIndex.get(cell.left)
					const right = columnIndex.get(cell.right)

					if (left !== undefined && right !== undefined && right > left) span = right - left
				}

				// Horizontally merged cells (§2.9.? TCGRF horzMerge 2/3) join the first of their range.
				const previous = cells.at(-1)

				if (cell !== undefined && (cell.horzMerge === 2 || cell.horzMerge === 3) && previous !== undefined) {
					previous.span += span
					appendAll(previous.blocks, blocks)
				} else {
					cells.push({ blocks: [...blocks], cell, span, column: endColumn })
				}

				endColumn += span
			})

			const after = Math.max(0, grid.length - 1 - endColumn)

			out.push(rowPr(props, startColumn, grid, after))

			for (const { blocks, cell, span, column } of cells) {
				const cellWidth = column + span < grid.length ? (grid[column + span] ?? 0) - (grid[column] ?? 0) : undefined

				out.push("<w:tc>")
				out.push(`<w:tcPr>${cellPr(cell, span, cellWidth, conversion.props)}</w:tcPr>`)

				if (!this.blocks(blocks, true)) out.push("<w:p/>")

				out.push("</w:tc>")
			}

			if (cells.length === 0) out.push("<w:tc><w:tcPr/><w:p/></w:tc>")

			out.push("</w:tr>")
		}

		out.push("</w:tbl>")
	}
}

function width(name: string, value: DocWidth | undefined): string {
	if (value === undefined || value.unit === 0) return ""

	const type = value.unit === 1 ? "auto" : value.unit === 2 ? "pct" : "dxa"

	return `<w:${name}${attr("w:w", type === "auto" ? 0 : clamp(value.value, 0, 31680))}${attr("w:type", type)}/>`
}

function tablePr(row: DocRow | undefined, conversion: Conversion): string {
	if (row === undefined) return '<w:tblW w:w="0" w:type="auto"/>'

	const context = conversion.props
	const style = row.istd === undefined ? undefined : conversion.styles.id(row.istd)
	let out = style === undefined ? "" : val("tblStyle", style)

	out += row.rtl ? "<w:bidiVisual/>" : ""
	out += width("tblW", row.width) || '<w:tblW w:w="0" w:type="auto"/>'
	if (row.jc !== 0) out += val("jc", row.jc === 1 ? "center" : "right")
	if (row.spacing !== undefined && row.spacing > 0) out += `<w:tblCellSpacing${attr("w:w", clamp(row.spacing, 0, 31680))} w:type="dxa"/>`

	// Word binary positions the first cell's left edge (rgdxaCenter[0]); WordprocessingML's indent is to the
	// text, one cell margin further.
	const indent = row.indent !== undefined && row.indent.unit === 3 ? row.indent.value : row.left + row.gapHalf

	out += `<w:tblInd${attr("w:w", clamp(indent, -31680, 31680))} w:type="dxa"/>`

	const borders = [
		border("top", row.borderTop, context),
		border("left", row.borderLeft, context),
		border("bottom", row.borderBottom, context),
		border("right", row.borderRight, context),
		border("insideH", row.borderInsideH, context),
		border("insideV", row.borderInsideV, context)
	].join("")

	if (borders !== "") out += `<w:tblBorders>${borders}</w:tblBorders>`
	if (!row.autofit) out += '<w:tblLayout w:type="fixed"/>'

	const [top, left, bottom, right] = row.padding
	const margin = (name: string, value: number | undefined): string =>
		value === undefined ? "" : `<w:${name}${attr("w:w", clamp(value, 0, 31680))} w:type="dxa"/>`
	const margins =
		margin("top", top) + margin("left", left ?? row.gapHalf) + margin("bottom", bottom) + margin("right", right ?? row.gapHalf)

	if (margins !== "") out += `<w:tblCellMar>${margins}</w:tblCellMar>`

	return out
}

function rowPr(row: DocRow | undefined, before: number, grid: readonly number[], after: number): string {
	let out = ""

	if (before > 0) out += val("gridBefore", before)
	if (after > 0) out += val("gridAfter", after)
	if (before > 0) out += `<w:wBefore${attr("w:w", clamp((grid[before] ?? 0) - (grid[0] ?? 0), 0, 31680))} w:type="dxa"/>`
	if (after > 0)
		out += `<w:wAfter${attr("w:w", clamp((grid.at(-1) ?? 0) - (grid[grid.length - 1 - after] ?? 0), 0, 31680))} w:type="dxa"/>`

	if (row !== undefined) {
		if (row.cantSplit) out += "<w:cantSplit/>"
		if (row.height !== 0)
			out += `<w:trHeight${attr("w:val", clamp(Math.abs(row.height), 0, 31680))}${row.height < 0 ? ' w:hRule="exact"' : ' w:hRule="atLeast"'}/>`
		if (row.header) out += "<w:tblHeader/>"
	}

	return out === "" ? "" : `<w:trPr>${out}</w:trPr>`
}

const TEXT_FLOWS: Readonly<Record<number, string>> = { 1: "tbRl", 3: "btLr", 4: "lrTbV", 5: "tbRlV", 7: "tbLrV" }

function cellPr(cell: DocCell | undefined, span: number, cellWidth: number | undefined, context: PropsContext): string {
	const tcW =
		cellWidth === undefined || cell === undefined
			? '<w:tcW w:w="0" w:type="auto"/>'
			: `<w:tcW${attr("w:w", clamp(cellWidth, 0, 31680))} w:type="dxa"/>`

	if (cell === undefined) return tcW + (span > 1 ? val("gridSpan", span) : "")

	let out = tcW

	if (span > 1) out += val("gridSpan", span)
	if (cell.vertMerge === 3) out += '<w:vMerge w:val="restart"/>'
	else if (cell.vertMerge === 2 || cell.vertMerge === 1) out += "<w:vMerge/>"

	const borders = [
		border("top", cell.borderTop, context),
		border("left", cell.borderLeft, context),
		border("bottom", cell.borderBottom, context),
		border("right", cell.borderRight, context)
	].join("")

	if (borders !== "") out += `<w:tcBorders>${borders}</w:tcBorders>`
	if (cell.shading !== undefined) out += shading(cell.shading)
	if (cell.noWrap) out += "<w:noWrap/>"

	const flow = TEXT_FLOWS[cell.textFlow]

	if (flow !== undefined) out += val("textDirection", flow)
	if (cell.fitText) out += "<w:tcFitText/>"
	if (cell.vertAlign !== 0) out += val("vAlign", cell.vertAlign === 1 ? "center" : "bottom")
	if (cell.hideMark) out += "<w:hideMark/>"

	return out
}

// The blocks of a story lying in [start, end) (headers, notes and comments are ranges of one story).
function blocksIn(model: DocModel, blocks: readonly DocBlock[], start: number, end: number): readonly DocBlock[] {
	const first = (block: DocBlock): number => {
		if (block.kind === "paragraph") return model.paragraphs[block.index]?.start ?? 0

		for (const row of block.rows) for (const cell of row.cells) for (const inner of cell) return first(inner)

		return block.rows[0]?.mark !== undefined && block.rows[0].mark >= 0 ? (model.paragraphs[block.rows[0].mark]?.start ?? 0) : 0
	}

	return blocks.filter(block => {
		const at = first(block)

		return at >= start && at < end
	})
}

// MSOSPT (§2.4.24) → DrawingML preset geometry for the shapes converted as such.
const PRESETS: ReadonlyMap<number, string> = new Map([
	[1, "rect"],
	[2, "roundRect"],
	[3, "ellipse"],
	[4, "diamond"],
	[5, "triangle"],
	[6, "rtTriangle"],
	[7, "parallelogram"],
	[8, "trapezoid"],
	[9, "hexagon"],
	[10, "octagon"],
	[11, "plus"],
	[12, "star5"],
	[13, "rightArrow"],
	[15, "homePlate"],
	[16, "cube"],
	[20, "line"],
	[22, "can"],
	[23, "donut"],
	[32, "straightConnector1"],
	[66, "leftArrow"],
	[67, "downArrow"],
	[68, "upArrow"],
	[69, "leftRightArrow"],
	[70, "upDownArrow"],
	[74, "heart"],
	[96, "smileyFace"],
	[109, "flowChartProcess"],
	[110, "flowChartDecision"],
	[111, "flowChartInputOutput"],
	[116, "flowChartTerminator"],
	[120, "flowChartConnector"],
	[176, "flowChartAlternateProcess"],
	[183, "sun"],
	[184, "moon"],
	[202, "rect"]
])

function shapeTransform(shape: ArtShape): Transform {
	const rotation = shape.properties.get(PID.rotation)?.value
	const degrees = rotation === undefined ? 0 : (rotation | 0) / 65536

	return {
		rotation: Math.round((((degrees % 360) + 360) % 360) * 60000),
		flipH: (shape.flags & 0x40) !== 0,
		flipV: (shape.flags & 0x80) !== 0
	}
}

function shapeLook(shape: ArtShape, preset: string, textBox: boolean): ShapeLook {
	const props = shape.properties
	// fFilled (bit 4 of the fill booleans) and fLine (bit 3 of the line booleans) default to on.
	const filled = booleanProperty(props, PID.fillStyleBooleans, 4) ?? true
	const lined = booleanProperty(props, PID.lineStyleBooleans, 3) ?? true
	const line = preset === "line" || preset === "straightConnector1"
	const fill =
		filled && !line ? (artColor(props.get(PID.fillColor)?.value) ?? (props.has(PID.fillColor) ? 0xffffff : 0xffffff)) : undefined

	return {
		preset,
		fill,
		line: lined ? (artColor(props.get(PID.lineColor)?.value) ?? 0) : undefined,
		lineWidth: props.get(PID.lineWidth)?.value ?? 9525,
		textBox,
		insets: [
			props.get(PID.dxTextLeft)?.value ?? 91440,
			props.get(PID.dyTextTop)?.value ?? 45720,
			props.get(PID.dxTextRight)?.value ?? 91440,
			props.get(PID.dyTextBottom)?.value ?? 45720
		]
	}
}
