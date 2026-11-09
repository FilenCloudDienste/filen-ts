import { symbolTable, symbolText } from "../fonts/symbols"
import { resolveParagraph, resolveRun, type ResolvedShape, resolveShape } from "./inherit"
import type { Deck, ListStyle, Paragraph, ParaProps, ShapeNode, ShapeRef, SlideNode, SlideRef, TextBody, ThemeRef, Xfrm } from "./model"
import type { NotesParagraph, NotesRun } from "./output"
import { AutonumberCounters, autonumberText } from "./text/autonum"

// A slide's speaker notes: the body placeholder of its notes slide (ECMA-376 Part 1 §19.3.1.26), which inherits from
// the notes master's (§19.3.1.27; MS-OI29500 §2.1.1127(b), by type). A slide without a notes slide gets one made from
// the notes master as PowerPoint makes it: a slide image placeholder and a notes placeholder, both placed by the
// master. A deck without a notes master gets ours: PowerPoint's default notes page placement (header, date, slide
// image, notes, footer and slide number on a 7.5 x 10 in page, scaled to the deck's notes size) with a notes style of
// 12 pt minor-font text indented 0.5 in per level.

// PowerPoint's default notes page (EMU) and its placeholders' boxes on it.
const PAGE = { cx: 6_858_000, cy: 9_144_000 }
const QUARTER = { cx: 2_971_800, cy: 458_788 }
const MASTER_BOXES = {
	hdr: { x: 0, y: 0, ...QUARTER },
	dt: { x: 3_884_613, y: 0, ...QUARTER },
	sldImg: { x: 1_143_000, y: 685_800, cx: 4_572_000, cy: 3_429_000 },
	body: { x: 685_800, y: 4_400_550, cx: 5_486_400, cy: 3_600_450 },
	ftr: { x: 0, y: 8_685_212, ...QUARTER },
	sldNum: { x: 3_884_613, y: 8_685_212, ...QUARTER }
} as const

const MASTER_PLACEHOLDERS = [
	{ type: "hdr", idx: 0, name: "Header Placeholder 1" },
	{ type: "dt", idx: 1, name: "Date Placeholder 2" },
	{ type: "sldImg", idx: 2, name: "Slide Image Placeholder 3" },
	{ type: "body", idx: 3, name: "Notes Placeholder 4" },
	{ type: "ftr", idx: 4, name: "Footer Placeholder 5" },
	{ type: "sldNum", idx: 5, name: "Slide Number Placeholder 6" }
] as const

const LEVEL_INDENT = 457_200

// The notes slide and notes master parts the session made, by deck: only these are taken out of the package again when
// the model no longer has them (an undo after the save that wrote them), never a part the file came with.
const MADE_PARTS = new WeakMap<Deck, Set<string>>()

export function markMadeNotesPart(deck: Deck, part: string): void {
	let held = MADE_PARTS.get(deck)

	if (held === undefined) {
		held = new Set()
		MADE_PARTS.set(deck, held)
	}

	held.add(part.replace(/^\//u, "").toLowerCase())
}

export function madeNotesPart(deck: Deck, part: string): boolean {
	return MADE_PARTS.get(deck)?.has(part.replace(/^\//u, "").toLowerCase()) === true
}

// The notes body of a notes slide: its first body placeholder.
export function notesBody(node: SlideNode | undefined): ShapeNode | undefined {
	return node?.shapes.find(shape => shape.kind === "sp" && shape.ph?.type === "body")
}

// The body the notes pane edits for `slide`, when it has a notes slide with a notes placeholder.
export function notesTarget(deck: Deck, slide: SlideRef): ShapeRef | undefined {
	const notes = deck.nodes.get(slide)?.notes
	const node = notes === undefined ? undefined : deck.nodes.get(notes)
	const body = notesBody(node)

	return node === undefined || body === undefined ? undefined : { slide: node.ref, id: body.id }
}

// A slide's speaker notes as text (SlideRender.notesText, SlideReview.notesText): its notes slide's body placeholders'
// paragraphs joined by line breaks, a:br as a line break; "" without a notes slide.
export function notesText(deck: Deck, node: SlideNode): string {
	const notes = node.notes === undefined ? undefined : deck.nodes.get(node.notes)

	if (notes === undefined) return ""

	return notes.shapes
		.filter(shape => shape.ph?.type === "body")
		.flatMap(shape => shape.text?.paragraphs ?? [])
		.map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join(""))
		.join("\n")
}

// The notes text size a paragraph's indents are measured against when neither it nor its style sets one (12 pt).
const NOTES_SZ = 1200
// EMU per hundredth of a point.
const EMU_PER_SZ = 127

// A slide's speaker notes as the presenter view shows them (SlideRender.notes): the notes body placeholders'
// paragraphs with their formatting resolved through the notes master's notesStyle; undefined when they hold no text.
export function notesParagraphs(deck: Deck, node: SlideNode): readonly NotesParagraph[] | undefined {
	const notes = node.notes === undefined ? undefined : deck.nodes.get(node.notes)

	if (notes === undefined) return undefined

	const out: NotesParagraph[] = []
	let text = false

	for (const shape of notes.shapes) {
		if (shape.ph?.type !== "body" || shape.text === undefined) continue

		const resolved = resolveShape(deck, notes.ref, shape)
		const counters = new AutonumberCounters()

		for (const paragraph of shape.text.paragraphs) {
			const made = notesParagraph(resolved, paragraph, counters)

			if (made.runs.length > 0) text = true

			out.push(made)
		}
	}

	return text ? out : undefined
}

function notesParagraph(resolved: ResolvedShape, paragraph: Paragraph, counters: AutonumberCounters): NotesParagraph {
	const { level, pPr } = resolveParagraph(resolved, paragraph)
	const runs: NotesRun[] = []
	let first: number | undefined

	for (const run of paragraph.runs) {
		const props = run.kind === "opaque" ? undefined : resolveRun({ level, pPr }, run.rPr)
		const text = run.kind === "br" ? "\n" : run.text

		first ??= props?.sz

		if (text.length > 0) pushRun(runs, text, props)
	}

	const em = (first ?? pPr.defRPr?.sz ?? NOTES_SZ) * EMU_PER_SZ
	const bullet = pPr.bullet
	let marker: string | undefined

	if (bullet?.kind === "autoNum" && runs.length > 0) {
		marker = autonumberText(bullet.scheme, counters.next(level, bullet.scheme, bullet.startAt ?? 1))
	} else {
		counters.skip(level)

		if (runs.length > 0 && bullet !== undefined && bullet.kind !== "none") {
			const font = pPr.buFont
			const table = bullet.kind !== "char" || font === undefined || font === "text" ? undefined : symbolTable(font.typeface)

			marker = bullet.kind === "char" ? (table === undefined ? bullet.char : symbolText(table, bullet.char)) : "•"
		}
	}

	const algn = pPr.algn
	const align = algn === "ctr" || algn === "r" ? algn : algn === undefined || algn === "l" ? undefined : "just"

	return {
		level,
		...(align === undefined ? {} : { align }),
		...(pPr.rtl === true ? { rtl: true as const } : {}),
		start: (pPr.marL ?? 0) / em,
		first: (pPr.indent ?? 0) / em,
		...(marker === undefined || marker === "" ? {} : { marker }),
		runs
	}
}

// Appends a run, joined to the one before when their formatting is the same.
function pushRun(runs: NotesRun[], text: string, props: ReturnType<typeof resolveRun> | undefined): void {
	const baseline = props?.baseline ?? 0
	const run: NotesRun = {
		text,
		...(props?.b === true ? { b: true as const } : {}),
		...(props?.i === true ? { i: true as const } : {}),
		...(props?.u !== undefined && props.u !== "none" ? { u: true as const } : {}),
		...(props?.strike !== undefined && props.strike !== "noStrike" ? { strike: true as const } : {}),
		...(baseline > 0 ? { script: "sup" as const } : baseline < 0 ? { script: "sub" as const } : {})
	}
	const last = runs[runs.length - 1]

	if (
		last !== undefined &&
		last.b === run.b &&
		last.i === run.i &&
		last.u === run.u &&
		last.strike === run.strike &&
		last.script === run.script
	) {
		runs[runs.length - 1] = { ...last, text: last.text + text }
	} else {
		runs.push(run)
	}
}

// What a slide's notes fingerprint digests: whether it has a notes slide (and which part holds it), and the notes
// master that slide needs when the session made it.
export function notesValue(deck: Deck, node: SlideNode): unknown {
	const notes = node.notes === undefined ? undefined : deck.nodes.get(node.notes)

	if (notes === undefined) return undefined

	const master = notes.parent === undefined ? undefined : deck.nodes.get(notes.parent)

	return { part: notes.part, master: master?.src === undefined ? master?.part : "source" }
}

function scaled(box: { readonly x: number; readonly y: number; readonly cx: number; readonly cy: number }, size: Deck["notesSize"]): Xfrm {
	const sx = size.cx > 0 ? size.cx / PAGE.cx : 1
	const sy = size.cy > 0 ? size.cy / PAGE.cy : 1

	return {
		x: Math.round(box.x * sx),
		y: Math.round(box.y * sy),
		cx: Math.round(box.cx * sx),
		cy: Math.round(box.cy * sy),
		rot: 0,
		flipH: false,
		flipV: false
	}
}

function notesStyle(): ListStyle {
	const levels: ParaProps[] = []

	for (let level = 0; level < 9; level++) {
		levels.push({
			marL: level * LEVEL_INDENT,
			algn: "l",
			defTabSz: 914_400,
			rtl: false,
			eaLnBrk: true,
			latinLnBrk: false,
			hangingPunct: true,
			defRPr: { sz: 1200, kern: 1200, latin: { typeface: "+mn-lt" }, ea: { typeface: "+mn-ea" }, cs: { typeface: "+mn-cs" } }
		})
	}

	return { levels }
}

const EMPTY_LIST: ListStyle = { levels: [] }

// Our notes master, for a deck without one (`theme`: the theme it takes, the first slide master's).
export function defaultNotesMaster(deck: Deck, ref: SlideRef, part: string, theme: ThemeRef | undefined): SlideNode {
	return {
		ref,
		kind: "notesMaster",
		part,
		showMasterShapes: true,
		hidden: false,
		clrMap: {
			bg1: "lt1",
			tx1: "dk1",
			bg2: "lt2",
			tx2: "dk2",
			accent1: "accent1",
			accent2: "accent2",
			accent3: "accent3",
			accent4: "accent4",
			accent5: "accent5",
			accent6: "accent6",
			hlink: "hlink",
			folHlink: "folHlink"
		},
		...(theme === undefined ? {} : { theme }),
		txStyles: { title: EMPTY_LIST, body: notesStyle(), other: EMPTY_LIST },
		shapes: MASTER_PLACEHOLDERS.map((placeholder, index) => ({
			id: index + 2,
			name: placeholder.name,
			hidden: false,
			kind: "sp",
			ph: { type: placeholder.type, idx: placeholder.idx, ...(placeholder.idx === 0 ? {} : { idxWritten: true }) },
			xfrm: scaled(MASTER_BOXES[placeholder.type], deck.notesSize)
		})),
		comments: [],
		revision: 0
	}
}

// A notes slide for `slide` holding `body`, placed by `master` (pptx: the placeholders inherit their boxes; `boxes`:
// boxes written on the shapes, for a format whose new placeholders carry their own, ODF's).
export function newNotesSlide(
	ref: SlideRef,
	part: string,
	master: SlideRef | undefined,
	body: TextBody,
	boxes?: { readonly image: Xfrm; readonly body: Xfrm }
): SlideNode {
	return {
		ref,
		kind: "notes",
		part,
		...(master === undefined ? {} : { parent: master }),
		showMasterShapes: true,
		hidden: false,
		shapes: [
			{
				id: 2,
				name: "Slide Image Placeholder 1",
				hidden: false,
				kind: "sp",
				ph: { type: "sldImg", idx: 0 },
				...(boxes === undefined ? {} : { xfrm: boxes.image })
			},
			{
				id: 3,
				name: "Notes Placeholder 2",
				hidden: false,
				kind: "sp",
				ph: { type: "body", idx: 1, idxWritten: true },
				...(boxes === undefined ? {} : { xfrm: boxes.body }),
				text: body
			}
		],
		comments: [],
		revision: 0
	}
}

// The boxes a new notes slide's placeholders take where the format writes them (ODF): the notes master's own, else
// the default placement on the deck's notes page.
export function notesBoxes(deck: Deck, master: SlideNode | undefined): { readonly image: Xfrm; readonly body: Xfrm } {
	const own = (type: "sldImg" | "body"): Xfrm | undefined => master?.shapes.find(shape => shape.ph?.type === type)?.xfrm

	return {
		image: own("sldImg") ?? scaled(MASTER_BOXES.sldImg, deck.notesSize),
		body: own("body") ?? scaled(MASTER_BOXES.body, deck.notesSize)
	}
}
