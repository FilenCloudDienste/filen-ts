import { digestOf } from "../../presentation/edit/changes"
import type {
	Action,
	FrameRef,
	Geometry,
	MediaRef,
	Paragraph,
	ParaProps,
	Run,
	RunProps,
	ShapeNode,
	SlideNode,
	SlideRef,
	TableModel,
	TextBody,
	Xfrm
} from "../../presentation/model"
import { odfCustomCommands } from "../../odf/presetShapes"
import { jumpIndex } from "./emit/text"
import { IDENTITY, canonicalBox, compose, groupAffine, lineEnds, placed, type Affine } from "./emit/shape"
import { isRefused } from "./styles"

// What a written page means, compared with what the session holds (proof gate 2 for ODP: the touched pages of the
// saved file read back by the reader, shape by shape in order). The model is compared as the reader produces it, with
// what differs only in form left out:
//   - shape ids (the reader numbers shapes in page order), field ids, source refs and locks;
//   - a box in EMU within 2 (lengths go through centimetres), a group's own box (it is its members' bounds), a
//     line by its ends;
//   - what the session leaves to inheritance (an undefined property group, bullet, margin or indent of a paragraph)
//     against whatever the file inherits;
//   - adjacent runs of the same properties as one, an empty paragraph's bullet, the autofit scale DrawingML caches
//     (ODF shrinks text as it lays it out);
//   - what names a picture's image (a registry id in the session, an entry once written; the zip holds it) and a
//     stretch over the whole box (ODF draws every picture so);
//   - a table cell by cell: its columns and rows by size (within 2 EMU), spans, whether a cell is covered (ODF has no
//     direction for it), properties and text as a shape's body.
// The first difference found is answered as a path, for the refusal's detail.

const TOLERANCE = 2

function same(a: unknown, b: unknown): boolean {
	return digestOf(a) === digestOf(b)
}

function near(a: number, b: number, tolerance = TOLERANCE): boolean {
	return Math.abs(a - b) <= tolerance
}

// A box's flips as one vertical mirror at most: a horizontal one is a vertical one half a turn round (and both, half a
// turn), text included under DrawingML's meaning of them; a mirroring draw:transform reads back so.
function oneMirror(box: Xfrm): Xfrm {
	return box.flipH ? { ...box, rot: (box.rot + 10_800_000) % 21_600_000, flipH: false, flipV: !box.flipV } : box
}

function boxDiffers(wanted: Xfrm, got: Xfrm): boolean {
	const expected = oneMirror(wanted)
	const read = oneMirror(got)
	const turn = (rot: number): number => ((rot % 21_600_000) + 21_600_000) % 21_600_000
	const rotation = Math.abs(turn(expected.rot) - turn(read.rot))

	return (
		!near(expected.x, read.x) ||
		!near(expected.y, read.y) ||
		!near(expected.cx, read.cx) ||
		!near(expected.cy, read.cy) ||
		Math.min(rotation, 21_600_000 - rotation) > 60 ||
		expected.flipH !== read.flipH ||
		expected.flipV !== read.flipV
	)
}

function isLine(shape: ShapeNode): boolean {
	const geometry = shape.props?.geometry

	return shape.kind === "cxnSp" && (geometry === undefined || (geometry.kind === "preset" && geometry.preset === "line"))
}

// Where a page's jumps land, by index in the deck: a text link names a page, so a relative jump the session holds is
// compared as the page it lands on.
export interface JumpIndex {
	readonly at: number
	readonly count: number
	index(ref: SlideRef): number
}

let sides: { readonly expected: JumpIndex; readonly read: JumpIndex } | undefined
let jumps: JumpIndex | undefined

function landing(rPr: RunProps): RunProps {
	const link = rPr.hlinkClick

	if (link === undefined || jumps === undefined) return rPr
	if (link.kind === "slide") return { ...rPr, hlinkClick: { kind: "url", href: `#${String(jumps.index(link.slide))}` } }
	if (link.kind === "internal") {
		const index = jumpIndex(link.jump, jumps.at, jumps.count)

		if (index !== undefined) return { ...rPr, hlinkClick: { kind: "url", href: `#${String(index)}` } }

		// A relative jump past the deck's ends lands nowhere: as a link to no page reads, no link.
		if (link.jump === "next" || link.jump === "previous") {
			const { hlinkClick: _link, ...rest } = rPr

			return rest
		}
	}

	return rPr
}

// A shape's click and hover actions with each jump to a page compared as the page it lands on (as a run's link is):
// a page named by a ref of the session and by the read deck's are the same page when they sit at the same index.
function actionsLanding(actions: ShapeNode["actions"], index: JumpIndex | undefined): unknown {
	if (index === undefined) return actions ?? {}

	const land = (action: Action | undefined): unknown => {
		if (action?.kind === "slide") return { kind: "page", index: index.index(action.slide) }
		if (action?.kind === "internal") {
			const at = jumpIndex(action.jump, index.at, index.count)

			return at === undefined ? action : { kind: "page", index: at }
		}

		return action
	}

	return { click: land(actions?.click), hover: land(actions?.hover) }
}

// Adjacent text runs of the same properties as one; field ids left out.
function runsOf(runs: readonly Run[]): unknown[] {
	const out: unknown[] = []

	for (const run of runs) {
		if (run.kind === "r") {
			const last = out[out.length - 1] as { kind: string; text: string; rPr: RunProps } | undefined

			if (run.text === "") continue

			const rPr = landing(run.rPr)

			if (last?.kind === "r" && same(last.rPr, rPr)) {
				out[out.length - 1] = { kind: "r", text: last.text + run.text, rPr: last.rPr }

				continue
			}

			out.push({ kind: "r", text: run.text, rPr })
		} else if (run.kind === "fld") {
			// A page number or count shows what the deck now has, not what it showed when read.
			const computed = run.type === "slidenum" || run.type === "odf:page-count"

			out.push({ kind: "fld", type: run.type, ...(computed ? {} : { text: run.text }), rPr: landing(run.rPr) })
		} else if (run.kind === "br") {
			out.push({ kind: "br" })
		} else {
			out.push({ kind: "opaque", text: run.text })
		}
	}

	return out
}

// Paragraph fields a list level fills in: left to inheritance in the session, the file's level decides them.
const LEVEL_FIELDS: readonly (keyof ParaProps)[] = ["bullet", "buClr", "buSz", "buFont", "marL", "indent"]

function paragraphDiffers(expected: Paragraph, read: Paragraph): string | undefined {
	const want: Record<string, unknown> = { ...expected.pPr }
	const got: Record<string, unknown> = { ...read.pPr }

	if ((want["lvl"] ?? 0) === 0) delete want["lvl"]
	if ((got["lvl"] ?? 0) === 0) delete got["lvl"]

	for (const key of LEVEL_FIELDS) {
		if (want[key] === undefined) delete got[key]
	}

	// An empty paragraph shows no bullet.
	if (expected.runs.length === 0) {
		for (const key of LEVEL_FIELDS) {
			if (key === "marL" || key === "indent") continue

			delete want[key]
			delete got[key]
		}
	}

	if (!same(want, got)) return "pPr"
	jumps = sides?.expected

	const wantRuns = runsOf(expected.runs)

	jumps = sides?.read

	const gotRuns = runsOf(read.runs)

	jumps = undefined

	if (!same(wantRuns, gotRuns)) return "runs"

	const end = (rPr: RunProps | undefined): RunProps => rPr ?? {}

	if (!same(end(expected.endRPr), end(read.endRPr))) return "endRPr"

	return undefined
}

function bodyDiffers(expected: TextBody, read: TextBody | undefined): string | undefined {
	if (read === undefined) return expected.paragraphs.every(paragraph => paragraph.runs.length === 0) ? undefined : "text"

	const body = (props: TextBody["bodyPr"]): Record<string, unknown> => {
		const out: Record<string, unknown> = { ...props }

		delete out["fontScale"]
		delete out["lineSpacingReduction"]

		return out
	}
	const want = body(expected.bodyPr)
	const got = body(read.bodyPr)

	for (const key of Object.keys(got)) if (want[key] === undefined) delete got[key]

	if (!same(want, got)) return "bodyPr"

	const expectedParagraphs = expected.paragraphs
	const readParagraphs = read.paragraphs

	if (expectedParagraphs.length !== readParagraphs.length) {
		// A body of one empty paragraph and one with none read the same.
		const empty = (list: readonly Paragraph[]): boolean => list.length <= 1 && list.every(paragraph => paragraph.runs.length === 0)

		return empty(expectedParagraphs) && empty(readParagraphs) ? undefined : "paragraphs"
	}

	for (let k = 0; k < expectedParagraphs.length; k++) {
		const differs = paragraphDiffers(expectedParagraphs[k] as Paragraph, readParagraphs[k] as Paragraph)

		if (differs !== undefined) return `paragraph ${String(k)} ${differs}`
	}

	return undefined
}

function shapeDiffers(expected: ShapeNode, read: ShapeNode, m: Affine, readM: Affine): string | undefined {
	if (expected.kind !== read.kind) return "kind"
	if (expected.name !== read.name) return "name"
	if (expected.hidden !== read.hidden) return "hidden"
	if (!same(expected.alt ?? {}, read.alt ?? {})) return "alt"
	if (expected.ph?.type !== read.ph?.type) return "placeholder"
	if (!same(actionsLanding(expected.actions, sides?.expected), actionsLanding(read.actions, sides?.read))) return "actions"

	if (expected.kind !== "grpSp" && expected.xfrm !== undefined && read.xfrm !== undefined) {
		if (isLine(expected)) {
			const want = lineEnds(expected.xfrm, m)
			const got = lineEnds(read.xfrm, readM)

			if (want.some((value, k) => !near(value, got[k] ?? Number.NaN))) return "line ends"
		} else {
			const want = placed(expected.xfrm, m)
			const got = placed(read.xfrm, readM)

			// A frame holds a mirrored box as the box DrawingML means (canonicalBox).
			if (boxDiffers(want, got) && boxDiffers(canonicalBox(expected, want), got)) return "box"
		}
	}

	for (const group of ["geometry", "fill", "ln", "effects"] as const) {
		const want = expected.props?.[group]

		if (want === undefined) continue
		if (group === "fill" && expected.kind === "pic") {
			if (!same(pictureMeaning(want), pictureMeaning(read.props?.fill))) return group

			continue
		}
		if (
			group === "geometry"
				? !sameGeometry(want as Geometry, read.props?.geometry)
				: !same(want, inherited(group, want, read.props?.[group]))
		)
			return group
	}

	if (expected.text !== undefined) {
		const differs = bodyDiffers(expected.text, read.text)

		if (differs !== undefined) return differs
	}

	// A medium the session inserted: what it is (audio or video, linked or not), not what names it (registry ids in the
	// session, entries once written; the reader takes its type from the file name).
	const inserted = expected.media?.part?.startsWith("inserted:") === true
	const mediaMeaning = (media: MediaRef | undefined): unknown =>
		media === undefined || !inserted ? media : { kind: media.kind, linked: media.external !== undefined }
	const frameMeaning = (frame: FrameRef | undefined): unknown =>
		frame?.kind === "media" && inserted
			? { kind: "media", media: mediaMeaning(frame.media) }
			: frame?.kind === "chart"
				? { kind: "chart" }
				: stripped(frame)

	if (expected.frame?.kind === "table" && read.frame?.kind === "table") {
		const differs = tableDiffers(expected.frame.table, read.frame.table)

		if (differs !== undefined) return `table ${differs}`
	} else if (!same(frameMeaning(expected.frame), frameMeaning(read.frame))) {
		return "frame"
	}
	if (!same(mediaMeaning(expected.media), mediaMeaning(read.media))) return "media"

	if (expected.kind === "grpSp") {
		const now = groupAffine(expected.xfrm)
		const was = groupAffine(read.xfrm)

		if (isRefused(now) || isRefused(was)) return "group"

		const inner = compose(m, now)
		const readInner = compose(readM, was)

		return shapesDiffer(expected.children ?? [], read.children ?? [], inner, readInner)
	}

	return undefined
}

// A line the session gives only some properties of (a new shape: its width and colour) against the file's, which
// inherits the rest (its join and cap) from the graphic style's defaults: those the session leaves to inheritance are
// not compared, as for a paragraph's level fields.
function inherited(group: string, want: unknown, got: unknown): unknown {
	if (group !== "ln" || typeof want !== "object" || want === null || typeof got !== "object" || got === null) return got

	const out: Record<string, unknown> = { ...(got as Record<string, unknown>) }

	for (const key of Object.keys(out)) if ((want as Record<string, unknown>)[key] === undefined) delete out[key]

	return out
}

// An outline compared as ODF draws it: a custom one's paths are evaluated for the shape's box (its formulas may use
// the box's size), so their commands compare, not their coordinates.
function sameGeometry(want: Geometry, got: Geometry | undefined): boolean {
	if (got === undefined) return false
	if (want.kind !== "custom" || got.kind !== "custom") return same(want, got)
	if (want.paths.length !== got.paths.length) return false

	// As the outline is written (odfCustomCommands): a quadratic or an arc as cubics, a fill ODF holds as filled or not.
	return want.paths.every((path, k) => {
		const other = got.paths[k]
		const written = odfCustomCommands(path)

		return (
			other !== undefined &&
			written.filled === (other.fill !== "none") &&
			path.stroke === other.stroke &&
			same(written.commands, Array.from(other.commands))
		)
	})
}

function pictureMeaning(fill: unknown): unknown {
	if (fill === null || typeof fill !== "object" || (fill as { kind?: unknown }).kind !== "picture") return fill

	const { part: _part, inserted: _inserted, adjust: _adjust, stretch, ...rest } = fill as Record<string, unknown>
	const whole = (edges: unknown): boolean =>
		edges === undefined || Object.values(edges as Record<string, number>).every(value => value === 0)

	return whole(stretch) ? rest : { ...rest, stretch }
}

// A cell's body compared as a shape's: its list styles are the table's, not its own.
function withoutListStyle(body: TextBody): TextBody {
	const { lstStyle: _lstStyle, ...rest } = body

	return rest
}

function tableDiffers(expected: TableModel, read: TableModel): string | undefined {
	if (expected.grid.length !== read.grid.length || expected.grid.some((width, k) => !near(width, read.grid[k] ?? Number.NaN)))
		return "grid"
	if (expected.rows.length !== read.rows.length) return "rows"
	if (!same(expected.flags, read.flags)) return "flags"

	for (let r = 0; r < expected.rows.length; r++) {
		const want = expected.rows[r] as TableModel["rows"][number]
		const got = read.rows[r] as TableModel["rows"][number]

		if (!near(want.h, got.h)) return `row ${String(r)} height`
		if (want.cells.length !== got.cells.length) return `row ${String(r)} cells`

		for (let c = 0; c < want.cells.length; c++) {
			const a = want.cells[c] as TableModel["rows"][number]["cells"][number]
			const b = got.cells[c] as TableModel["rows"][number]["cells"][number]
			const covered = (cell: typeof a): boolean => cell.hMerge === true || cell.vMerge === true
			const at = `cell ${String(r)},${String(c)}`

			if (covered(a) !== covered(b)) return `${at} covered`
			if (covered(a)) continue
			if ((a.gridSpan ?? 1) !== (b.gridSpan ?? 1) || (a.rowSpan ?? 1) !== (b.rowSpan ?? 1)) return `${at} span`
			if (!same(a.props ?? {}, b.props ?? {})) return `${at} props`

			const differs = bodyDiffers(withoutListStyle(a.text), withoutListStyle(b.text))

			if (differs !== undefined) return `${at} ${differs}`
		}
	}

	return undefined
}

// A frame's model without its source refs (a table's cells and their paragraphs carry them).
function stripped(value: unknown): unknown {
	return value === undefined ? undefined : digestOf(value)
}

function shapesDiffer(expected: readonly ShapeNode[], read: readonly ShapeNode[], m: Affine, readM: Affine): string | undefined {
	const want = expected.filter(shape => shape.synthetic !== true)
	const got = read.filter(shape => shape.synthetic !== true)

	if (want.length !== got.length) return `shape count ${String(want.length)} read as ${String(got.length)}`

	for (let k = 0; k < want.length; k++) {
		const differs = shapeDiffers(want[k] as ShapeNode, got[k] as ShapeNode, m, readM)

		if (differs !== undefined) return `shape ${String(k)} (${(want[k] as ShapeNode).name}) ${differs}`
	}

	return undefined
}

// The first difference between a slide as the session holds it and as its written page reads, or undefined. `index`:
// where each side's jumps land (the session's refs and the read deck's), for text links.
export function slideDiffers(
	expected: SlideNode,
	read: SlideNode,
	name: string,
	index?: { readonly at: number; readonly count: number; expected(ref: SlideRef): number; read(ref: SlideRef): number }
): string | undefined {
	if (read.name !== name) return `name ${name} read as ${String(read.name)}`
	if (expected.hidden !== read.hidden) return "hidden"
	if (expected.showMasterShapes !== read.showMasterShapes) return "master shapes"

	sides =
		index === undefined
			? undefined
			: {
					expected: { at: index.at, count: index.count, index: ref => index.expected(ref) },
					read: { at: index.at, count: index.count, index: ref => index.read(ref) }
				}

	try {
		return shapesDiffer(expected.shapes, read.shapes, IDENTITY, IDENTITY)
	} finally {
		sides = undefined
	}
}

export function notesDiffer(expected: SlideNode | undefined, read: SlideNode | undefined): string | undefined {
	if (expected === undefined) return read === undefined || read.shapes.length === 0 ? undefined : "notes"
	if (read === undefined) return expected.shapes.length === 0 ? undefined : "notes"

	const differs = shapesDiffer(expected.shapes, read.shapes, IDENTITY, IDENTITY)

	return differs === undefined ? undefined : `notes ${differs}`
}
