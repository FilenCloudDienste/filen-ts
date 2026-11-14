import {
	PDF_PRESET_STAMPS,
	PDF_REVIEW_STATES,
	type PdfLineEnding,
	type PdfMarkupKind,
	type PdfPoint,
	type PdfPresetStamp,
	type PdfQuad,
	type PdfRect,
	type PdfReviewState,
	type PdfRgb,
	type PdfTextAlign,
	type PdfTextFont
} from "../../../core/pdfedit/annotations"
import {
	addImageStamp,
	addInk,
	addInkStroke,
	addLine,
	addPresetStamp,
	addReply,
	addShape,
	addStickyNote,
	addTextBox,
	addTextMarkup,
	deleteAnnotation,
	flattenAnnotations,
	moveAnnotation,
	PdfAnnotationError,
	resizeAnnotation,
	setAnnotationStyle,
	setAnnotationText,
	setReviewState,
	withPageScope,
	type PdfAnnotationStyle,
	type PdfCreated
} from "../annotations/index"
import { PdfEngineRefusal } from "../context"
import { isIndex, isRecord, isText, type PdfCommandContext, type PdfCommandOutcome, type PdfCommandTable } from "./types"

// Annotations and comments (dom/pdfedit/annotations) as editor commands: each is one journal operation, its arguments
// checked here (they arrive structured-cloned), its author and text carried in them so a rebuild replays it alike.
// Geometry is MuPDF page space (points, origin at the page's top left, y down). A command that makes an annotation
// reports it, so the page selects it (and the ink tool adds its next stroke to it). Locked annotations are refused
// ("notAllowed"); a missing one or malformed geometry is a "badRequest".

// The longest text a note, text box or reply takes, and an author's name.
const MAX_TEXT = 100_000
const MAX_AUTHOR = 256
// The largest encoded image a stamp takes (the host scales pictures down before).
export const PDF_STAMP_MAX_BYTES = 16 * 1024 * 1024
// The most quads one markup takes (a drag over a few pages' worth of lines).
const MAX_QUADS = 4096

const MARKUPS: readonly PdfMarkupKind[] = ["Highlight", "Underline", "StrikeOut", "Squiggly"]
const ENDINGS: readonly PdfLineEnding[] = [
	"None",
	"Square",
	"Circle",
	"Diamond",
	"OpenArrow",
	"ClosedArrow",
	"Butt",
	"ROpenArrow",
	"RClosedArrow",
	"Slash"
]
const FONTS: readonly PdfTextFont[] = ["Helv", "TiRo", "Cour"]
const ALIGNS: readonly PdfTextAlign[] = ["left", "center", "right"]

interface Target {
	readonly page: number
	readonly id: number
}

interface Authored {
	readonly page: number
	readonly author: string
}

interface Stroke {
	readonly color?: PdfRgb
	readonly width?: number
	readonly opacity?: number
}

export interface PdfAnnotationCommands {
	"annotations.textBox": Authored & {
		readonly rect: PdfRect
		readonly text: string
		readonly font: PdfTextFont
		readonly size: number
		readonly color: PdfRgb
		readonly align: PdfTextAlign
	}
	"annotations.ink": Authored & Stroke & { readonly strokes: readonly (readonly PdfPoint[])[] }
	"annotations.inkStroke": Target & { readonly stroke: readonly PdfPoint[] }
	// Over `quads`, or over the text between `from` and `to` (the page's structured text finds the quads).
	"annotations.markup": Authored & {
		readonly kind: PdfMarkupKind
		readonly quads?: readonly PdfQuad[]
		readonly from?: PdfPoint
		readonly to?: PdfPoint
		readonly color?: PdfRgb
		readonly opacity?: number
	}
	"annotations.shape": Authored & Stroke & { readonly kind: "Square" | "Circle"; readonly rect: PdfRect; readonly fill?: PdfRgb }
	"annotations.line": Authored &
		Stroke & { readonly from: PdfPoint; readonly to: PdfPoint; readonly start?: PdfLineEnding; readonly end?: PdfLineEnding }
	"annotations.image": Authored & { readonly rect: PdfRect; readonly image: Uint8Array }
	"annotations.stamp": Authored & { readonly rect: PdfRect; readonly name: PdfPresetStamp }
	"annotations.note": Authored & { readonly at: PdfPoint; readonly text: string; readonly color?: PdfRgb }
	"annotations.move": Target & { readonly dx: number; readonly dy: number }
	"annotations.resize": Target & { readonly rect: PdfRect }
	"annotations.style": Target & { readonly style: PdfAnnotationStyle }
	"annotations.text": Target & { readonly text: string }
	"annotations.delete": Target
	"annotations.reply": Target & { readonly text: string; readonly author: string }
	"annotations.state": Target & { readonly state: PdfReviewState; readonly author: string }
	// Every annotation drawn into its page (the save option "Flatten annotations").
	"annotations.flatten": Record<string, never>
}

// --- Argument checks ---

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

function numbers(value: unknown, length: number): number[] | null {
	return Array.isArray(value) && value.length === length && value.every(isNumber) ? (value as number[]) : null
}

function point(value: unknown): PdfPoint | null {
	const pair = numbers(value, 2)

	return pair === null ? null : [pair[0] ?? 0, pair[1] ?? 0]
}

function rect(value: unknown): PdfRect | null {
	const four = numbers(value, 4)

	return four === null ? null : [four[0] ?? 0, four[1] ?? 0, four[2] ?? 0, four[3] ?? 0]
}

function quad(value: unknown): PdfQuad | null {
	const eight = numbers(value, 8)

	return eight === null
		? null
		: [eight[0] ?? 0, eight[1] ?? 0, eight[2] ?? 0, eight[3] ?? 0, eight[4] ?? 0, eight[5] ?? 0, eight[6] ?? 0, eight[7] ?? 0]
}

function rgb(value: unknown): PdfRgb | null {
	const three = numbers(value, 3)

	return three === null || !three.every(component => component >= 0 && component <= 1)
		? null
		: [three[0] ?? 0, three[1] ?? 0, three[2] ?? 0]
}

function points(value: unknown): PdfPoint[] | null {
	if (!Array.isArray(value) || value.length === 0) return null

	const out: PdfPoint[] = []

	for (const entry of value) {
		const parsed = point(entry)

		if (parsed === null) return null

		out.push(parsed)
	}

	return out
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function target(args: unknown): Target | null {
	return isRecord(args) && isIndex(args["page"]) && isIndex(args["id"]) ? { page: args["page"], id: args["id"] } : null
}

function authored(args: unknown): Authored | null {
	return isRecord(args) && isIndex(args["page"]) && isText(args["author"], MAX_AUTHOR)
		? { page: args["page"], author: args["author"] }
		: null
}

// The optional stroke style; null when one given is malformed.
function stroke(args: Readonly<Record<string, unknown>>): Stroke | null {
	const out: { color?: PdfRgb; width?: number; opacity?: number } = {}

	if (args["color"] !== undefined) {
		const color = rgb(args["color"])

		if (color === null) return null

		out.color = color
	}

	for (const key of ["width", "opacity"] as const) {
		const value = args[key]

		if (value === undefined) continue
		if (!isNumber(value) || value < 0) return null

		out[key] = value
	}

	return out
}

// Fields that must be absent or valid, parsed one by one: null when any is malformed.
function optional<T>(value: unknown, parse: (value: unknown) => T | null): { readonly ok: boolean; readonly value?: T } {
	if (value === undefined) return { ok: true }

	const parsed = parse(value)

	return parsed === null ? { ok: false } : { ok: true, value: parsed }
}

function parseStyle(value: unknown): PdfAnnotationStyle | null {
	if (!isRecord(value)) return null

	const color = optional(value["color"], rgb)
	const fill = value["fill"] === null ? { ok: true, value: null } : optional(value["fill"], rgb)
	const font = optional(value["font"], entry => oneOf(entry, FONTS))
	const align = optional(value["align"], entry => oneOf(entry, ALIGNS))
	const numeric = (entry: unknown): number | null => (isNumber(entry) && entry >= 0 ? entry : null)
	const opacity = optional(value["opacity"], numeric)
	const width = optional(value["width"], numeric)
	const size = optional(value["size"], numeric)
	const endings = optional(value["lineEndings"], entry => {
		if (!isRecord(entry)) return null

		const start = oneOf(entry["start"], ENDINGS)
		const end = oneOf(entry["end"], ENDINGS)

		return start === null || end === null ? null : { start, end }
	})

	if (![color, fill, font, align, opacity, width, size, endings].every(entry => entry.ok)) return null

	return {
		...(color.value === undefined ? {} : { color: color.value }),
		...(fill.value === undefined ? {} : { fill: fill.value }),
		...(font.value === undefined ? {} : { font: font.value }),
		...(align.value === undefined ? {} : { align: align.value }),
		...(opacity.value === undefined ? {} : { opacity: opacity.value }),
		...(width.value === undefined ? {} : { width: width.value }),
		...(size.value === undefined ? {} : { size: size.value }),
		...(endings.value === undefined ? {} : { lineEndings: endings.value })
	}
}

// --- Running ---

// Runs an annotation function with its pages closed afterwards, its errors as the editor's refusals.
function guarded<T>(context: PdfCommandContext, run: () => T): T {
	try {
		return withPageScope(context.document, run)
	} catch (error) {
		if (error instanceof PdfAnnotationError) {
			throw new PdfEngineRefusal(error.reason === "locked" ? "notAllowed" : "badRequest", error.message)
		}

		throw error
	}
}

function made(created: PdfCreated): PdfCommandOutcome {
	return { pages: created.pages, created: created.ref }
}

function checkPage(context: PdfCommandContext, page: number): void {
	if (page >= context.document.countPages()) throw new PdfEngineRefusal("badRequest", "no such page")
}

// The quads of the text between two points of a page, from its structured text (what a drag over text marks).
export function textQuadsBetween(context: PdfCommandContext, page: number, from: PdfPoint, to: PdfPoint): PdfQuad[] {
	checkPage(context, page)

	const text = context.page(page).toStructuredText("preserve-whitespace")

	try {
		return text.highlight([from[0], from[1]], [to[0], to[1]], MAX_QUADS).map(entry => quad(entry) ?? [0, 0, 0, 0, 0, 0, 0, 0])
	} finally {
		text.destroy()
	}
}

export const ANNOTATION_COMMANDS: PdfCommandTable<PdfAnnotationCommands> = {
	"annotations.textBox": {
		tool: "annotate",
		parse: args => {
			const base = authored(args)

			if (base === null || !isRecord(args)) return null

			const box = rect(args["rect"])
			const font = oneOf(args["font"], FONTS)
			const align = oneOf(args["align"], ALIGNS)
			const color = rgb(args["color"])
			const size = args["size"]

			return box === null || font === null || align === null || color === null || !isNumber(size) || !isText(args["text"], MAX_TEXT)
				? null
				: { ...base, rect: box, text: args["text"], font, size, color, align }
		},
		run: (context, args) => guarded(context, () => made(addTextBox(context.document, { ...args, now: context.now() })))
	},
	"annotations.ink": {
		tool: "annotate",
		parse: args => {
			const base = authored(args)

			if (base === null || !isRecord(args) || !Array.isArray(args["strokes"])) return null

			const style = stroke(args)
			const strokes = (args["strokes"] as unknown[]).map(points)

			return style === null || strokes.length === 0 || strokes.some(entry => entry === null)
				? null
				: { ...base, ...style, strokes: strokes.filter(entry => entry !== null) }
		},
		run: (context, args) => guarded(context, () => made(addInk(context.document, { ...args, now: context.now() })))
	},
	"annotations.inkStroke": {
		tool: "annotate",
		target: "id",
		parse: args => {
			const ref = target(args)
			const line = isRecord(args) ? points(args["stroke"]) : null

			return ref === null || line === null ? null : { ...ref, stroke: line }
		},
		run: (context, args) => guarded(context, () => addInkStroke(context.document, args, args.stroke, context.now()))
	},
	"annotations.markup": {
		tool: "annotate",
		parse: args => {
			const base = authored(args)

			if (base === null || !isRecord(args)) return null

			const kind = oneOf(args["kind"], MARKUPS)
			const color = optional(args["color"], rgb)
			const opacity = optional(args["opacity"], entry => (isNumber(entry) ? entry : null))
			const from = optional(args["from"], point)
			const to = optional(args["to"], point)
			const quads = optional(args["quads"], entry => {
				if (!Array.isArray(entry) || entry.length > MAX_QUADS) return null

				const parsed = entry.map(quad)

				return parsed.some(value => value === null) ? null : parsed.filter(value => value !== null)
			})
			const between = from.value !== undefined && to.value !== undefined

			if (kind === null || ![color, opacity, from, to, quads].every(entry => entry.ok)) return null
			// Quads, or both points of a drag.
			if (quads.value === undefined ? !between : from.value !== undefined || to.value !== undefined) return null

			return {
				...base,
				kind,
				...(quads.value === undefined ? {} : { quads: quads.value }),
				...(from.value === undefined ? {} : { from: from.value }),
				...(to.value === undefined ? {} : { to: to.value }),
				...(color.value === undefined ? {} : { color: color.value }),
				...(opacity.value === undefined ? {} : { opacity: opacity.value })
			}
		},
		run: (context, args) => {
			const quads =
				args.quads ??
				(args.from !== undefined && args.to !== undefined ? textQuadsBetween(context, args.page, args.from, args.to) : [])

			if (quads.length === 0) throw new PdfEngineRefusal("badRequest", "no text there")

			return guarded(context, () =>
				made(
					addTextMarkup(context.document, {
						page: args.page,
						author: args.author,
						now: context.now(),
						kind: args.kind,
						quads,
						...(args.color === undefined ? {} : { color: args.color }),
						...(args.opacity === undefined ? {} : { opacity: args.opacity })
					})
				)
			)
		}
	},
	"annotations.shape": {
		tool: "annotate",
		parse: args => {
			const base = authored(args)

			if (base === null || !isRecord(args)) return null

			const kind = oneOf(args["kind"], ["Square", "Circle"] as const)
			const box = rect(args["rect"])
			const style = stroke(args)
			const fill = optional(args["fill"], rgb)

			return kind === null || box === null || style === null || !fill.ok
				? null
				: { ...base, ...style, kind, rect: box, ...(fill.value === undefined ? {} : { fill: fill.value }) }
		},
		run: (context, args) => guarded(context, () => made(addShape(context.document, { ...args, now: context.now() })))
	},
	"annotations.line": {
		tool: "annotate",
		parse: args => {
			const base = authored(args)

			if (base === null || !isRecord(args)) return null

			const from = point(args["from"])
			const to = point(args["to"])
			const style = stroke(args)
			const start = optional(args["start"], entry => oneOf(entry, ENDINGS))
			const end = optional(args["end"], entry => oneOf(entry, ENDINGS))

			return from === null || to === null || style === null || !start.ok || !end.ok
				? null
				: {
						...base,
						...style,
						from,
						to,
						...(start.value === undefined ? {} : { start: start.value }),
						...(end.value === undefined ? {} : { end: end.value })
					}
		},
		run: (context, args) => guarded(context, () => made(addLine(context.document, { ...args, now: context.now() })))
	},
	"annotations.image": {
		tool: "annotate",
		bytes: args => args.image.byteLength,
		parse: args => {
			const base = authored(args)

			if (base === null || !isRecord(args)) return null

			const box = rect(args["rect"])
			const image = args["image"]

			return box === null || !(image instanceof Uint8Array) || image.byteLength === 0 || image.byteLength > PDF_STAMP_MAX_BYTES
				? null
				: { ...base, rect: box, image }
		},
		run: (context, args) => {
			checkPage(context, args.page)

			return guarded(context, () => made(addImageStamp(context.mupdf, context.document, { ...args, now: context.now() })))
		}
	},
	"annotations.stamp": {
		tool: "annotate",
		parse: args => {
			const base = authored(args)

			if (base === null || !isRecord(args)) return null

			const box = rect(args["rect"])
			const name = oneOf(args["name"], PDF_PRESET_STAMPS)

			return box === null || name === null ? null : { ...base, rect: box, name }
		},
		run: (context, args) => guarded(context, () => made(addPresetStamp(context.document, { ...args, now: context.now() })))
	},
	"annotations.note": {
		tool: "annotate",
		parse: args => {
			const base = authored(args)

			if (base === null || !isRecord(args)) return null

			const at = point(args["at"])
			const color = optional(args["color"], rgb)

			return at === null || !color.ok || !isText(args["text"], MAX_TEXT)
				? null
				: { ...base, at, text: args["text"], ...(color.value === undefined ? {} : { color: color.value }) }
		},
		run: (context, args) => guarded(context, () => made(addStickyNote(context.document, { ...args, now: context.now() })))
	},
	"annotations.move": {
		tool: "annotate",
		target: "id",
		parse: args => {
			const ref = target(args)

			return ref === null || !isRecord(args) || !isNumber(args["dx"]) || !isNumber(args["dy"])
				? null
				: { ...ref, dx: args["dx"], dy: args["dy"] }
		},
		run: (context, args) => guarded(context, () => moveAnnotation(context.document, args, args.dx, args.dy, context.now()))
	},
	"annotations.resize": {
		tool: "annotate",
		target: "id",
		parse: args => {
			const ref = target(args)
			const box = isRecord(args) ? rect(args["rect"]) : null

			return ref === null || box === null ? null : { ...ref, rect: box }
		},
		run: (context, args) => guarded(context, () => resizeAnnotation(context.document, args, args.rect, context.now()))
	},
	"annotations.style": {
		tool: "annotate",
		target: "id",
		parse: args => {
			const ref = target(args)
			const style = isRecord(args) ? parseStyle(args["style"]) : null

			return ref === null || style === null ? null : { ...ref, style }
		},
		run: (context, args) => guarded(context, () => setAnnotationStyle(context.document, args, args.style, context.now()))
	},
	"annotations.text": {
		tool: "annotate",
		target: "id",
		parse: args => {
			const ref = target(args)

			return ref === null || !isRecord(args) || !isText(args["text"], MAX_TEXT) ? null : { ...ref, text: args["text"] }
		},
		run: (context, args) => guarded(context, () => setAnnotationText(context.document, args, args.text, context.now()))
	},
	"annotations.delete": {
		tool: "annotate",
		target: "id",
		parse: target,
		run: (context, args) => guarded(context, () => deleteAnnotation(context.document, args))
	},
	"annotations.reply": {
		tool: "annotate",
		target: "id",
		parse: args => {
			const ref = target(args)

			return ref === null || !isRecord(args) || !isText(args["text"], MAX_TEXT) || !isText(args["author"], MAX_AUTHOR)
				? null
				: { ...ref, text: args["text"], author: args["author"] }
		},
		run: (context, args) =>
			guarded(context, () => made(addReply(context.document, args, { text: args.text, author: args.author, now: context.now() })))
	},
	"annotations.state": {
		tool: "annotate",
		target: "id",
		parse: args => {
			const ref = target(args)
			const state = isRecord(args) ? oneOf(args["state"], PDF_REVIEW_STATES) : null

			return ref === null || state === null || !isRecord(args) || !isText(args["author"], MAX_AUTHOR)
				? null
				: { ...ref, state, author: args["author"] }
		},
		run: (context, args) =>
			guarded(context, () => setReviewState(context.document, args, { state: args.state, author: args.author, now: context.now() }))
	},
	"annotations.flatten": {
		// Drawn into the page content, the annotations stop being annotations.
		tool: "content",
		parse: args => (isRecord(args) && Object.keys(args).length === 0 ? {} : null),
		run: context => guarded(context, () => flattenAnnotations(context.document))
	}
}
