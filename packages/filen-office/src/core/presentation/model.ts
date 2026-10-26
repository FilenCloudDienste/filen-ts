import type { TextAlign, TextBodyProps, TextUnderline } from "../drawingml/index"
import type { TimingTree, Transition } from "../anim/model"

// The presentation model shared by the pptx, ODP and ppt readers, the renderer, the editor and the writers. Each
// level (slide, layout, master, notes) stores only what its source wrote; inheritance is resolved elsewhere, never
// written back into the levels. The model is mutable on purpose: ops apply in place in the worker (no copy of a
// deck per edit), and their inverses hold what they replaced. Anything a reader does not interpret stays in the
// source and is reached through `src` (or an opaque node), so it is written back as it was.
//
// Units: EMU for positions and sizes (12,700 per point), hundredths of a point for font sizes, 1/100,000 for
// percentages and angles in 60,000ths of a degree, as PresentationML stores them; text body insets follow the
// DrawingML text reader (px), so a body read from the source and one written by an edit compare directly.

declare const slideRefBrand: unique symbol

// A slide, layout, master, notes or handout master of one session, stable across edits and saves (never reused).
export type SlideRef = number & { readonly [slideRefBrand]: true }

export function slideRef(value: number): SlideRef {
	return value as SlideRef
}

// A shape by its slide and its cNvPr id (unique per slide; ODP shapes get one from the reader).
export interface ShapeRef {
	readonly slide: SlideRef
	readonly id: number
}

export type Format = "pptx" | "odp" | "ppt"

export type DeckVariant = "pptx" | "pptm" | "potx" | "potm" | "ppsx" | "ppsm" | "odp" | "otp" | "ppt" | "pps" | "pot"

// Where a node came from: an element of a part's XmlDocument (pptx), or of a page fragment (ODP pages are parsed one
// fragment at a time: `fragment` is the byte offset of its root, draw:page or style:master-page, in the part; -1 for
// a whole-part document). `epoch` is the base source's generation: 0 at open, +1 per save rebase, which rebinds the
// model's refs; a ref of another epoch is refused as stale wherever it is read. A ppt deck is read as the pptx it
// converts to. Inverses never hold a SourceRef (they hold bytes); an op built on the page holds one only inside a
// TextBody copied from a TextSeed, checked against the epoch.
export type SourceRef =
	| { readonly format: "pptx"; readonly part: string; readonly node: number; readonly epoch: number }
	| { readonly format: "odp"; readonly part: string; readonly fragment: number; readonly node: number; readonly epoch: number }

// Why a deck opens view-only (non-empty → view-only).
export type GateReason = "signed" | "strict" | "writeProtected" | "malformed"

// Why something is refused (typed, never silent). notImplemented: a capability not built yet.
export type PresentationRefusal =
	| "notImplemented"
	| "tooLarge"
	| "tooDeep"
	| "malformed"
	| "unsupported"
	| "encrypted"
	| "needsPassword"
	| "wrongPassword"
	| "rightsManaged"
	| "unsupportedEncryption"
	| "damagedEncryption"
	| "viewOnly"
	| "locked"
	| "proofFailed"
	| "notFound"
	| "stale"
	| "aborted"
	| "closed"
	| "failed"

export interface Refused {
	readonly kind: "refused"
	readonly reason: PresentationRefusal
	// What was refused, for a notice or a report (never shown raw to a user).
	readonly detail?: string
}

export function refused(reason: PresentationRefusal, detail?: string): Refused {
	return detail === undefined ? { kind: "refused", reason } : { kind: "refused", reason, detail }
}

// A refusal thrown where a contract returns a value (a compile over budget, a capability not built yet); the
// worker's dispatcher answers the call with its reason.
export class PresentationError extends Error {
	readonly reason: PresentationRefusal

	constructor(reason: PresentationRefusal, message: string = reason) {
		super(message)
		this.name = "PresentationError"
		this.reason = reason
	}
}

export interface Deck {
	format: Format
	variant: DeckVariant
	// EMU; MS-OI29500 §2.1.1110 default 9144000 × 6858000.
	size: { cx: number; cy: number; type?: string }
	notesSize: { cx: number; cy: number }
	firstSlideNumber: number
	slides: SlideRef[]
	masters: SlideRef[]
	// Every layout, master by master in each master's order (ODP: the synthesized ones).
	layouts: SlideRef[]
	notesMaster?: SlideRef
	handoutMaster?: SlideRef
	// The parsed nodes; a slide not parsed yet (lazy reading) is absent. Parse before touch: every core function
	// taking a Deck (apply, inherit, render, emit) is synchronous and needs each node it touches present, with its
	// layout and master chain; the engine parses them first (asynchronously, through the reader's part map).
	nodes: Map<SlideRef, SlideNode>
	sections: Section[]
	customShows: CustomShow[]
	show: ShowSettings
	defaultTextStyle: ListStyle
	embeddedFonts: EmbeddedFontRef[]
	protection: { modifyVerifier?: ModifyVerifier; encrypted?: EncryptionInfoSummary }
	gate: GateReason[]
	authors: Author[]
	// Kept, never interpreted (custData, tags, extLst, vbaProject…).
	opaque: OpaqueRef[]
	// Bumps on any op touching presentation-level defaults (defaultTextStyle, size, show settings).
	revision: number
}

export interface Section {
	name: string
	id: string
	slides: SlideRef[]
}

export interface CustomShow {
	name: string
	id: number
	slides: SlideRef[]
}

export type SlideKind = "slide" | "layout" | "master" | "notes" | "notesMaster" | "handoutMaster"

export interface SlideNode {
	ref: SlideRef
	kind: SlideKind
	part: string
	src?: SourceRef
	// A layout ODP has no level for (built from a master and a presentation-page-layout), never written to ODP.
	synthetic?: true
	name?: string
	// Slide → layout, layout → master, notes → notes master.
	parent?: SlideRef
	clrMap?: ClrMap
	clrMapOvr?: ClrMap | "master"
	theme?: ThemeRef
	background?: Background
	showMasterShapes: boolean
	hidden: boolean
	layoutType?: string
	txStyles?: { title: ListStyle; body: ListStyle; other: ListStyle }
	hf?: HeaderFooterFlags
	// In z-order, back to front.
	shapes: ShapeNode[]
	timing?: TimingTree
	transition?: Transition
	notes?: SlideRef
	comments: CommentRef[]
	// Bumps on any op touching this node.
	revision: number
}

// ST_PlaceholderType (ECMA-376 §19.7.10).
export type PlaceholderType =
	| "title"
	| "body"
	| "ctrTitle"
	| "subTitle"
	| "dt"
	| "sldNum"
	| "ftr"
	| "hdr"
	| "obj"
	| "chart"
	| "tbl"
	| "clipArt"
	| "dgm"
	| "media"
	| "sldImg"
	| "pic"

export type ShapeKind = "sp" | "pic" | "grpSp" | "cxnSp" | "frame" | "ink" | "opaque"

export interface Placeholder {
	type: PlaceholderType
	idx: number
	orient?: "horz" | "vert"
	sz?: "full" | "half" | "quarter"
	hasCustomPrompt?: boolean
}

export interface ShapeNode {
	// Unique per slide. Real decks repeat cNvPr ids: ids.ts reassigns duplicates on read and keeps the written one in
	// `sourceId`, which emit writes back and a rebase rebinds by.
	id: number
	sourceId?: number
	name: string
	alt?: { descr?: string; title?: string; decorative?: boolean }
	hidden: boolean
	kind: ShapeKind
	ph?: Placeholder
	xfrm?: Xfrm
	// Typed overrides written by edits; undefined = the source as read.
	props?: ShapePropsEdit
	style?: ShapeStyleRefs
	text?: TextBody
	frame?: FrameRef
	media?: MediaRef
	actions?: { click?: Action; hover?: Action }
	children?: ShapeNode[]
	src?: SourceRef
	lock?: LockReason
}

// a:xfrm (EMU; rot in 60,000ths of a degree). chOff/chExt only on groups.
export interface Xfrm {
	x: number
	y: number
	cx: number
	cy: number
	rot: number
	flipH: boolean
	flipV: boolean
	chX?: number
	chY?: number
	chCx?: number
	chCy?: number
}

// Per DrawingML property group; each present group replaces the source group whole when emitted.
export interface ShapePropsEdit {
	geometry?: Geometry
	fill?: FillProps | "none"
	ln?: LineProps | "none"
	effects?: EffectList
	bodyPr?: Partial<TextBodyProps>
}

export type Geometry =
	| { readonly kind: "preset"; readonly preset: string; readonly guides: readonly GeometryGuide[] }
	| {
			readonly kind: "custom"
			readonly guides: readonly GeometryGuide[]
			readonly paths: readonly CustomPath[]
			// a:rect, as guide names or numbers.
			readonly textRect?: { readonly l: string; readonly t: string; readonly r: string; readonly b: string }
	  }

export interface GeometryGuide {
	readonly name: string
	readonly formula: string
}

// One a:path: commands (PATH_* below) and their coordinates in the path's own w × h space. Typed arrays, so
// an ink stroke or a motion-path freeform of 100,000 points stays two buffers.
export interface CustomPath {
	readonly w: number
	readonly h: number
	readonly fill: "norm" | "none" | "lighten" | "lightenLess" | "darken" | "darkenLess"
	readonly stroke: boolean
	readonly extrusionOk: boolean
	readonly commands: Uint8Array
	readonly coords: Float64Array
}

// CustomPath commands: moveTo (x y), lnTo (x y), cubicBezTo (3 points), quadBezTo (2 points), arcTo (wR hR stAng
// swAng), close.
export const PATH_MOVE = 0
export const PATH_LINE = 1
export const PATH_CUBIC = 2
export const PATH_QUAD = 3
export const PATH_ARC = 4
export const PATH_CLOSE = 5

// A colour as the source names it, so a theme change recolours it: sRGB, a scheme slot, a preset name or a
// system colour, with its modifiers (lumMod, tint, alpha… with their values, in order).
export type ColorModel =
	| { readonly kind: "srgb"; readonly rgb: string; readonly mods?: readonly ColorMod[] }
	| { readonly kind: "scheme"; readonly slot: SchemeSlot; readonly mods?: readonly ColorMod[] }
	| { readonly kind: "preset"; readonly name: string; readonly mods?: readonly ColorMod[] }
	| { readonly kind: "system"; readonly name: string; readonly lastColor?: string; readonly mods?: readonly ColorMod[] }

export interface ColorMod {
	readonly name: string
	readonly value?: number
}

export type SchemeSlot =
	| "dk1"
	| "lt1"
	| "dk2"
	| "lt2"
	| "accent1"
	| "accent2"
	| "accent3"
	| "accent4"
	| "accent5"
	| "accent6"
	| "hlink"
	| "folHlink"
	| "bg1"
	| "tx1"
	| "bg2"
	| "tx2"
	| "phClr"

// A fill as written (theme-relative colours kept), resolved to a drawingml Paint only when painting.
export type FillProps =
	| { readonly kind: "solid"; readonly color: ColorModel }
	| {
			readonly kind: "gradient"
			readonly stops: readonly { readonly pos: number; readonly color: ColorModel }[]
			readonly linear?: { readonly angle: number; readonly scaled: boolean }
			readonly path?: { readonly shape: "circle" | "rect" | "shape"; readonly fillTo: EdgeFractions }
			readonly rotWithShape?: boolean
	  }
	| { readonly kind: "pattern"; readonly preset: string; readonly fg: ColorModel; readonly bg: ColorModel }
	| {
			readonly kind: "picture"
			// The image part, or an image an op inserted (edit/ops.ts InsertedImage) before it has a part: its id in the
			// worker's image registry, assigned at apply.
			readonly part?: string
			readonly inserted?: number
			readonly crop?: EdgeFractions
			readonly stretch?: EdgeFractions
			readonly tile?: { tx: number; ty: number; sx: number; sy: number; flip: "none" | "x" | "y" | "xy"; algn: string }
	  }
	| { readonly kind: "group" }

// l, t, r, b in 1/100,000 of the box.
export interface EdgeFractions {
	readonly l: number
	readonly t: number
	readonly r: number
	readonly b: number
}

export interface LineProps {
	// EMU.
	readonly w?: number
	readonly fill?: FillProps | "none"
	readonly dash?: string
	readonly custDash?: Float64Array
	readonly cap?: "flat" | "rnd" | "sq"
	readonly join?: "round" | "bevel" | "miter"
	readonly compound?: "sng" | "dbl" | "thickThin" | "thinThick" | "tri"
	readonly align?: "ctr" | "in"
	readonly head?: LineEnd
	readonly tail?: LineEnd
}

export interface LineEnd {
	readonly type: "none" | "triangle" | "stealth" | "diamond" | "oval" | "arrow"
	readonly w: "sm" | "med" | "lg"
	readonly len: "sm" | "med" | "lg"
}

// a:effectLst as written. Effects a reader does not model stay in the source (`src`).
export interface EffectList {
	readonly effects: readonly Effect[]
	readonly src?: SourceRef
}

export type Effect =
	| {
			readonly kind: "outerShdw" | "innerShdw"
			readonly color: ColorModel
			readonly blurRad: number
			readonly dist: number
			readonly dir: number
			readonly sx?: number
			readonly sy?: number
			readonly algn?: string
			readonly rotWithShape?: boolean
	  }
	| { readonly kind: "prstShdw"; readonly preset: string; readonly color: ColorModel; readonly dist: number; readonly dir: number }
	| { readonly kind: "glow"; readonly color: ColorModel; readonly rad: number }
	| { readonly kind: "softEdge"; readonly rad: number }
	| { readonly kind: "blur"; readonly rad: number; readonly grow: boolean }
	| {
			readonly kind: "reflection"
			readonly blurRad: number
			readonly stA: number
			readonly endA: number
			readonly endPos: number
			readonly dist: number
			readonly dir: number
			readonly sy?: number
	  }

// p:style: the theme matrix references.
export interface ShapeStyleRefs {
	readonly ln: StyleMatrixRef
	readonly fill: StyleMatrixRef
	readonly effect: StyleMatrixRef
	readonly font: { readonly idx: "major" | "minor" | "none"; readonly color?: ColorModel }
}

export interface StyleMatrixRef {
	readonly idx: number
	readonly color?: ColorModel
}

export interface TextBody {
	bodyPr: Partial<TextBodyProps>
	lstStyle?: ListStyle
	paragraphs: Paragraph[]
}

export interface Paragraph {
	pPr: ParaProps
	runs: Run[]
	endRPr?: RunProps
	src?: SourceRef
}

export type Run =
	| { readonly kind: "r"; readonly text: string; readonly rPr: RunProps }
	| { readonly kind: "br"; readonly rPr: RunProps }
	| { readonly kind: "fld"; readonly type: string; readonly id: string; readonly text: string; readonly rPr: RunProps }
	// Content kept as its source (a14:m math, unknown run content): `text` is what find and the outline see.
	| { readonly kind: "opaque"; readonly src: SourceRef; readonly text: string }

// a:rPr as written; absent fields inherit (§1.3 chain).
export interface RunProps {
	// Hundredths of a point.
	readonly sz?: number
	readonly b?: boolean
	readonly i?: boolean
	readonly u?: TextUnderline
	readonly strike?: "noStrike" | "sngStrike" | "dblStrike"
	// 1/100,000 of the size; positive raises.
	readonly baseline?: number
	readonly cap?: "none" | "small" | "all"
	// Hundredths of a point.
	readonly spc?: number
	readonly kern?: number
	readonly lang?: string
	readonly altLang?: string
	readonly latin?: FontRef
	readonly ea?: FontRef
	readonly cs?: FontRef
	readonly sym?: FontRef
	readonly fill?: FillProps | "none"
	readonly ln?: LineProps | "none"
	readonly effects?: EffectList
	readonly highlight?: ColorModel
	readonly uLn?: LineProps | "text"
	readonly uFill?: FillProps | "text"
	readonly hlinkClick?: Action
	readonly hlinkMouseOver?: Action
	readonly noProof?: boolean
}

export interface FontRef {
	// A typeface or a theme reference (+mj-lt, +mn-ea…).
	readonly typeface: string
	readonly panose?: string
	readonly pitchFamily?: number
	readonly charset?: number
}

export type Spacing = { readonly pct: number } | { readonly pts: number }

export type Bullet =
	| { readonly kind: "none" }
	| { readonly kind: "char"; readonly char: string }
	| { readonly kind: "autoNum"; readonly scheme: string; readonly startAt?: number }
	| { readonly kind: "blip"; readonly part: string }

export interface ParaProps {
	readonly lvl?: number
	readonly algn?: TextAlign
	// EMU.
	readonly marL?: number
	readonly marR?: number
	readonly indent?: number
	readonly defTabSz?: number
	readonly rtl?: boolean
	readonly lnSpc?: Spacing
	readonly spcBef?: Spacing
	readonly spcAft?: Spacing
	readonly bullet?: Bullet
	// buClrTx / buSzTx / buFontTx are "follow text"; absent inherits.
	readonly buClr?: ColorModel | "text"
	readonly buSz?: { readonly pct: number } | { readonly pts: number } | "text"
	readonly buFont?: FontRef | "text"
	readonly tabs?: readonly { readonly pos: number; readonly algn: "l" | "ctr" | "r" | "dec" }[]
	readonly fontAlgn?: "auto" | "t" | "ctr" | "base" | "b"
	readonly eaLnBrk?: boolean
	readonly latinLnBrk?: boolean
	readonly hangingPunct?: boolean
	readonly defRPr?: RunProps
}

// a:lstStyle: the default plus nine levels (index 0 = lvl1pPr).
export interface ListStyle {
	def?: ParaProps
	levels: (ParaProps | undefined)[]
}

export type FrameRef =
	| { readonly kind: "table"; readonly table: TableModel }
	| {
			readonly kind: "chart"
			readonly part: string
			readonly workbook?: { readonly part: string; readonly kind: "xlsx" | "xls" | "odfTable" }
	  }
	| {
			readonly kind: "smartart"
			readonly data: string
			readonly layout: string
			readonly style: string
			readonly colors: string
			readonly drawing?: string
	  }
	| { readonly kind: "ole"; readonly progId: string; readonly part?: string; readonly preview?: string }
	| { readonly kind: "media"; readonly media: MediaRef }
	| { readonly kind: "unknown"; readonly src: SourceRef }

export interface TableModel {
	// Column widths, EMU.
	grid: number[]
	rows: TableRow[]
	// a:tableStyleId.
	styleId?: string
	flags: { firstRow: boolean; lastRow: boolean; firstCol: boolean; lastCol: boolean; bandRow: boolean; bandCol: boolean }
	src?: SourceRef
}

export interface TableRow {
	// EMU.
	h: number
	cells: TableCell[]
}

export interface TableCell {
	text: TextBody
	gridSpan?: number
	rowSpan?: number
	hMerge?: boolean
	vMerge?: boolean
	props?: TableCellProps
	src?: SourceRef
}

export interface TableCellProps {
	readonly fill?: FillProps | "none"
	readonly borders?: { readonly [side in "l" | "r" | "t" | "b" | "tl2br" | "bl2tr"]?: LineProps | "none" }
	// EMU.
	readonly marL?: number
	readonly marR?: number
	readonly marT?: number
	readonly marB?: number
	readonly anchor?: "t" | "ctr" | "b"
	readonly vert?: string
}

export interface MediaRef {
	kind: "audio" | "video"
	part?: string
	// A linked target, never fetched (§1.11.2).
	external?: string
	contentType: string
	size?: number
	poster?: string
}

export type Action =
	| { readonly kind: "internal"; readonly jump: "next" | "previous" | "first" | "last" | "end" | "lastViewed" }
	| { readonly kind: "slide"; readonly slide: SlideRef }
	| { readonly kind: "customShow"; readonly id: number; readonly returnAfter: boolean }
	// http, https and mailto only.
	| { readonly kind: "url"; readonly href: string }
	// Inert, kept in the file byte for byte, shown with its reason.
	| {
			readonly kind: "refused"
			readonly what: "program" | "macro" | "ole" | "file" | "script" | "execute" | "scheme"
			readonly raw: string
	  }

export type LockReason = "proofFailed" | "alternateContent" | "unknownFrame" | "gate" | "budget"

export interface ShowSettings {
	kind: "present" | "browse" | "kiosk"
	loop: boolean
	showNarration: boolean
	showAnimation: boolean
	useTimings: boolean
	range:
		| { readonly kind: "all" }
		| { readonly kind: "range"; readonly start: number; readonly end: number }
		| { readonly kind: "customShow"; readonly id: number }
	penColor?: ColorModel
	// Kiosk restart after inactivity (ms).
	restartMs?: number
}

export interface EmbeddedFontRef {
	readonly typeface: string
	readonly regular?: string
	readonly bold?: string
	readonly italic?: string
	readonly boldItalic?: string
	readonly charset?: number
	readonly pitchFamily?: number
}

// p:modifyVerifier (a write-reservation password; the deck opens view-only).
export interface ModifyVerifier {
	readonly algorithm: string
	readonly hash: string
	readonly salt: string
	readonly spinCount: number
}

export interface EncryptionInfoSummary {
	readonly scheme: "agile" | "standard" | "rc4" | "rc4CryptoApi" | "xor"
	readonly keyBits?: number
}

export interface Author {
	readonly id: string
	readonly name: string
	readonly initials?: string
	readonly userId?: string
	readonly providerId?: string
	// p:cmAuthor id of legacy comments.
	readonly legacyId?: number
}

export interface OpaqueRef {
	readonly part: string
	readonly kind: "custData" | "tags" | "extLst" | "vbaProject" | "other"
	readonly src?: SourceRef
}

// p:clrMap: each logical slot to a theme slot.
export type ClrMapKey =
	"bg1" | "tx1" | "bg2" | "tx2" | "accent1" | "accent2" | "accent3" | "accent4" | "accent5" | "accent6" | "hlink" | "folHlink"

export type ClrMap = { readonly [K in ClrMapKey]: SchemeSlot }

export interface ThemeRef {
	readonly part: string
	// Bumps when the theme is edited or replaced (an inherit memo key).
	revision: number
}

export type Background =
	| { readonly kind: "fill"; readonly fill: FillProps; readonly shadeToTitle?: boolean; readonly src?: SourceRef }
	// p:bgRef: a background fill style of the theme (idx ≥ 1001) with its colour.
	| { readonly kind: "ref"; readonly idx: number; readonly color?: ColorModel; readonly src?: SourceRef }

export interface HeaderFooterFlags {
	readonly sldNum: boolean
	readonly hdr: boolean
	readonly ftr: boolean
	readonly dt: boolean
}

export interface CommentRef {
	readonly id: string
	readonly part: string
	readonly kind: "legacy" | "modern" | "odf"
}
