import { emphasisRoom, runEffect, runEmphasis, type Emphasis, type RunEffect } from "./effects"
import { equationAuthors } from "./objects"
import {
	cssFont,
	forEachSlotRun,
	isChineseLanguage,
	symbolTable,
	symbolText,
	type FontRequest,
	type FontSlot,
	type ResolvedFont,
	type SymbolTable
} from "../../fonts/index"
import { SYMBOL_FALLBACK_METRICS } from "../../fonts/metrics"
import { Caps, Strike, verticalAlignment, type StyleTable, type TextStyle } from "../../text/index"
import type { DocxModel } from "../model/index"
import type { ResolvedBorder, ResolvedRunProps, ResolvedShading } from "../props/types"
import { shadingColor } from "../theme/color"
import { eighthPoints, halfPoints, points, twips } from "./units"

// What layout needs from a font manager (FontManager satisfies it): faces are loaded by prepare() and
// resolve() must only be trusted for requests that were prepared.
export interface FontSource {
	prepare(requests: Iterable<FontRequest>): Promise<void>
	resolve(request: FontRequest): ResolvedFont
}

// Tracked-change look of a run in the Markup view.
export const TrackedLook = { NONE: 0, INSERTED: 1, DELETED: 2, MOVED_FROM: 3, MOVED_TO: 4 } as const

export type TrackedLook = (typeof TrackedLook)[keyof typeof TrackedLook]

// Authors told apart by colour (more wrap around); index -1 is a change without an author.
export const REVISION_AUTHOR_COLORS = 8

// A tracked look with its author's colour slot packed in (0: no author, 1..8 an author's colour): what text
// styles key on in the Markup view.
export function revisionLook(look: TrackedLook, author: number): TrackedLook {
	if (look === TrackedLook.NONE) return look

	const slot = author < 0 ? REVISION_AUTHOR_COLORS : (author % REVISION_AUTHOR_COLORS) + 1

	return (look | (slot << 3)) as TrackedLook
}

// Reviewers numbered as Word numbers them: people.xml first, then comment authors, then the authors of tracked
// changes in document order (by part); names met later (edits) are numbered after them.
export interface RevisionAuthors {
	readonly names: readonly string[]
	index(name: string | undefined): number
}

export function revisionAuthors(model: DocxModel): RevisionAuthors {
	const names: string[] = []
	const indices = new Map<string, number>()
	const index = (name: string | undefined): number => {
		const trimmed = name?.trim() ?? ""

		if (trimmed.length === 0) return -1

		let at = indices.get(trimmed)

		if (at === undefined) {
			at = names.length
			names.push(trimmed)
			indices.set(trimmed, at)
		}

		return at
	}

	for (const person of model.people) index(person.author)
	for (const comment of model.comments) index(comment.author)

	// Parts an editing layout dropped are gone from the list.
	for (let part = 0; part < model.parts.length; part++) {
		const table = model.parts[part]?.revisions

		if (table === undefined) continue

		for (let row = 0; row < table.count; row++) index(model.string(table.author[row] ?? -1))
	}

	// Equations are one item each: the authors of the changes inside them are in no revision table.
	for (const part of model.parts) if (part !== undefined) for (const author of equationAuthors(part)) index(author)

	return { names, index }
}

const sharedAuthors = new WeakMap<DocxModel, RevisionAuthors>()

// Reviewers of a model numbered once for every surface drawing their colours (the pages' text and equations,
// the balloons, Mobile view): authors met later (an author new in the session) are appended to this one list,
// so each keeps one colour everywhere.
export function modelAuthors(model: DocxModel): RevisionAuthors {
	let authors = sharedAuthors.get(model)

	if (authors === undefined) {
		authors = revisionAuthors(model)
		sharedAuthors.set(model, authors)
	}

	return authors
}

export type DecorationValue =
	| { readonly kind: "color"; readonly color: string }
	| { readonly kind: "underline"; readonly style: string; readonly color: string | undefined }
	| {
			readonly kind: "border"
			readonly style: string
			// px
			readonly width: number
			readonly space: number
			readonly color: string | undefined
			readonly shadow: boolean
	  }
	// Tracked-change marks: the renderer picks the author's colour.
	| { readonly kind: "revision"; readonly mark: TrackedLook }

// Interned decoration values; key 0 means none, so keys are 1-based indices into `values` + 1.
export class DecorationTable {
	readonly values: DecorationValue[] = []
	private readonly keys = new Map<string, number>()
	// Resolved borders and shadings are interned by the resolver: their keys are looked up by identity.
	private readonly borders = new WeakMap<ResolvedBorder, number>()
	private readonly shadings = new WeakMap<ResolvedShading, number>()

	private intern(signature: string, value: DecorationValue): number {
		let key = this.keys.get(signature)

		if (key === undefined) {
			this.values.push(value)
			key = this.values.length
			this.keys.set(signature, key)
		}

		return key
	}

	get(key: number): DecorationValue | undefined {
		return this.values[key - 1]
	}

	color(color: string | undefined): number {
		return color === undefined ? 0 : this.intern(`c${color}`, { kind: "color", color })
	}

	shading(shading: ResolvedShading | undefined): number {
		if (shading === undefined) return 0

		let key = this.shadings.get(shading)

		if (key === undefined) {
			key = this.color(shadingColor(shading.pattern, shading.color, shading.fill))
			this.shadings.set(shading, key)
		}

		return key
	}

	underline(style: string, color: string | undefined): number {
		return this.intern(`u${style}|${color ?? ""}`, { kind: "underline", style, color })
	}

	border(border: ResolvedBorder | undefined): number {
		if (border === undefined) return 0

		const cached = this.borders.get(border)

		if (cached !== undefined) return cached

		const width = borderWidth(border)
		const key = this.intern(`b${border.style}|${width}|${border.space}|${border.color ?? ""}|${border.shadow ? 1 : 0}`, {
			kind: "border",
			style: border.style,
			width,
			space: points(border.space),
			color: border.color,
			shadow: border.shadow
		})

		this.borders.set(border, key)

		return key
	}

	revision(mark: TrackedLook): number {
		return mark === TrackedLook.NONE ? 0 : this.intern(`r${mark}`, { kind: "revision", mark })
	}
}

function fontKey(request: FontRequest): string {
	return `${request.family.toLowerCase()}\u0000${request.bold ? 1 : 0}${request.italic ? 1 : 0}${request.slot}`
}

// Drawn thickness of a border in px. Double and multi-line styles take more room than their stroke width.
export function borderWidth(border: ResolvedBorder): number {
	// Padding kept as a border that draws nothing (StyleSettings.paddingBorders).
	if (border.style === "none") return 0

	const size = eighthPoints(border.size > 0 ? border.size : 2)

	switch (border.style) {
		case "double":
			return size * 3
		case "triple":
			return size * 5
		case "thinThickSmallGap":
		case "thickThinSmallGap":
		case "thinThickMediumGap":
		case "thickThinMediumGap":
		case "thinThickLargeGap":
		case "thickThinLargeGap":
			return size * 2
		default:
			return size
	}
}

// What the renderer needs per text style id besides TextStyle.
export interface RunStyleInfo {
	readonly css: string
	readonly color: string | undefined
	readonly run: ResolvedRunProps | undefined
	readonly revision: TrackedLook
	// The colour slot of the change's author (1..8), 0 without a tracked change.
	readonly author: number
	// Character effect and emphasis mark drawn (effects.ts).
	readonly effect: RunEffect
	readonly emphasis: Emphasis
}

const SLOT_INDEX: Readonly<Record<FontSlot, number>> = { ascii: 0, hAnsi: 1, eastAsia: 2, cs: 3 }

// Automatic text over a fill darker than this (perceived brightness, 0..1) is drawn white, as Word draws it.
export const AUTO_TEXT_DARK = 0.5
const AUTO_TEXT_LIGHT_COLOR = "FFFFFF"
const darkFills = new Map<string, boolean>()
const darkShadings = new WeakMap<ResolvedShading, boolean | undefined>()

// Whether `fill` (RRGGBB) is dark enough for automatic text to turn white.
export function darkFill(fill: string): boolean {
	let dark = darkFills.get(fill)

	if (dark === undefined) {
		const value = Number.parseInt(fill, 16)

		dark =
			/^[0-9A-Fa-f]{6}$/.test(fill) &&
			(((value >> 16) & 255) * 0.299 + ((value >> 8) & 255) * 0.587 + (value & 255) * 0.114) / 255 < AUTO_TEXT_DARK
		darkFills.set(fill, dark)
	}

	return dark
}

// Whether a shading darkens automatic text; undefined when it paints nothing (what lies behind it shows).
export function shadingDark(shading: ResolvedShading): boolean | undefined {
	if (darkShadings.has(shading)) return darkShadings.get(shading)

	const color = shadingColor(shading.pattern, shading.color, shading.fill)
	const dark = color === undefined ? undefined : darkFill(color)

	darkShadings.set(shading, dark)

	return dark
}
const NON_ASCII = /[^ -~\t\n\r]/

// Maps resolved run formatting to core/text styles, one TextStyle per distinct look, and tracks the fonts
// that were needed before they were prepared.
export class RunStyles {
	readonly table: StyleTable
	readonly decorations: DecorationTable
	readonly info: RunStyleInfo[] = []
	readonly missing: FontRequest[] = []
	private readonly fonts: FontSource
	private readonly byKey = new Map<number, number>()
	private readonly byFont = new Map<string, number>()
	private readonly prepared = new Set<string>()
	private readonly pending = new Set<string>()
	private readonly loads = new Set<Promise<void>>()
	// Per style, the code table of a symbol font drawn without the font itself, whose characters must be
	// drawn as the Unicode characters they show.
	private readonly symbols: (SymbolTable | undefined)[] = []
	// Whether the fill behind the text being laid out (paragraph, cell or table shading) is dark: automatic
	// text over it is drawn white unless the run's own highlight or shading lies between.
	darkBackground = false

	constructor(table: StyleTable, fonts: FontSource, decorations: DecorationTable) {
		this.table = table
		this.fonts = fonts
		this.decorations = decorations
	}

	// Fonts styles were made without are not loaded yet (requested, or loading).
	get hasMissing(): boolean {
		return this.missing.length > 0 || this.pending.size > 0
	}

	// Loads the missing fonts, those requested while loading too; styles needing them can be made afterwards.
	async prepareMissing(): Promise<void> {
		for (;;) {
			if (this.missing.length > 0) {
				const requests = this.missing.splice(0)
				const keys = requests.map(fontKey)
				const done = (): void => {
					for (const key of keys) {
						this.prepared.add(key)
						this.pending.delete(key)
					}
				}
				const load = this.fonts.prepare(requests).then(done, done)

				this.loads.add(load)
				void load.then(() => this.loads.delete(load))
			}

			if (this.loads.size === 0) return

			await Promise.all(this.loads)
		}
	}

	// Requests for fonts layout will need, prepared ahead.
	async prepare(requests: readonly FontRequest[]): Promise<void> {
		for (const request of requests) this.need(request)

		await this.prepareMissing()
	}

	// The style for a run's text drawn from `slot`; `fontOverride` names the family instead (w:sym).
	style(run: ResolvedRunProps, slot: FontSlot, revision: TrackedLook = TrackedLook.NONE, fontOverride?: string): number {
		const light = this.lightText(run)

		if (fontOverride !== undefined) {
			const key = `${run.id}|${revision}|${fontOverride}|${light ? 1 : 0}`
			const cached = this.byFont.get(key)

			if (cached !== undefined) return cached

			const made = this.make(run, slot, revision, fontOverride, light)

			if (made.cacheable) this.byFont.set(key, made.id)

			return made.id
		}

		// Slots drawn with the same family share a style, so text switching between them stays one fragment.
		if (slot === "hAnsi" && run.fonts.hAnsi === run.fonts.ascii) slot = "ascii"
		else if (slot === "eastAsia" && run.fonts.eastAsiaUsesAscii) slot = "ascii"

		const key = ((run.id * 4 + SLOT_INDEX[slot]) * 128 + revision) * 2 + (light ? 1 : 0)
		const cached = this.byKey.get(key)

		if (cached !== undefined) return cached

		const made = this.make(run, slot, revision, undefined, light)

		if (made.cacheable) this.byKey.set(key, made.id)

		return made.id
	}

	// `text` as `style` draws it: a symbol font's codes become Unicode characters when the font is missing.
	drawn(style: number, text: string): string {
		const table = this.symbols[style]

		return table === undefined ? text : symbolText(table, text)
	}

	// Calls `out` for each stretch of `text` drawn by one style.
	forEachStyle(
		text: string,
		run: ResolvedRunProps,
		revision: TrackedLook,
		out: (start: number, end: number, style: number) => void
	): void {
		if (run.cs || run.rtl) {
			out(0, text.length, this.style(run, "cs", revision))

			return
		}

		if (!NON_ASCII.test(text)) {
			out(0, text.length, this.style(run, "ascii", revision))

			return
		}

		forEachSlotRun(
			text,
			{
				hint: run.fonts.hint,
				complexScript: false,
				chineseLanguage: isChineseLanguage(run.lang.eastAsia),
				chineseFontCharset: false
			},
			(start, end, slot) => out(start, end, this.style(run, slot, revision))
		)
	}

	// Whether the run's automatic colour turns white over what lies behind it: its highlight, its shading, then
	// the background (darkBackground).
	private lightText(run: ResolvedRunProps): boolean {
		if (run.color !== undefined) return false
		if (run.highlight !== undefined) return darkFill(run.highlight)

		const shading = run.shading === undefined ? undefined : shadingDark(run.shading)

		return shading ?? this.darkBackground
	}

	private need(request: FontRequest): boolean {
		const key = fontKey(request)

		if (this.prepared.has(key)) return true

		if (!this.pending.has(key)) {
			this.pending.add(key)
			this.missing.push(request)
		}

		return false
	}

	private make(
		run: ResolvedRunProps,
		slot: FontSlot,
		revision: TrackedLook,
		fontOverride: string | undefined,
		light: boolean
	): { id: number; cacheable: boolean } {
		const complex = slot === "cs"
		const family =
			fontOverride ??
			(slot === "ascii"
				? run.fonts.ascii
				: slot === "hAnsi"
					? run.fonts.hAnsi
					: slot === "eastAsia"
						? run.fonts.eastAsiaUsesAscii
							? run.fonts.ascii
							: run.fonts.eastAsia
						: run.fonts.cs)
		const request: FontRequest = {
			family,
			bold: complex ? run.boldCs : run.bold,
			italic: complex ? run.italicCs : run.italic,
			slot
		}
		const ready = this.need(request)
		const resolved = this.fonts.resolve(request)
		const missing = resolved.source !== "embedded" && resolved.source !== "local"
		const symbols = missing ? symbolTable(family) : undefined
		// LibreOffice measures a symbol font it lacks (a code-table font, or one named a symbol font such as Segoe UI
		// Symbol) by the one it ships for them, whatever face draws the characters (measured).
		const font =
			missing &&
			(symbols !== undefined || family.toLowerCase().includes("symbol")) &&
			(this.table.rule === "hheaGapBelow" || this.table.rule === "hhea")
				? { ...resolved, metrics: SYMBOL_FALLBACK_METRICS, metricsBasis: "original" as const }
				: resolved
		const halfPointSize = complex ? run.sizeCs : run.size
		let size = halfPoints(halfPointSize)
		let shift = halfPoints(run.position)

		if (run.vertAlign !== "baseline") {
			const aligned = verticalAlignment(size, run.vertAlign)

			size = aligned.size
			shift += aligned.baselineShift
		}

		const decorations = this.decorations
		const emphasis = runEmphasis(run)
		const color = light ? AUTO_TEXT_LIGHT_COLOR : run.color
		let underline = run.underline === undefined ? 0 : decorations.underline(run.underline.style, run.underline.color ?? color)
		let strike: Strike = run.doubleStrike ? Strike.DOUBLE : run.strike ? Strike.SINGLE : Strike.NONE
		const author = revision >> 3

		revision = (revision & 7) as TrackedLook

		if (revision === TrackedLook.INSERTED || revision === TrackedLook.MOVED_TO) {
			underline = decorations.underline(revision === TrackedLook.MOVED_TO ? "double" : "single", undefined)
		} else if (revision === TrackedLook.DELETED || revision === TrackedLook.MOVED_FROM) {
			strike = revision === TrackedLook.MOVED_FROM ? Strike.DOUBLE : Strike.SINGLE
		}

		const style: TextStyle = {
			font,
			size,
			kerning: run.kern > 0 && halfPointSize >= run.kern,
			letterSpacing: twips(run.spacing),
			scaleX: run.scale > 0 ? run.scale / 100 : 1,
			caps: run.caps ? Caps.CAPS : run.smallCaps ? Caps.SMALL_CAPS : Caps.NONE,
			baselineShift: shift,
			underline,
			underlineWords: run.underline?.style === "words",
			strike,
			highlight: decorations.color(run.highlight),
			shading: decorations.shading(run.shading),
			border: decorations.border(run.border),
			marks: emphasisRoom(emphasis)
		}
		const id = this.table.add(style)

		this.info[id] = {
			css: cssFont(font, size),
			color,
			run,
			revision,
			author: revision === TrackedLook.NONE ? 0 : author,
			effect: runEffect(run),
			emphasis
		}
		this.symbols[id] = symbols

		return { id, cacheable: ready }
	}
}
