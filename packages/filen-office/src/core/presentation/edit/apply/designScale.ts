import type { ListStyle, ParaProps, RunProps, ShapeNode, Spacing, TableCellProps, TableModel, TextBody, Xfrm } from "../../model"

// What a scaled slide size change (Ensure fit, Maximize) does to content besides each shape's box, as PowerPoint
// scales a deck's content with the slide: font sizes (rPr, endParaRPr and defRPr sz, ECMA-376 Part 1 §21.1.2.3.9),
// point spacing (a:spcPts, §21.1.2.2.12), point bullet sizes (a:buSzPts, §21.1.2.4.10), paragraph and list level
// indents (pPr and lvlNpPr marL and indent), and a table's columns, rows and cell margins (a:gridCol w, a:tr h,
// a:tcPr marL/marR/marT/marB with their defaults, §21.1.3). A text body's insets (bodyPr lIns, tIns, rIns, bIns) keep
// their size, as LibreOffice 7.5 keeps a frame's padding when it scales a presentation to a new page size (measured over
// UNO, .uno:PageSize with ScaleObjects: text distances unchanged while boxes and font heights scale), so a field box
// narrowed with its slide wraps there as it does here.
//
// One walk serves both ways: scaling records each value it visits (immutable props objects and numbers, never a
// SourceRef), and the undo walks the same structure putting them back, so the inverse is exact. Bodies and tables
// are copied on write: a body two nodes share (a synthesized ODP layout's copy of its master's) is scaled once for each.

// ST_TextFontSize and ST_TextSpacingPoint (hundredths of a point); a level's size when nothing states one.
const DEFAULT_FONT_SIZE = 1800
const LEVELS = 9
const FONT_SIZE = [100, 400_000] as const
const SPACING_POINTS = [0, 158_400] as const
// ST_TextMargin and ST_TextIndent (EMU).
const MARGIN = [0, 51_206_400] as const
const INDENT = [-51_206_400, 51_206_400] as const
// CT_TableCellProperties defaults (EMU).
const MARGIN_DEFAULTS = { marL: 91_440, marR: 91_440, marT: 45_720, marB: 45_720 } as const

function clamp(value: number, [min, max]: readonly [number, number]): number {
	return Math.min(max, Math.max(min, value))
}

export class ContentScaler {
	// Recorded by a scaling walk, consumed in order by a restoring one.
	readonly values: unknown[]
	private at = 0
	private readonly scale: number | undefined

	// `scale` undefined: a restoring walk over `values`.
	constructor(scale: number | undefined, values: unknown[] = []) {
		this.scale = scale
		this.values = values
	}

	// The value that goes where `old` is: scaled (recorded), or the recorded one.
	private slot<T>(old: T, scaled: (value: T) => T): T {
		if (this.scale === undefined) return this.values[this.at++] as T

		this.values.push(old)

		return scaled(old)
	}

	private size(value: number | undefined, range: readonly [number, number]): number | undefined {
		return value === undefined || this.scale === undefined ? value : clamp(Math.round(value * this.scale), range)
	}

	private run(props: RunProps | undefined): RunProps | undefined {
		return this.slot(props, old => {
			const sz = this.size(old?.sz, FONT_SIZE)

			return old === undefined || sz === undefined || sz === old.sz ? old : { ...old, sz }
		})
	}

	private spacing(value: Spacing | undefined): Spacing | undefined {
		if (value === undefined || !("pts" in value)) return value

		const pts = this.size(value.pts, SPACING_POINTS) ?? value.pts

		return pts === value.pts ? value : { pts }
	}

	// `fill`: the level states no size of its own nor inherits one in its list, so the 18 pt default applies (§21.1.2.3.9
	// sz): written scaled.
	private para(props: ParaProps | undefined, fill = false): ParaProps | undefined {
		return this.slot(props, old => {
			if (old === undefined && !fill) return old

			const own = old?.defRPr?.sz
			const sz = own === undefined ? (fill ? this.size(DEFAULT_FONT_SIZE, FONT_SIZE) : undefined) : this.size(own, FONT_SIZE)
			const defRPr = sz === undefined || sz === own ? old?.defRPr : { ...old?.defRPr, sz }
			const lnSpc = this.spacing(old?.lnSpc)
			const spcBef = this.spacing(old?.spcBef)
			const spcAft = this.spacing(old?.spcAft)
			const buSz =
				old?.buSz !== undefined && old.buSz !== "text" && "pts" in old.buSz
					? { pts: this.size(old.buSz.pts, FONT_SIZE) ?? old.buSz.pts }
					: old?.buSz
			const marL = this.size(old?.marL, MARGIN)
			const indent = this.size(old?.indent, INDENT)
			const same =
				defRPr === old?.defRPr &&
				lnSpc === old?.lnSpc &&
				spcBef === old?.spcBef &&
				spcAft === old?.spcAft &&
				buSz === old?.buSz &&
				marL === old?.marL &&
				indent === old?.indent

			return same
				? old
				: {
						...old,
						...(defRPr === undefined ? {} : { defRPr }),
						...(lnSpc === undefined ? {} : { lnSpc }),
						...(spcBef === undefined ? {} : { spcBef }),
						...(spcAft === undefined ? {} : { spcAft }),
						...(buSz === undefined ? {} : { buSz }),
						...(marL === undefined ? {} : { marL }),
						...(indent === undefined ? {} : { indent })
					}
		})
	}

	// `fill`: a list at the root of an inheritance chain (a master's text styles, the deck's default text style), whose
	// levels without a size take the default.
	listStyle(list: ListStyle, fill = false): ListStyle {
		const def = this.para(list.def)
		const count = fill ? this.slot(list.levels.length, old => old) : list.levels.length
		const filling = fill && list.def?.defRPr?.sz === undefined
		const levels: (ParaProps | undefined)[] = []

		for (let level = 0; level < (fill ? Math.max(LEVELS, count) : count); level++) levels.push(this.para(list.levels[level], filling))

		// Back to the levels the list had (the restoring walk visits the filled ones).
		if (this.scale === undefined) levels.length = count
		else while (levels.length > count && levels[levels.length - 1] === undefined) levels.pop()

		const out: ListStyle = { levels }

		if (def !== undefined) out.def = def

		return out
	}

	body(body: TextBody): TextBody {
		const out: TextBody = { ...body, paragraphs: [] }

		if (body.lstStyle !== undefined) out.lstStyle = this.listStyle(body.lstStyle)

		for (const paragraph of body.paragraphs) {
			const pPr = this.para(paragraph.pPr) ?? paragraph.pPr
			const endRPr = this.run(paragraph.endRPr)
			const runs = paragraph.runs.map(run => {
				if (run.kind === "opaque") return run

				const rPr = this.run(run.rPr) ?? run.rPr

				return rPr === run.rPr ? run : { ...run, rPr }
			})
			const next = { ...paragraph, pPr, runs }

			if (endRPr === undefined) delete next.endRPr
			else next.endRPr = endRPr

			out.paragraphs.push(next)
		}

		return out
	}

	private length(value: number): number {
		return this.slot(value, old => (this.scale === undefined ? old : Math.round(old * this.scale)))
	}

	// A table's text, and with `geometry` (a slide's own frame; a group's child is scaled by its group) its columns,
	// rows and cell margins; `box` the frame's box before and after, the last column and row taking the rounding when
	// they filled the frame.
	table(table: TableModel, geometry: boolean, box?: { readonly before: Xfrm; readonly after: Xfrm }): TableModel {
		const fitted = (values: number[], source: readonly number[], from: number | undefined, to: number | undefined): number[] => {
			const last = values.length - 1

			if (from === undefined || to === undefined || last < 0 || source.reduce((sum, value) => sum + value, 0) !== from) return values

			values[last] = to - values.slice(0, last).reduce((sum, value) => sum + value, 0)

			return values
		}
		const heights = table.rows.map(row => row.h)
		const grid = geometry
			? fitted(
					table.grid.map(width => this.length(width)),
					table.grid,
					box?.before.cx,
					box?.after.cx
				)
			: table.grid
		const rowHeights = geometry
			? fitted(
					heights.map(height => this.length(height)),
					heights,
					box?.before.cy,
					box?.after.cy
				)
			: heights

		return {
			...table,
			grid,
			rows: table.rows.map((row, index) => ({
				...row,
				h: rowHeights[index] ?? row.h,
				cells: row.cells.map(cell => {
					const props = geometry ? this.cellProps(cell.props) : cell.props
					const next = { ...cell, text: this.body(cell.text) }

					if (props === undefined) delete next.props
					else next.props = props

					return next
				})
			}))
		}
	}

	private cellProps(props: TableCellProps | undefined): TableCellProps | undefined {
		return this.slot(props, old => {
			const scale = this.scale ?? 1
			const margin = (key: keyof typeof MARGIN_DEFAULTS): number => Math.round((old?.[key] ?? MARGIN_DEFAULTS[key]) * scale)

			return { ...old, marL: margin("marL"), marR: margin("marR"), marT: margin("marT"), marB: margin("marB") }
		})
	}
}

// Whether a shape or any shape in it is one the writer keeps as its source (locked).
export function holdsLock(shape: ShapeNode): boolean {
	return shape.lock !== undefined || (shape.children ?? []).some(holdsLock)
}

// --- Text a writer keeps as its source (a shape in mc:AlternateContent): its stated values, by attribute ---

// The kinds of value a scale rewrites in DrawingML text, by attribute: a font or point bullet size (sz, buSzPts val),
// point spacing (spcPts val) and an indent (marL, indent).
export type ScaledKind = "sz" | "pts" | "marL" | "indent"
export type ScaledValues = ReadonlyMap<ScaledKind, ReadonlyMap<number, number>>

const SCALED_TAG = /<(?:[\w.-]+:)?(rPr|defRPr|endParaRPr|buSzPts|spcPts|pPr|defPPr|lvl[1-9]pPr)\b[^>]*>/gu
const SCALED_ATTRIBUTE = /(\s)(sz|val|marL|indent)="(-?\d+)"/gu

function kindOf(tag: string, attribute: string): ScaledKind | undefined {
	if (tag === "buSzPts") return attribute === "val" ? "sz" : undefined
	if (tag === "spcPts") return attribute === "val" ? "pts" : undefined
	if (tag === "rPr" || tag === "defRPr" || tag === "endParaRPr") return attribute === "sz" ? "sz" : undefined

	return attribute === "marL" || attribute === "indent" ? attribute : undefined
}

// Each value of `markup` a scale would rewrite, as `visit` sees it; what it returns replaces the value (undefined
// keeps the markup as it is).
function eachScaled(markup: string, visit: (kind: ScaledKind, value: number) => number | undefined): string {
	return markup.replace(SCALED_TAG, (tag: string, name: string) =>
		tag.replace(SCALED_ATTRIBUTE, (whole: string, space: string, attribute: string, value: string) => {
			const kind = kindOf(name, attribute)
			const next = kind === undefined ? undefined : visit(kind, Number(value))

			return next === undefined ? whole : `${space}${attribute}="${String(next)}"`
		})
	)
}

// The values `markup` states that a scale rewrites, by kind.
export function statedValues(markup: string): Map<ScaledKind, Set<number>> {
	const out = new Map<ScaledKind, Set<number>>()

	eachScaled(markup, (kind, value) => {
		const values = out.get(kind) ?? new Set<number>()

		values.add(value)
		out.set(kind, values)

		return undefined
	})

	return out
}

// Whether every value `markup` states is one `within` states too.
export function statesWithin(markup: string, within: string): boolean {
	const known = statedValues(within)

	return [...statedValues(markup)].every(([kind, values]) => [...values].every(value => known.get(kind)?.has(value) === true))
}

// `markup` with each stated value replaced by its scaled one; undefined when it states one `values` has none for.
export function rescaleMarkup(markup: string, values: ScaledValues): string | undefined {
	let missing = false
	const out = eachScaled(markup, (kind, value) => {
		const next = values.get(kind)?.get(value)

		if (next === undefined) missing = true

		return next
	})

	return missing ? undefined : out
}

// What a scale changed in a kept shape's text (and its members'): each stated value before → after, by kind, when
// those values are all that differ between `before` and `after`'s text; undefined when anything else differs or a
// value would map two ways.
export function scaledValues(before: ShapeNode, after: ShapeNode): ScaledValues | undefined {
	const out = new Map<ScaledKind, Map<number, number>>()
	let consistent = true
	const pair = (kind: ScaledKind, from: number | undefined, to: number | undefined): void => {
		if (from === undefined || to === undefined) {
			if (from !== to) consistent = false

			return
		}

		const values = out.get(kind) ?? new Map<number, number>()
		const known = values.get(from)

		if (known !== undefined && known !== to) consistent = false

		values.set(from, to)
		out.set(kind, values)
	}
	const points = (from: Spacing | undefined, to: Spacing | undefined): void =>
		pair("pts", from !== undefined && "pts" in from ? from.pts : undefined, to !== undefined && "pts" in to ? to.pts : undefined)
	const para = (from: ParaProps | undefined, to: ParaProps | undefined): void => {
		pair("sz", from?.defRPr?.sz, to?.defRPr?.sz)
		pair("marL", from?.marL, to?.marL)
		pair("indent", from?.indent, to?.indent)
		points(from?.lnSpc, to?.lnSpc)
		points(from?.spcBef, to?.spcBef)
		points(from?.spcAft, to?.spcAft)

		const bullet = (size: ParaProps["buSz"]): number | undefined =>
			size !== undefined && size !== "text" && "pts" in size ? size.pts : undefined

		pair("sz", bullet(from?.buSz), bullet(to?.buSz))
	}
	const list = (from: ListStyle | undefined, to: ListStyle | undefined): void => {
		para(from?.def, to?.def)

		for (let level = 0; level < Math.max(from?.levels.length ?? 0, to?.levels.length ?? 0); level++)
			para(from?.levels[level], to?.levels[level])
	}
	const body = (from: TextBody | undefined, to: TextBody | undefined): void => {
		if (from === undefined || to === undefined) {
			if (from !== to) consistent = false

			return
		}

		list(from.lstStyle, to.lstStyle)

		if (from.paragraphs.length !== to.paragraphs.length) consistent = false

		from.paragraphs.forEach((paragraph, index) => {
			const next = to.paragraphs[index]

			para(paragraph.pPr, next?.pPr)
			pair("sz", paragraph.endRPr?.sz, next?.endRPr?.sz)

			if (paragraph.runs.length !== next?.runs.length) consistent = false

			paragraph.runs.forEach((run, at) => {
				const other = next?.runs[at]

				if (run.kind !== "opaque" && other !== undefined && other.kind !== "opaque") pair("sz", run.rPr?.sz, other.rPr?.sz)
			})
		})
	}
	const shape = (from: ShapeNode, to: ShapeNode): void => {
		body(from.text, to.text)

		if ((from.children?.length ?? 0) !== (to.children?.length ?? 0)) consistent = false

		from.children?.forEach((child, index) => {
			const next = to.children?.[index]

			if (next === undefined) consistent = false
			else shape(child, next)
		})
	}

	shape(before, after)

	if (!consistent) return undefined

	// The rest of the text equal once the scaled values are set aside.
	return sameUnscaled(before, after) ? out : undefined
}

// `shape`'s text (and its members', with their boxes) with every value a scale rewrites set aside.
function unscaled(shape: ShapeNode): string {
	const strip = (key: string, value: unknown): unknown =>
		key === "sz" || key === "pts" || key === "marL" || key === "indent" ? undefined : value
	const members = (each: ShapeNode): unknown => ({ text: each.text, xfrm: each.xfrm, children: each.children?.map(members) })

	return JSON.stringify({ text: shape.text, children: shape.children?.map(members) }, strip)
}

function sameUnscaled(before: ShapeNode, after: ShapeNode): boolean {
	return unscaled(before) === unscaled(after)
}
