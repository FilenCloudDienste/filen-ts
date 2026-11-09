import { appendAll } from "../arrays"
import { presetGeometry, shapeGraphic, type ShapeLook } from "../doc/toDocx/drawing"
import { artColor } from "../doc/toDocx/officeArt"
import { isConnector, presetOf } from "../ppt/officeArt"
import { escapeAttribute, escapeText } from "../xml/index"
import { CHECKPOINT_SPACING, deepCopy, deepEqual, type Checkpoint, type FrameState, type RtfCheckpoints } from "./checkpoint"
import { SYMBOL_CODEPAGE, charsetCodepage, codepageSupported, decodeCodepage } from "./codepage"
import {
	DocumentParts,
	MARK,
	type FontEntry,
	type ListDef,
	type ListLevelDef,
	type ListOverrideDef,
	type RtfContainer,
	type RtfFacts,
	type RtfTableName,
	type SourceRange,
	type StyleDef
} from "./document"
import { OmmlBuilder } from "./math"
import { PictureBuilder, type Picture } from "./pict"
import { sliceClock } from "../slicing"
import { jobOf, turn, type RtfJob, type RtfTurns } from "./turns"
import {
	BORDER_STYLES,
	CharProps,
	ParaProps,
	SectProps,
	UNDERLINES,
	newBorder,
	newCell,
	newFrame,
	newRow,
	newShading,
	shadingConflict,
	shadingTexture,
	type Border,
	type CellDef,
	type Frame as Positioned,
	type RowDef,
	type Shading,
	type Toggle
} from "./props"
import { Story, type Block, type TextKind } from "./story"
import { RtfTokenizer, Token } from "./tokenizer"
import { dttm, isoDate } from "./values"

// The RTF reader (Microsoft RTF Specification 1.9.1): one pass over the tokens with a stack of group states
// (character and paragraph properties, \ucN, the destination), filling a WordprocessingML document the
// docx engine opens. What the model does not hold (shapes beyond their pictures, preset geometry, text and WordArt,
// drawing objects, embedded objects, form-field data, unknown \* destinations) is skipped and reported with its
// source range; the source bytes stay the file's truth, never dropped. Equations and drawn shapes are reported so too:
// their source is written again as it was.

// Why an RTF file cannot be read at all.
export type RtfFailure = "notRtf"

// Kinds of source the document does not model: kept in the source bytes only.
export type RtfPreservedKind =
	| "destination"
	| "shape"
	| "shapeGroup"
	| "textbox"
	| "drawingObject"
	| "object"
	| "math"
	| "formField"
	| "picture"
	| "tooDeep"
	// State words a paragraph's text is shown under that the translation cannot hold (\\nocwrap, \\fittextN...).
	| "word"
	| "unclosedGroup"
	// Bytes after the document's closing brace (readers ignore them).
	| "trailing"

export interface RtfPreserved {
	readonly kind: RtfPreservedKind
	// The destination or picture source involved.
	readonly name: string
	readonly start: number
	readonly end: number
}

export interface RtfSourceParagraph {
	// "body", "header", "footer", "footnote", "endnote", "comment".
	readonly story: string
	readonly index: number
	readonly start: number
	readonly end: number
}

export interface RtfReadResult {
	readonly ok: true
	// The document as a WordprocessingML package (stored zip entries).
	readonly docx: Uint8Array
	readonly preserved: readonly RtfPreserved[]
	// Code pages the platform cannot decode (Windows-1252 stood in for them).
	readonly unsupportedCodepages: readonly number[]
	// Each paragraph's source range, by story, in reading order.
	readonly paragraphs: readonly RtfSourceParagraph[]
	// \binN data reaching past the end of the input.
	readonly truncatedBinary: boolean
	// Content the translation draws nowhere among what `preserved` keeps (a shape is drawn by its picture, its text
	// box's paragraphs or its WordArt; an object by its \result): shapes and objects that leave nothing on a page.
	readonly undrawn: number
	// Where each story's blocks came from, in the order the translation writes them, and the facts the writer
	// needs: what makes a lossless writer possible.
	readonly containers: readonly RtfContainer[]
	readonly facts: RtfFacts
	// What re-reading a span of an edited copy starts from (none where the file offers no point to start at).
	readonly checkpoints: RtfCheckpoints | undefined
}

export type RtfReadOutcome = RtfReadResult | { readonly ok: false; readonly reason: RtfFailure }

// Groups nested deeper than this are skipped whole (and reported): every depth costs a state.
export const MAX_GROUP_DEPTH = 512

type Dest =
	| { readonly kind: "story"; readonly story: Story; readonly mode: "text" | "instr" }
	| { readonly kind: "ignore" }
	| { readonly kind: "fonts" }
	| { readonly kind: "colors" }
	| { readonly kind: "styles" }
	| { readonly kind: "style"; readonly style: StyleDef }
	| { readonly kind: "lists" }
	| { readonly kind: "list"; readonly list: ListDef }
	| { readonly kind: "level"; readonly level: ListLevelDef }
	| { readonly kind: "overrides" }
	| { readonly kind: "override"; readonly override: ListOverrideDef }
	| { readonly kind: "lfo"; readonly override: ListOverrideDef; readonly index: number }
	| { readonly kind: "capture"; text: string; readonly done: (text: string) => void }
	| { readonly kind: "info" }
	| { readonly kind: "revtbl" }
	| { readonly kind: "pict"; readonly picture: PictureBuilder; readonly done: (picture: PictureBuilder) => void }
	// \\picprop: the property being read (\\sn) and the picture it goes to.
	| { readonly kind: "picprop"; readonly picture: PictureBuilder; name: string }
	| { readonly kind: "shape"; readonly shape: ShapeState }
	// An equation (\\mmath, \\moMath): its groups are Office Math elements.
	| { readonly kind: "math"; readonly math: OmmlBuilder }
	| { readonly kind: "datetime"; readonly date: number[]; readonly done: (date: number[]) => void }

interface ShapeState {
	readonly story: Story
	picture: Picture | undefined
	name: string
	left: number
	top: number
	right: number
	bottom: number
	relH: string
	relV: string
	wrap: number
	wrapSide: number
	behind: boolean
	relHProp: number
	relVProp: number
	ignoreX: boolean
	ignoreY: boolean
	textbox: boolean
	// WordArt's text (the gtextUNICODE property), "" for none.
	wordArt: string
	// Its look (MS-ODRAW §2.3: shapeType, fFilled, fillColor, fLine, lineColor, lineWidth, rotation, fFlipH, fFlipV,
	// dxTextLeft...): -1 or undefined when unset.
	shapeType: number
	filled: boolean | undefined
	fillColor: number | undefined
	lined: boolean | undefined
	lineColor: number | undefined
	lineWidth: number | undefined
	rotation: number
	flipH: boolean
	flipV: boolean
	insets: [number, number, number, number]
	// A group member's rectangle in its group's coordinates (relLeft, relTop, relRight, relBottom), and a group's
	// coordinate space (groupLeft...; 0, 0, 20000, 20000 by default).
	rel: [number, number, number, number] | undefined
	readonly space: [number, number, number, number]
	// A group (\\shpgrp), and the group a shape is in.
	readonly group: boolean
	readonly parent: ShapeState | undefined
}

interface Frame {
	char: CharProps
	charOwned: boolean
	para: ParaProps
	paraOwned: boolean
	uc: number
	dest: Dest
	onEnd: (() => void) | undefined
	// \upr: its first subgroup (the ANSI copy) is skipped, the \*\ud one read.
	upr: boolean
	// The next control word decides the group's destination (\* was just read).
	ignorable: boolean
	// Inside \*\nesttableprops: \trowd defines the nested row.
	nestProps: boolean
	// The offset of the group's opening brace.
	start: number
	// Inside a drawing object's text box: every paragraph is positioned as the box.
	box: Positioned | undefined
	// Inside an old-properties group (\\oldcprops...): its revision's author and date (\\crauthN, \\crdateN...).
	old: { author: number; date: number } | undefined
	// The group as the writer's openGroups sees it: the document's, or one a destination word (or \\*) opens.
	opener: boolean
}

interface FieldState {
	// Its begin's index among the document's field begins (written as a marker: a form field's w:ffData is read
	// after the begin is).
	begin: number
	begun: boolean
	separated: boolean
	lock: boolean
	dirty: boolean
	readonly story: Story
	// The instruction text and whether the result showed anything (an empty SYMBOL result is computed).
	instruction: string
	result: boolean
}

// Destinations the reader never shows: their groups are skipped whole (the specification's destination
// words, less those read below). Text in an unknown destination without \* is shown, as the specification
// requires of readers.
const SKIPPED: ReadonlySet<string> = new Set([
	"aftncn",
	"aftnsep",
	"aftnsepc",
	"atnicn",
	"atnparent",
	"atntime",
	"background",
	"blipuid",
	"bxe",
	"colorschememapping",
	"datafield",
	"datastore",
	"docvar",
	"ebcend",
	"ebcstart",
	"factoidname",
	"falt",
	"fchars",
	"ffdeftext",
	"ffentrymcr",
	"ffexitmcr",
	"ffformat",
	"ffhelptext",
	"ffl",
	"ffname",
	"ffstattext",
	"file",
	"filetbl",
	"fldtype",
	"fname",
	"fontemb",
	"fontfile",
	"formfield",
	"ftncn",
	"ftnsep",
	"ftnsepc",
	"g",
	"generator",
	"gridtbl",
	"hl",
	"hlfr",
	"hlinkbase",
	"hlloc",
	"hlsrc",
	"hsv",
	"keycode",
	"latentstyles",
	"lchars",
	"levelnumbers",
	"linkval",
	"listpicture",
	"lsdlockedexcept",
	"macc",
	"mailmerge",
	"mmathPr",
	"nonesttables",
	"nonshppict",
	"objalias",
	"objclass",
	"objdata",
	"objname",
	"objsect",
	"objtime",
	"oleclsid",
	"panose",
	"password",
	"passwordhash",
	"pgdsctbl",
	"pgp",
	"pgptbl",
	"pnseclvl",
	"pntxta",
	"pntxtb",
	"private",
	"protusertbl",
	"pxe",
	"rsidtbl",
	"rxe",
	"tc",
	"tcn",
	"template",
	"themedata",
	"txe",
	"userprops",
	"wgrffmtfilter",
	"windowcaption",
	"writereservation",
	"writereservhash",
	"xe",
	"xform",
	"xmlattrname",
	"xmlattrvalue",
	"xmlclose",
	"xmlname",
	"xmlnstbl",
	"xmlopen"
])

// Skipped destinations that hold content the document shows elsewhere or not at all, reported by kind (an equation
// where text shows is read as Office Math, its group reported as math).
const PRESERVED_KIND: ReadonlyMap<string, RtfPreservedKind> = new Map([
	["objdata", "object"],
	["formfield", "formField"],
	["moMath", "math"],
	["moMathPara", "math"],
	["mmath", "math"]
])

// Words read after \* (anything else after \* is an unknown destination and skipped).
const IGNORABLE_READ: ReadonlySet<string> = new Set([
	"picprop",
	"oldcprops",
	"oldpprops",
	"oldsprops",
	"oldtprops",
	"annotation",
	"atndate",
	"atnid",
	"atnauthor",
	"atnref",
	"atrfend",
	"atrfstart",
	"bkmkend",
	"bkmkstart",
	"cs",
	"ds",
	"ts",
	"defchp",
	"defpap",
	"fldinst",
	"listtable",
	"listoverridetable",
	"nesttableprops",
	"pn",
	"shpinst",
	"shppict",
	"ud",
	"revtbl"
])

// Characters control words stand for.
const CHARACTERS: ReadonlyMap<string, string> = new Map(
	(
		[
			["emdash", 0x2014],
			["endash", 0x2013],
			["emspace", 0x2003],
			["enspace", 0x2002],
			["qmspace", 0x2005],
			["bullet", 0x2022],
			["lquote", 0x2018],
			["rquote", 0x2019],
			["ldblquote", 0x201c],
			["rdblquote", 0x201d],
			["zwj", 0x200d],
			["zwnj", 0x200c],
			["zwbo", 0x200b],
			["zwnbo", 0xfeff],
			["ltrmark", 0x200e],
			["rtlmark", 0x200f]
		] as const
	).map(([name, code]) => [name, String.fromCharCode(code)])
)

const ALIGNMENTS: ReadonlyMap<string, string> = new Map([
	["ql", "left"],
	["qr", "right"],
	["qc", "center"],
	["qj", "both"],
	["qd", "distribute"],
	["qt", "thaiDistribute"]
])

const PAGE_FORMATS: ReadonlyMap<string, string> = new Map([
	["pgndec", "decimal"],
	["pgnucrm", "upperRoman"],
	["pgnlcrm", "lowerRoman"],
	["pgnucltr", "upperLetter"],
	["pgnlcltr", "lowerLetter"]
])

const NOTE_FORMATS: ReadonlyMap<string, string> = new Map([
	["ftnnar", "decimal"],
	["ftnnalc", "lowerLetter"],
	["ftnnauc", "upperLetter"],
	["ftnnrlc", "lowerRoman"],
	["ftnnruc", "upperRoman"],
	["ftnnchi", "chicago"]
])

const TAB_KINDS: ReadonlyMap<string, string> = new Map([
	["tqr", "right"],
	["tqc", "center"],
	["tqdec", "decimal"]
])

const TAB_LEADERS: ReadonlyMap<string, string> = new Map([
	["tldot", "dot"],
	["tlmdot", "middleDot"],
	["tlhyph", "hyphen"],
	["tlul", "underscore"],
	["tlth", "heavy"],
	["tleq", "underscore"]
])

// Toggled character properties: \b, \b0, \b1.
const CHAR_TOGGLES: ReadonlyMap<string, keyof CharProps> = new Map([
	["b", "bold"],
	["ab", "boldCs"],
	["i", "italic"],
	["ai", "italicCs"],
	["caps", "caps"],
	["scaps", "smallCaps"],
	["strike", "strike"],
	["striked", "dstrike"],
	["outl", "outline"],
	["shad", "shadow"],
	["embo", "emboss"],
	["impr", "imprint"],
	["v", "hidden"],
	["webhidden", "webHidden"],
	["noproof", "noProof"]
] as [string, keyof CharProps][])

// Emphasis marks (RTF 1.9.1 "Font (Character) Formatting Properties") as ST_Em (ECMA-376 Part 1 §17.18.24).
const EMPHASIS: ReadonlyMap<string, string> = new Map([
	["accnone", "none"],
	["accdot", "dot"],
	["acccomma", "comma"],
	["acccircle", "circle"],
	["accunderdot", "underDot"]
])

// \animtextN as ST_TextEffect (§17.18.94); 7 and 8 (wipes) have none.
const EFFECTS: readonly string[] = ["none", "lights", "blinkBackground", "sparkle", "antsBlack", "antsRed", "shimmer"]

// \qkN (0 low, 10 medium, 20 high) as ST_Jc's kashida lengths (§17.18.44).
const KASHIDA: ReadonlyMap<number, string> = new Map([
	[0, "lowKashida"],
	[10, "mediumKashida"],
	[20, "highKashida"]
])

// Font alignment (RTF 1.9.1 "Font Alignment") as ST_TextAlignment (§17.18.91), as LibreOffice 7.5 reads them.
const TEXT_ALIGNMENTS: ReadonlyMap<string, string> = new Map([
	["faauto", "auto"],
	["fahang", "top"],
	["facenter", "center"],
	["faroman", "baseline"],
	["favar", "bottom"]
])

// Paragraph words WordprocessingML has no exact counterpart for: \\nocwrap and \\nowwrap (whether they are
// kinsoku or word wrap the specification leaves open), \\lisaN and \\lisbN (character units, not lines),
// \\fafixed (no ST_TextAlignment) and \\collapsed.
const UNREAD_PARAGRAPH: ReadonlySet<string> = new Set(["nocwrap", "nowwrap", "lisa", "lisb", "fafixed", "collapsed"])

const DEFAULT_UC = 1

// The handler a control word goes to (see Reader.word).
const Route = { Document: 1, Character: 2, Paragraph: 3, Table: 4, Section: 5, Special: 6 } as const

type Route = (typeof Route)[keyof typeof Route]

// The words Reader.destination handles: every case label there.
const DESTINATIONS: ReadonlySet<string> = new Set([
	"picprop",
	"oldcprops",
	"oldpprops",
	"oldsprops",
	"oldtprops",
	"annotation",
	"atnauthor",
	"atndate",
	"atnid",
	"atnref",
	"atrfend",
	"atrfstart",
	"author",
	"bkmkend",
	"bkmkstart",
	"buptim",
	"category",
	"colortbl",
	"comment",
	"company",
	"creatim",
	"defchp",
	"defpap",
	"do",
	"doccomm",
	"dptxbxtext",
	"field",
	"fldinst",
	"fldrslt",
	"fonttbl",
	"footer",
	"footerf",
	"footerl",
	"footerr",
	"footnote",
	"header",
	"headerf",
	"headerl",
	"headerr",
	"info",
	"keywords",
	"leveltext",
	"lfolevel",
	"list",
	"listlevel",
	"listname",
	"listoverride",
	"listoverridetable",
	"liststylename",
	"listtable",
	"listtext",
	"manager",
	"nesttableprops",
	"object",
	"operator",
	"pict",
	"pn",
	"pntext",
	"printim",
	"result",
	"revtbl",
	"revtim",
	"shp",
	"shpgrp",
	"shpinst",
	"shppict",
	"shprslt",
	"shptxt",
	"sn",
	"sp",
	"stylesheet",
	"subject",
	"sv",
	"title",
	"ud",
	"upr"
])

// Whether a group whose first word is `name` is a destination (text in it is not the story's).
export function isDestinationWord(name: string): boolean {
	return DESTINATIONS.has(name) || SKIPPED.has(name)
}

// `stored`: the package's parts are stored, not deflated (one read to compare and drop: the RTF writer's proof).
// `turns`: read in slices.
export async function readRtf(
	bytes: Uint8Array,
	options: { readonly stored?: boolean; readonly turns?: RtfTurns } = {}
): Promise<RtfReadOutcome> {
	if (!isRtf(bytes)) return { ok: false, reason: "notRtf" }

	return new Reader(bytes, undefined, options.stored === true).read(jobOf(options.turns))
}

// A span of `bytes` (an edited copy of the file `checkpoints` came from) read from the checkpoint `from`, whose
// bytes through `from.offset + 1` the copy shares: the body's top-level paragraphs it reads until the state
// equals the source's at a checkpoint `to` in the bytes the copy shares again ([regionEnd, end) are the source's
// [regionEnd - delta, end)), from where the copy reads as the source. Undefined when the span holds anything but
// plain tokens, or does not converge before `limit`.
export function readSpan(
	bytes: Uint8Array,
	checkpoints: RtfCheckpoints,
	from: Checkpoint,
	regionEnd: number,
	delta: number,
	limit: number
): { readonly blocks: readonly Block[]; readonly to: Checkpoint } | undefined {
	const span: Span = { checkpoints, from, regionEnd, delta, limit, at: checkpointsByOffset(checkpoints), to: undefined }
	const reader = new Reader(bytes, span)

	try {
		reader.loop()
	} catch (error) {
		if (error !== SPAN_DONE) {
			if (error === SPAN_ABORT) return undefined

			throw error
		}
	}

	const to = span.to

	return to === undefined ? undefined : { blocks: reader.bodyBlocks(), to }
}

const byOffset = new WeakMap<RtfCheckpoints, Map<number, Checkpoint>>()

function checkpointsByOffset(checkpoints: RtfCheckpoints): ReadonlyMap<number, Checkpoint> {
	let map = byOffset.get(checkpoints)

	if (map === undefined) {
		map = new Map(checkpoints.list.map(checkpoint => [checkpoint.offset, checkpoint]))
		byOffset.set(checkpoints, map)
	}

	return map
}

interface Span {
	readonly checkpoints: RtfCheckpoints
	readonly from: Checkpoint
	readonly regionEnd: number
	readonly delta: number
	readonly limit: number
	readonly at: ReadonlyMap<number, Checkpoint>
	to: Checkpoint | undefined
}

// A sliced reading loop's stop between tokens.
const PAUSED = Symbol("paused")

// Thrown out of a span's reading loop: converged, or a token that is not plain (or no convergence in reach).
const SPAN_DONE = new Error("span converged")
const SPAN_ABORT = new Error("span not plain")

// How a control word bears on re-reading (see Reader.plain): not plain, properties only, text, a paragraph's end.
const Plain = { No: 0, Props: 1, Text: 2, Paragraph: 3 } as const

type Plain = (typeof Plain)[keyof typeof Plain]

// Plain words of the character, paragraph and special routes that still are not: they change state the
// checkpoints do not hold (the border words change the border last named in place), or reach notes and fields.
const UNPLAIN_WORDS: ReadonlySet<string> = new Set([
	"chbrdr",
	"brdrt",
	"brdrb",
	"brdrl",
	"brdrr",
	"brdrbtw",
	"brdrbar",
	"box",
	"brdrw",
	"brsp",
	"brdrcf",
	"chftn",
	"ftnalt",
	"chatn",
	"chpgn",
	"chdate",
	"chtime",
	"sectnum",
	"fldlock",
	"flddirty"
])
const TEXT_WORDS: ReadonlySet<string> = new Set(["u", "tab", "line", "page", "column", "lbr"])
const PROBED_ROUTES = new Map<string, Route>()
const PROBE_BYTES = new Uint8Array(0)
// Destinations whose content the tables (fonts, colours, styles, lists, authors) are read from.
const TABLE_DESTINATIONS: ReadonlySet<string> = new Set([
	"fonttbl",
	"colortbl",
	"stylesheet",
	"listtable",
	"listoverridetable",
	"revtbl",
	"defchp",
	"defpap"
])

// "{\rtf" after optional whitespace (and a UTF-8 byte order mark some writers add).
export function isRtf(bytes: Uint8Array): boolean {
	let at = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0

	while (at < bytes.length && (bytes[at] === 0x20 || bytes[at] === 0x0d || bytes[at] === 0x0a || bytes[at] === 0x09)) at++

	return bytes[at] === 0x7b && bytes[at + 1] === 0x5c && bytes[at + 2] === 0x72 && bytes[at + 3] === 0x74 && bytes[at + 4] === 0x66
}

class Reader {
	private readonly tokens: RtfTokenizer
	private readonly bytes: Uint8Array
	private readonly doc: DocumentParts
	private readonly stack: Frame[] = []
	private frame: Frame
	private readonly preserved: RtfPreserved[] = []
	private undrawn = 0
	// Per open \object group, whether its \result has been read.
	private readonly objectResults: boolean[] = []
	// Where the last table group or kept source range ends (see touchGroups).
	private groupFloor = -1
	private readonly unsupported = new Set<number>()
	private truncatedBinary = false
	private readonly routes: Map<string, Route>
	private depth = 0
	// Pending text bytes (decoded together so two-byte characters split over \'hh pairs survive).
	private pending = new Uint8Array(256)
	private pendingLength = 0
	// Where the pending text began in the source.
	private pendingStart = 0
	// The source offset of the characters being placed (-1: the current token's).
	private textAt = -1
	private skip = 0
	private documentCodepage = 1252
	private defaultFont = -1
	private readonly fonts: Map<number, FontEntry>
	private currentFont: FontEntry | undefined = undefined
	private color: [number, number, number] = [-1, -1, -1]
	private readonly colors: (string | undefined)[]
	// Row definitions by nesting depth, and the cell being defined.
	private readonly rows = new Map<number, RowDef>()
	private row: RowDef = newRow()
	private cell: CellDef = newCell()
	private border: Border | undefined = undefined
	private borderOwner: "para" | "char" | "none" = "none"
	private section = new SectProps()
	private readonly sectionDefaults = new SectProps()
	private readonly fields: FieldState[] = []
	private noteMark = false
	private annotationAuthor = ""
	private annotationInitials = ""
	private widowControl = false
	private readonly tableGroups: Partial<Record<RtfTableName, SourceRange>> = {}
	private readonly revisionWords: SourceRange[] = []
	// The source of the last picture placed in a story (a \\shppict wrapper and a \\nonshppict after it join it).
	private lastPicture: { start: number; end: number } | undefined = undefined
	// Where the last nested cell or row (\\nestcell, \\nestrow) ended in its story, and that story: what a
	// {\\nonesttables ...} group or the end of {\\*\\nesttableprops ...} right after it extends (Story.extend).
	private nested: { story: Story; mark: number } | undefined = undefined
	// Re-reading (checkpoint.ts): tokens read that were not plain, that count when a table destination last began,
	// the checkpoints taken (a span's reader takes none) and each word's bearing.
	private unplain = 0
	private tablesUntil = 0
	private readonly checkpoints: Checkpoint[] | undefined
	private lastCheckpoint = -CHECKPOINT_SPACING
	private readonly plainWords: Map<string, Plain>
	// The token being handled is a plain paragraph end.
	private paragraphEnds = false
	// A group just opened: the next token says whether it is an opener (Frame.opener).
	private opening = false
	// The end actions of list label groups (\\listtext, \\pntext): plain, they change the paragraph being read only.
	private readonly labelEnds = new WeakSet<() => void>()
	private readonly span: Span | undefined

	private readonly stored: boolean
	// The document group has opened (a span starts in it); kept across a sliced read's loops.
	private started: boolean
	private looks = 0

	constructor(bytes: Uint8Array, span?: Span, stored = false) {
		this.bytes = bytes
		this.span = span
		this.stored = stored
		this.started = span !== undefined

		const tables = span?.checkpoints

		this.tokens = new RtfTokenizer(bytes, span?.from.offset ?? 0)
		this.doc = new DocumentParts()
		this.fonts = new Map(tables?.fonts)
		this.colors = tables === undefined ? [] : [...tables.colors]
		this.routes = new Map(tables?.routes as ReadonlyMap<string, Route> | undefined)
		this.plainWords = new Map(tables?.plainWords as ReadonlyMap<string, Plain> | undefined)
		this.checkpoints = span === undefined ? [] : undefined
		this.doc.setTables(this.colors, this.fonts)

		const body = this.doc.body
		const dest: Dest = { kind: "story", story: body, mode: "text" }

		this.frame = {
			char: new CharProps(),
			charOwned: true,
			para: new ParaProps(),
			paraOwned: true,
			uc: DEFAULT_UC,
			dest,
			onEnd: undefined,
			upr: false,
			ignorable: false,
			nestProps: false,
			start: 0,
			box: undefined,
			old: undefined,
			opener: false
		}

		if (span === undefined || tables === undefined) return

		// The state at the checkpoint: its tables, and its groups sharing the checkpoint's properties (copied on
		// write, as every group's are).
		for (const style of tables.styles) this.doc.styles.push(style)
		for (const list of tables.lists) this.doc.lists.push(list)
		for (const override of tables.overrides) this.doc.overrides.push(override)
		this.doc.revisionText = tables.revisionText

		const from = span.from
		const frames = from.frames.map((state): Frame => ({
			char: state.char,
			charOwned: false,
			para: state.para,
			paraOwned: false,
			uc: state.uc,
			dest,
			onEnd: undefined,
			upr: false,
			ignorable: false,
			nestProps: state.nestProps,
			start: state.start,
			box: undefined,
			old: undefined,
			opener: state.opener
		}))

		this.frame = frames.pop() ?? this.frame
		appendAll(this.stack, frames)
		this.depth = from.depth
		this.skip = from.skip
		this.noteMark = from.noteMark
		this.documentCodepage = from.documentCodepage
		this.defaultFont = from.defaultFont
		this.groupFloor = from.groupFloor
		body.mark = from.paragraphEnd
	}

	// The body's blocks read (a span's: its paragraphs).
	bodyBlocks(): readonly Block[] {
		return this.doc.body.blocks
	}

	async read(job?: RtfJob): Promise<RtfReadResult> {
		if (job === undefined) {
			const end = this.loop()

			return this.finish(end === PAUSED ? undefined : end)
		}

		let end = this.loop(job.due)

		while (end === PAUSED) {
			await turn(job)
			end = this.loop(job.due)
		}

		return this.finish(end, job)
	}

	// The reading loop: where the document group closes (undefined when it never does). A span's ends by throwing
	// (see readSpan). With `due` it stops between tokens once due (PAUSED), to go on where it stopped when called again.
	loop(due?: () => boolean): number | undefined | typeof PAUSED {
		const tokens = this.tokens

		for (;;) {
			// The clock is read every few hundred tokens.
			if (due !== undefined && (++this.looks & 511) === 0 && due()) return PAUSED

			const kind = tokens.next()

			if (kind === Token.End) break

			if (this.opening) {
				if (kind === Token.Symbol && tokens.symbol === 0x2a) this.frame.opener = true
				else {
					if (kind === Token.Word && isDestinationWord(tokens.name)) this.frame.opener = true

					this.opening = false
				}
			}

			if (this.skip > 0) {
				if (kind === Token.GroupStart || kind === Token.GroupEnd) this.skip = 0
				else if (kind === Token.Text) {
					const length = tokens.textEnd - tokens.textStart

					if (length <= this.skip) {
						this.skip -= length

						continue
					}

					tokens.textStart += this.skip
					this.skip = 0
				} else {
					this.skip--

					continue
				}
			}

			if (!this.plain(kind)) {
				if (this.span !== undefined) throw SPAN_ABORT

				this.unplain++
			} else if (this.unplain > this.tablesUntil && this.checkpoints !== undefined && this.checkpoints.length <= 1) {
				// Before the first plain token past the tables (a table after a checkpoint makes it unusable): where a
				// span changing the body's first blocks starts.
				const first = this.checkpoints[0]

				// No block read yet (none open in a table either).
				if ((first === undefined || first.unplain <= this.tablesUntil) && this.doc.body.mark < 0) {
					const checkpoint = this.checkpoint(false, tokens.start)

					if (checkpoint !== undefined) this.checkpoints[0] = checkpoint
				}
			}

			switch (kind) {
				case Token.GroupStart: {
					this.flush()

					if (this.started && this.depth >= MAX_GROUP_DEPTH) {
						const start = tokens.start

						tokens.skipGroup()
						this.preserve("tooDeep", "", start, tokens.position)

						break
					}

					if (this.frame.upr && this.frame.ignorable === false && this.uprSkip()) break

					this.depth++
					this.started = true
					this.push()
					this.opening = true

					break
				}
				case Token.GroupEnd:
					this.flush()

					if (this.depth === 0) break

					this.depth--
					this.pop()

					if (this.depth === 0 && this.started) {
						this.documentEnd()
						this.trailing(tokens.position)

						return tokens.start
					}

					break
				case Token.Word:
					this.flush()
					this.word(tokens.name, tokens.param, tokens.hasParam)

					break
				case Token.Symbol:
					this.symbol(tokens.symbol)

					break
				case Token.Hex:
					if (tokens.value >= 0) this.byte(tokens.value)

					break
				case Token.Text:
					this.textBytes(tokens.textStart, tokens.textEnd)

					break
				case Token.Bin:
					this.flush()

					if (tokens.clamped) this.truncatedBinary = true

					if (this.frame.dest.kind === "pict") this.frame.dest.picture.binary(this.bytes, tokens.dataStart, tokens.dataEnd)

					break
			}

			if (this.paragraphEnds) {
				this.paragraphEnds = false
				this.paragraphEnd()
			}
		}

		return undefined
	}

	// ---- re-reading (checkpoint.ts)

	// Whether the token just read is plain: body text, and the character and paragraph words around it, in groups
	// that hold nothing else. A plain token changes only the open groups' state, \\ucN skipping and the body's
	// paragraphs (whose markup reads nothing but the tables); everything else the reader holds stays as it was.
	private plain(kind: Token): boolean {
		const frame = this.frame

		if (!this.plainFrame(frame) || this.fields.length > 0) return false

		switch (kind) {
			case Token.GroupStart:
				return this.depth < MAX_GROUP_DEPTH
			case Token.GroupEnd: {
				const parent = this.stack.at(-1)

				return parent !== undefined && this.plainFrame(parent)
			}
			case Token.Word:
				switch (this.plainWord(this.tokens.name)) {
					case Plain.Props:
						return true
					case Plain.Text:
						return plainChar(frame.char)
					case Plain.Paragraph:
						return this.plainParagraphEnd(frame)
					default:
						return false
				}
			case Token.Symbol:
				switch (this.tokens.symbol) {
					case 0x2a:
						return false
					case 0x0a:
						return this.plainParagraphEnd(frame)
					case 0x09:
					case 0x5c:
					case 0x7b:
					case 0x7d:
					case 0x7e:
					case 0x2d:
					case 0x5f:
						return plainChar(frame.char)
					default:
						return true
				}
			case Token.Hex:
			case Token.Text:
				return plainChar(frame.char)
			default:
				return false
		}
	}

	private plainFrame(frame: Frame): boolean {
		const dest = frame.dest

		return (
			dest.kind === "story" &&
			dest.story === this.doc.body &&
			dest.mode === "text" &&
			(frame.onEnd === undefined || this.labelEnds.has(frame.onEnd)) &&
			!frame.upr &&
			!frame.ignorable &&
			frame.box === undefined &&
			frame.old === undefined
		)
	}

	// \\par in plain groups ends a top-level paragraph whose markup asks nothing of the document (no revision ids).
	private plainParagraphEnd(frame: Frame): boolean {
		if (!plainChar(frame.char) || frame.para.old !== undefined || frame.para.depth() !== 0) return false

		this.paragraphEnds = true

		return true
	}

	// A word's bearing, by its route.
	private plainWord(name: string): Plain {
		const known = this.plainWords.get(name)

		if (known !== undefined) return known

		let plain: Plain = Plain.No

		// A list label's group: its text goes aside in the paragraph being read until the paragraph ends.
		if (name === "listtext" || name === "pntext") plain = Plain.Props
		else if (!UNPLAIN_WORDS.has(name) && !DESTINATIONS.has(name) && !SKIPPED.has(name) && !PRESERVED_KIND.has(name)) {
			const route = this.routes.get(name) ?? Reader.routeOf(name)

			if (name === "par") plain = Plain.Paragraph
			else if (route === Route.Character) plain = name === "u" ? Plain.Text : Plain.Props
			else if (route === Route.Paragraph) plain = BORDER_STYLES.has(name) ? Plain.No : Plain.Props
			else if (route === Route.Special) plain = TEXT_WORDS.has(name) || CHARACTERS.has(name) ? Plain.Text : Plain.Props
		}

		this.plainWords.set(name, plain)

		return plain
	}

	// The route of a word not met yet: found as reading finds it (by its name alone), by a reader of its own.
	private static routeOf(name: string): Route {
		let route = PROBED_ROUTES.get(name)

		if (route === undefined) {
			const probe = new Reader(PROBE_BYTES)

			probe.word(name, 0, false)
			route = probe.routes.get(name) ?? Route.Special
			PROBED_ROUTES.set(name, route)
		}

		return route
	}

	private paragraphEnd(): void {
		if (this.span !== undefined) {
			this.converge(false)

			return
		}

		const position = this.tokens.position

		if (this.checkpoints === undefined || position - this.lastCheckpoint < CHECKPOINT_SPACING) return

		const checkpoint = this.checkpoint(false)

		if (checkpoint === undefined) return

		this.checkpoints.push(checkpoint)
		this.lastCheckpoint = position
	}

	// The document group closed.
	private documentEnd(): void {
		if (this.span !== undefined) {
			this.converge(true)

			return
		}

		const checkpoint = this.checkpoint(true)

		if (checkpoint !== undefined) this.checkpoints?.push(checkpoint)
	}

	// The state now, where every open group is plain and the body has no open paragraph.
	// `before`: taken before the token starting there (no paragraph just ended).
	private checkpoint(end: boolean, before?: number): Checkpoint | undefined {
		const body = this.doc.body
		const frames = [...this.stack, this.frame]

		if (this.fields.length > 0 || this.skip !== 0 || this.pendingLength > 0 || !body.empty || body.unread !== "") return undefined

		for (const frame of frames) if (!this.plainFrame(frame)) return undefined

		const seen = new Map<object, unknown>()

		return {
			offset: before ?? this.tokens.position,
			paragraphEnd: end || before !== undefined ? -1 : this.tokens.end,
			blocks: body.blocks.length,
			unplain: this.unplain,
			frames: frames.map((frame): FrameState => ({
				char: deepCopy(frame.char, seen),
				para: deepCopy(frame.para, seen),
				uc: frame.uc,
				nestProps: frame.nestProps,
				start: frame.start,
				opener: frame.opener
			})),
			depth: this.depth,
			skip: this.skip,
			noteMark: this.noteMark,
			documentCodepage: this.documentCodepage,
			defaultFont: this.defaultFont,
			groupFloor: this.groupFloor,
			end
		}
	}

	// A span's paragraph end (or the document's): done once the state is the source's at a checkpoint in the bytes
	// the copy shares again.
	private converge(end: boolean): void {
		const span = this.span

		if (span === undefined) return

		const position = this.tokens.position
		const target = position < span.regionEnd ? undefined : span.at.get(position - span.delta)

		if (target === undefined || target.end !== end) {
			if (end || position > span.limit) throw SPAN_ABORT

			return
		}

		// The source read something not plain between the two checkpoints: no later one is reached either.
		if (target.unplain !== span.from.unplain) throw SPAN_ABORT

		if (!this.sameState(target)) {
			if (end || position > span.limit) throw SPAN_ABORT

			return
		}

		span.to = target

		throw SPAN_DONE
	}

	private sameState(checkpoint: Checkpoint): boolean {
		const body = this.doc.body

		if (
			this.depth !== checkpoint.depth ||
			this.skip !== checkpoint.skip ||
			this.noteMark !== checkpoint.noteMark ||
			this.documentCodepage !== checkpoint.documentCodepage ||
			this.defaultFont !== checkpoint.defaultFont ||
			this.fields.length > 0 ||
			this.pendingLength > 0 ||
			!body.empty ||
			body.unread !== "" ||
			this.stack.length + 1 !== checkpoint.frames.length
		)
			return false

		return checkpoint.frames.every((state, k) => {
			const frame = this.stack[k] ?? this.frame

			return (
				this.plainFrame(frame) &&
				frame.uc === state.uc &&
				frame.nestProps === state.nestProps &&
				deepEqual(frame.char, state.char) &&
				deepEqual(frame.para, state.para)
			)
		})
	}

	// The checkpoints and the tables a span reads with: those every usable checkpoint read with.
	private checkpointTables(): RtfCheckpoints | undefined {
		const list = this.checkpoints

		if (list === undefined || list.length === 0) return undefined

		// A list numbering looked up before the list tables were whole stays as it was first found: a span's
		// fresh lookup must find the same.
		const fresh = new DocumentParts()

		for (const entry of this.doc.lists) fresh.lists.push(entry)
		for (const override of this.doc.overrides) fresh.overrides.push(override)
		for (const override of this.doc.overrides) if (fresh.numId(override.ls) !== this.doc.numId(override.ls)) return undefined

		return {
			list,
			tablesUntil: this.tablesUntil,
			fonts: this.fonts,
			colors: this.colors,
			styles: this.doc.styles,
			lists: this.doc.lists,
			overrides: this.doc.overrides,
			revisionText: this.doc.revisionText,
			routes: this.routes,
			plainWords: this.plainWords
		}
	}

	// What follows the document group: anything but white space is reported.
	private trailing(from: number): void {
		const bytes = this.bytes

		for (let at = from; at < bytes.length; at++) {
			const byte = bytes[at] ?? 0

			if (byte !== 0x20 && byte !== 0x0d && byte !== 0x0a && byte !== 0x09 && byte !== 0x00) {
				this.preserve("trailing", "", from, bytes.length)

				return
			}
		}
	}

	// `end`: where the document group closes (the end of the input when it never does).
	private async finish(end: number = this.bytes.length, job?: RtfJob): Promise<RtfReadResult> {
		this.flush()

		if (this.depth > 0) this.preserve("unclosedGroup", "", this.bytes.length, this.bytes.length)

		while (this.stack.length > 0) this.pop()

		const body = this.doc.body

		this.noteParagraph(body, this.frame.para, this.frame.char)
		body.finish(this.paraXml(this.frame.para, this.frame.char, undefined), end)
		this.doc.bodyEnd = end

		const docx = await this.doc.write({
			section: this.sectionXml(),
			colors: this.colors,
			fonts: this.fonts,
			defaultFont: this.defaultFont,
			widowControl: this.widowControl,
			stored: this.stored,
			...(job === undefined ? {} : { slicing: sliceClock(job.aborting) })
		})

		for (const range of this.doc.unreadRanges) this.preserve("word", range.names, range.start, range.end)

		return {
			ok: true,
			docx,
			preserved: this.preserved,
			unsupportedCodepages: [...this.unsupported].sort((a, b) => a - b),
			paragraphs: this.doc.sourceParagraphs(),
			truncatedBinary: this.truncatedBinary,
			undrawn: this.undrawn,
			containers: this.doc.containers,
			facts: {
				codepage: this.documentCodepage,
				defaultFont: this.defaultFont,
				tables: this.tableGroups,
				fonts: [...this.fonts.values()].map(font => ({ index: font.index, name: font.name.trim(), charset: font.charset })),
				colors: this.colors,
				styles: this.doc.styleNumbers(),
				listIds: this.doc.lists.map(list => list.id),
				overrides: this.doc.overrides.map(override => override.ls),
				authors: this.doc.authors(),
				revisions: this.revisionWords
			},
			checkpoints: this.checkpointTables()
		}
	}

	// In a \upr group, a subgroup that is not \*\ud is the ANSI copy: skipped.
	private uprSkip(): boolean {
		const tokens = this.tokens
		const start = tokens.start
		const save = tokens.position
		const star = tokens.next()
		const word = star === Token.Symbol && tokens.symbol === 0x2a ? tokens.next() : Token.End

		if (word === Token.Word && tokens.name === "ud") {
			tokens.seek(save)

			return false
		}

		tokens.seek(start + 1)
		tokens.skipGroup()

		return true
	}

	// Old properties (RTF 1.9.1, "Old Properties"): the words that revert a tracked formatting change, applied to a
	// copy of the properties in force; the copy becomes the change's previous properties when the group ends.
	private oldProps(name: "oldcprops" | "oldpprops" | "oldsprops" | "oldtprops"): boolean {
		const frame = this.frame

		if (frame.dest.kind !== "story" || frame.old !== undefined) return false

		const old = { author: -1, date: 0 }

		frame.old = old

		switch (name) {
			case "oldcprops": {
				const copy = frame.char.clone()

				copy.old = undefined
				frame.char = copy
				frame.charOwned = true
				frame.onEnd = () => {
					const props = this.frameAfterEnd.char

					props.old = undefined
					props.cached = undefined
					this.char().old = { props, author: old.author, date: old.date }
				}
				return true
			}
			case "oldpprops": {
				const copy = frame.para.clone()

				copy.old = undefined
				frame.para = copy
				frame.paraOwned = true
				frame.onEnd = () => {
					const props = this.frameAfterEnd.para

					props.old = undefined
					props.cached = undefined
					this.para().old = { props, author: old.author, date: old.date }
				}
				return true
			}
			case "oldsprops": {
				const current = this.section
				const copy = current.clone()

				copy.old = undefined
				this.section = copy
				frame.onEnd = () => {
					const props = this.section

					props.old = undefined
					this.section = current
					current.old = { props, author: old.author, date: old.date }
				}
				return true
			}
			case "oldtprops": {
				const current = this.row
				const cell = this.cell
				const copy: RowDef = { ...current, old: undefined, cells: current.cells.slice() }

				this.row = copy
				this.cell = newCell()
				frame.onEnd = () => {
					const props = this.row

					props.old = undefined
					this.row = current
					this.cell = cell
					current.old = { props, author: old.author, date: old.date }
				}
				return true
			}
		}
	}

	// \\crauthN, \\crdateN and the paragraph, section and row ones: the author and date of the old properties around them.
	private revisionWord(name: string, param: number): boolean {
		const old = this.frame.old

		switch (name) {
			case "crauth":
			case "prauth":
			case "srauth":
			case "trauth":
				if (old !== undefined) old.author = param
				return true
			case "crdate":
			case "prdate":
			case "srdate":
			case "trdate":
				if (old !== undefined) old.date = param
				return true
			default:
				return false
		}
	}

	private push(): void {
		const parent = this.frame

		this.stack.push(parent)
		this.frame = {
			char: parent.char,
			charOwned: false,
			para: parent.para,
			paraOwned: false,
			uc: parent.uc,
			dest: parent.dest,
			onEnd: undefined,
			upr: false,
			ignorable: false,
			nestProps: parent.nestProps,
			start: this.tokens.start,
			box: parent.box,
			old: parent.old,
			opener: this.stack.length === 1
		}

		if (parent.dest.kind === "styles") {
			const style = this.doc.newStyle()
			const frame = this.frame

			frame.char = new CharProps()
			frame.charOwned = true
			frame.para = new ParaProps()
			frame.paraOwned = true
			frame.dest = { kind: "style", style }
			frame.onEnd = () => {
				style.char = this.frameAfterEnd.char
				style.para = this.frameAfterEnd.para
			}
		}
	}

	private pop(): void {
		const ended = this.frame
		const parent = this.stack.pop()

		if (parent === undefined) return

		this.frame = parent
		this.frameAfterEnd = ended
		ended.onEnd?.()

		// The destination holding a nested row's definitions ends: the row's source ends with it.
		if (ended.nestProps && !parent.nestProps) this.extendNested(this.tokens.start, this.tokens.end)
	}

	// The last nested cell or row takes in [.., end) when only space lies between it and `start`.
	private extendNested(start: number, end: number): boolean {
		const nested = this.nested

		if (nested === undefined || nested.story.mark !== nested.mark || !onlySpace(this.bytes, nested.mark, start)) return false
		if (!nested.story.extend(end)) return false

		nested.mark = end

		return true
	}

	private preserve(kind: RtfPreservedKind, name: string, start: number, end: number): void {
		this.groupFloor = Math.max(this.groupFloor, end)
		this.preserved.push({ kind, name, start, end })
	}

	private skipGroup(name: string, kind: RtfPreservedKind = PRESERVED_KIND.get(name) ?? "destination"): void {
		const start = this.frame.start

		this.tokens.skipGroup()
		this.popSkipped()

		// The copy of a picture for readers without \\shppict, right after it: part of the picture's source.
		const last = this.lastPicture

		if (name === "nonshppict" && last !== undefined && onlySpace(this.bytes, last.end, start)) {
			last.end = this.tokens.position

			return
		}

		// The text readers without nested tables show (RTF 1.9.1: readers with them ignore it), after a nested cell
		// or row: part of its source, written again with it.
		if (name === "nonesttables" && this.extendNested(start, this.tokens.position)) return

		this.preserve(kind, name, start, this.tokens.position)
	}

	// The group was consumed by skipGroup: its frame ends without running its end action.
	private popSkipped(): void {
		const parent = this.stack.pop()

		if (parent !== undefined) this.frame = parent

		this.depth--
	}

	// ---- character data

	private codepage(): number {
		const dest = this.frame.dest

		if (dest.kind === "fonts" && this.currentFont !== undefined) {
			const codepage = this.fontCodepage(this.currentFont)

			// A symbol font's name is text in the document's code page.
			return codepage === SYMBOL_CODEPAGE ? this.documentCodepage : codepage
		}

		const font = this.frame.char.font >= 0 ? this.frame.char.font : this.defaultFont
		const entry = this.fonts.get(font)

		return entry === undefined ? this.documentCodepage : this.fontCodepage(entry)
	}

	private fontCodepage(font: FontEntry): number {
		if (font.codepage > 0) return font.codepage

		const charset = font.charset < 0 ? undefined : charsetCodepage(font.charset)

		return charset === undefined || charset === 0 ? this.documentCodepage : charset
	}

	private byte(value: number): void {
		if (this.pendingLength === 0) this.pendingStart = this.tokens.start

		if (this.pendingLength === this.pending.length) {
			const grown = new Uint8Array(this.pending.length * 2)

			grown.set(this.pending)
			this.pending = grown
		}

		this.pending[this.pendingLength++] = value
	}

	private textBytes(start: number, end: number): void {
		const dest = this.frame.dest

		if (dest.kind === "pict") {
			dest.picture.hex(this.bytes, start, end)

			return
		}

		if (dest.kind === "ignore" || dest.kind === "shape") return

		for (let i = start; i < end; i++) this.byte(this.bytes[i] ?? 0)
	}

	private flush(): void {
		if (this.pendingLength === 0) return

		const codepage = this.codepage()

		if (!codepageSupported(codepage)) this.unsupported.add(codepage)

		const text = decodeCodepage(this.pending, 0, this.pendingLength, codepage)

		this.pendingLength = 0
		this.textAt = this.pendingStart
		this.characters(text)
		this.textAt = -1
	}

	// Decoded characters for the current destination.
	private characters(text: string): void {
		const dest = this.frame.dest

		switch (dest.kind) {
			case "story":
				this.storyText(dest.story, text, dest.mode)
				break
			case "capture":
				dest.text += text
				break
			case "math":
				dest.math.text(text, this.frame.char.xml(this.doc))
				break
			case "fonts": {
				const font = this.currentFont

				if (font === undefined || font.named) break

				const end = text.indexOf(";")

				font.name += end < 0 ? text : text.slice(0, end)
				if (end >= 0) font.named = true

				break
			}
			case "colors":
				for (let k = 0; k < text.length; k++) {
					if (text.charCodeAt(k) !== 0x3b) continue

					const [r, g, b] = this.color

					this.colors.push(r < 0 && g < 0 && b < 0 ? "auto" : hex(r) + hex(g) + hex(b))
					this.color = [-1, -1, -1]
				}
				break
			case "style":
				dest.style.name += text
				break
			case "revtbl":
				this.doc.revisionText += text
				break
			default:
				break
		}
	}

	private storyText(story: Story, text: string, mode: "text" | "instr"): void {
		if (story.start < 0) {
			this.touchGroups(story)

			if (story.start < 0) story.start = this.textAt >= 0 ? this.textAt : this.tokens.start
		}

		const field = this.fields.at(-1)

		if (field !== undefined && field.story === story) {
			if (mode === "instr") {
				if (!field.separated && field.instruction.length < 4096) field.instruction += text
			} else if (field.separated) field.result = true
		}

		const props = this.frame.char
		const rPr = props.xml(this.doc)
		const revision = this.revision(props)

		this.noteUnread(story, props)
		const kind: TextKind = props.deleted ? (mode === "instr" ? "delInstrText" : "delText") : mode === "instr" ? "instrText" : "t"
		let from = 0

		this.noteMark = false

		for (let k = 0; k < text.length; k++) {
			const code = text.charCodeAt(k)

			if (code >= 0x20 && code !== 0xfffe && code !== 0xffff) continue

			if (k > from) story.text(text.slice(from, k), rPr, kind, revision)
			if (code === 0x09) story.inline("<w:tab/>", rPr, kind, revision)

			from = k + 1
		}

		if (from < text.length) story.text(from === 0 ? text : text.slice(from), rPr, kind, revision)
	}

	// A paragraph's first content inside groups opened since the story's last block starts at the outermost one's
	// brace: the paragraph's source then holds them whole, and writing it leaves no emptied group behind. Groups
	// holding a table or what the reader kept in the source only (groupFloor) stay outside it.
	private touchGroups(story: Story): void {
		let frame = this.frame
		let at = -1

		const floor = Math.max(story.mark, this.groupFloor)

		// stack[0] is the state outside the document group, whose own frame is never a paragraph's.
		for (let k = this.stack.length - 1; k >= 1; k--) {
			const parent = this.stack[k]

			if (parent === undefined || frame.start < floor) break
			if (frame.dest.kind !== "story" || frame.dest.story !== story) break
			if (parent.dest.kind !== "story" || parent.dest.story !== story) break

			at = frame.start
			frame = parent
		}

		if (at >= 0) story.touch(at)
	}

	// Words in force on shown content that the translation cannot hold lock its paragraph (StoryContext.unread).
	private noteUnread(story: Story, props: CharProps): void {
		// An underline colour with no underline of its own (one a character style may give): w:u would add one.
		let names = props.underlineColor >= 0 && props.underline === undefined ? `${props.unread} ulc`.trim() : props.unread

		// A pattern word and a percentage at once: w:shd holds one of them.
		if (shadingConflict(props.shading)) names = `${names} chshdng`.trim()

		if (names !== "" && !story.unread.includes(names)) story.unread = story.unread === "" ? names : `${story.unread} ${names}`
	}

	private revision(props: CharProps): string {
		if (props.deleted) return this.doc.revisionMarkup("del", props.deleteAuthor, props.deleteDate)
		if (props.inserted) return this.doc.revisionMarkup("ins", props.insertAuthor, props.insertDate)

		return ""
	}

	private inline(xml: string): void {
		const dest = this.frame.dest

		if (dest.kind !== "story") return

		const field = this.fields.at(-1)

		if (field?.separated === true && dest.mode === "text") field.result = true

		if (dest.story.start < 0) {
			this.touchGroups(dest.story)

			if (dest.story.start < 0) dest.story.start = this.tokens.start
		}

		const props = this.frame.char

		this.noteUnread(dest.story, props)
		dest.story.inline(xml, props.xml(this.doc), props.deleted ? "delText" : "t", this.revision(props))
	}

	private story(): Story | undefined {
		const dest = this.frame.dest

		return dest.kind === "story" ? dest.story : undefined
	}

	// ---- properties (copy on write)

	private char(): CharProps {
		const frame = this.frame

		if (!frame.charOwned) {
			frame.char = frame.char.clone()
			frame.charOwned = true
		}

		frame.char.cached = undefined

		return frame.char
	}

	private para(): ParaProps {
		const frame = this.frame

		if (!frame.paraOwned) {
			frame.para = frame.para.clone()
			frame.paraOwned = true
		}

		frame.para.cached = undefined

		return frame.para
	}

	private symbol(code: number): void {
		switch (code) {
			case 0x2a:
				this.flush()
				this.frame.ignorable = true

				return
			case 0x5c:
			case 0x7b:
			case 0x7d:
				this.byte(code)

				return
			case 0x7e:
				this.flush()
				this.characters(String.fromCharCode(0x00a0))

				return
			case 0x2d:
				this.flush()
				this.characters(String.fromCharCode(0x00ad))

				return
			case 0x5f:
				this.flush()
				this.characters(String.fromCharCode(0x2011))

				return
			case 0x0a:
				this.flush()
				this.word("par", 0, false)

				return
			case 0x09:
				this.flush()
				this.word("tab", 0, false)

				return
			default:
				// \: (index subentry), \| (formula character) and others mean nothing to the document.
				this.flush()
		}
	}

	// ---- control words

	private word(name: string, param: number, hasParam: boolean): void {
		const frame = this.frame

		if (frame.dest.kind === "math") {
			this.mathWord(frame.dest.math, name, param, hasParam)

			return
		}

		if (name === "mmath" || name === "moMath" || name === "moMathPara") {
			frame.ignorable = false
			this.math(name)

			return
		}

		if (frame.ignorable) {
			frame.ignorable = false

			if (name === "formfield") {
				this.formField()
				this.skipGroup(name)

				return
			}

			if (!IGNORABLE_READ.has(name) && !SKIPPED.has(name) && !PRESERVED_KIND.has(name)) {
				if (DESTINATIONS.has(name) && this.destination(name)) return

				this.skipGroup(name)

				return
			}
		}

		if (SKIPPED.has(name) || PRESERVED_KIND.has(name)) {
			if (name === "formfield") this.formField()

			this.skipGroup(name)

			return
		}

		if (DESTINATIONS.has(name) && this.destination(name)) return

		const dest = frame.dest

		switch (dest.kind) {
			case "fonts":
				this.fontWord(name, param, hasParam)
				return
			case "colors":
				if (name === "red") this.color[0] = param
				else if (name === "green") this.color[1] = param
				else if (name === "blue") this.color[2] = param
				return
			case "pict":
				this.pictWord(dest.picture, name, param, hasParam)
				return
			case "shape":
				this.shapeWord(dest.shape, name, param)
				return
			case "datetime":
				this.dateWord(dest.date, name, param)
				return
			case "level":
				if (this.levelWord(dest.level, name, param, hasParam)) return
				break
			case "list":
				if (name === "listid") dest.list.id = param
				else if (name === "listtemplateid") dest.list.templateId = param
				return
			case "override":
				if (name === "listid") dest.override.listId = param
				else if (name === "ls") dest.override.ls = param
				return
			case "lfo":
				if (name === "listoverridestartat") this.lfoLevel(dest).restart = true
				else if (name === "levelstartat") this.lfoLevel(dest).start = param
				return
			case "style":
				if (this.styleWord(dest.style, name, param)) return
				break
			default:
				break
		}

		// Which handler takes a word depends on its name alone: found once per name, then called directly.
		const route = this.routes.get(name)

		switch (route) {
			case Route.Document:
				this.documentWord(name, param, hasParam)
				return
			case Route.Character:
				this.characterWord(name, param, hasParam)
				return
			case Route.Paragraph:
				this.paragraphWord(name, param, hasParam)
				return
			case Route.Table:
				this.tableWord(name, param, hasParam)
				return
			case Route.Section:
				this.sectionWord(name, param, hasParam)
				return
			case Route.Special:
				this.specialWord(name, param, hasParam)
				return
			default:
				break
		}

		let found: Route = Route.Special

		if (this.documentWord(name, param, hasParam)) found = Route.Document
		else if (this.characterWord(name, param, hasParam)) found = Route.Character
		else if (this.paragraphWord(name, param, hasParam)) found = Route.Paragraph
		else if (this.tableWord(name, param, hasParam)) found = Route.Table
		else if (this.sectionWord(name, param, hasParam)) found = Route.Section
		else this.specialWord(name, param, hasParam)

		this.routes.set(name, found)
	}

	// Destination words: they set what the rest of the group is. Returns whether `name` was one.
	private destination(name: string): boolean {
		const frame = this.frame
		const story = this.story()

		if (TABLE_DESTINATIONS.has(name)) this.tablesUntil = this.unplain

		switch (name) {
			case "fonttbl":
				frame.dest = { kind: "fonts" }
				this.tableGroup(name)
				return true
			case "colortbl":
				frame.dest = { kind: "colors" }
				this.tableGroup(name)
				return true
			case "stylesheet":
				frame.dest = { kind: "styles" }
				this.tableGroup(name)
				return true
			case "listtable":
				frame.dest = { kind: "lists" }
				this.tableGroup(name)
				return true
			case "listoverridetable":
				frame.dest = { kind: "overrides" }
				this.tableGroup(name)
				return true
			case "info":
				frame.dest = { kind: "info" }
				this.tableGroup(name)
				return true
			case "revtbl":
				frame.dest = { kind: "revtbl" }
				this.tableGroup(name)
				return true
			case "oldcprops":
			case "oldpprops":
			case "oldsprops":
			case "oldtprops":
				return this.oldProps(name)
			case "defchp":
			case "defpap": {
				frame.char = new CharProps()
				frame.charOwned = true
				frame.para = new ParaProps()
				frame.paraOwned = true
				frame.dest = { kind: "ignore" }
				frame.onEnd = () => {
					if (name === "defchp") this.doc.defaultChar = this.frameAfterEnd.char
					else this.doc.defaultPara = this.frameAfterEnd.para
				}
				return true
			}
			case "list":
				if (frame.dest.kind === "lists") {
					const list = this.doc.newList()

					frame.dest = { kind: "list", list }
					return true
				}
				return this.ignoreGroup()
			case "listlevel":
				if (frame.dest.kind === "list" || frame.dest.kind === "lfo") {
					const level = this.doc.newLevel()

					if (frame.dest.kind === "list") frame.dest.list.levels.push(level)
					else this.lfoLevel(frame.dest).level = level

					frame.char = new CharProps()
					frame.charOwned = true
					frame.para = new ParaProps()
					frame.paraOwned = true
					frame.dest = { kind: "level", level }
					frame.onEnd = () => {
						level.char = this.frameAfterEnd.char
						level.para = this.frameAfterEnd.para
					}
					return true
				}
				return this.ignoreGroup()
			case "leveltext":
			case "listname":
			case "liststylename": {
				const level = frame.dest.kind === "level" ? frame.dest.level : undefined
				const list = frame.dest.kind === "list" ? frame.dest.list : undefined

				frame.dest = {
					kind: "capture",
					text: "",
					done: text => {
						if (name === "leveltext" && level !== undefined) level.text = text
						else if (name === "listname" && list !== undefined) list.name = text.replace(/;$/u, "")
					}
				}
				this.onCaptureEnd()
				return true
			}
			case "listoverride":
				if (frame.dest.kind === "overrides") {
					frame.dest = { kind: "override", override: this.doc.newOverride() }
					return true
				}
				return this.ignoreGroup()
			case "lfolevel":
				if (frame.dest.kind === "override") {
					const override = frame.dest.override

					override.levels.push({ restart: false, start: -1, level: undefined })
					frame.dest = { kind: "lfo", override, index: override.levels.length - 1 }
					return true
				}
				return this.ignoreGroup()
			case "title":
			case "subject":
			case "author":
			case "manager":
			case "company":
			case "operator":
			case "category":
			case "keywords":
			case "comment":
			case "doccomm":
				if (frame.dest.kind === "info") {
					frame.dest = { kind: "capture", text: "", done: text => this.doc.info.set(name, text) }
					this.onCaptureEnd()
					return true
				}
				return this.ignoreGroup()
			case "creatim":
			case "revtim":
			case "printim":
			case "buptim":
				if (frame.dest.kind === "info") {
					frame.dest = { kind: "datetime", date: [0, 0, 0, 0, 0, 0], done: date => this.doc.info.set(name, isoDate(date)) }
					this.onDateEnd()
					return true
				}
				return this.ignoreGroup()
			case "pict": {
				const picture = new PictureBuilder()
				const target = this.frame.dest
				const start = this.frame.start

				if (target.kind !== "story" && target.kind !== "shape") return this.ignoreGroup()

				frame.dest = {
					kind: "pict",
					picture,
					done: built => {
						const result = built.finish()
						const end = this.tokens.position

						if (!("bytes" in result)) {
							this.preserve("picture", result.unsupported, start, end)

							return
						}

						if (target.kind === "shape") target.shape.picture = result
						else {
							const range = { start, end }

							target.story.touch(start)
							this.picture(target.story, result, range)
							this.lastPicture = range
						}
					}
				}
				frame.onEnd = () => {
					if (frame.dest.kind === "pict") frame.dest.done(frame.dest.picture)
				}
				return true
			}
			case "shp":
			case "shpgrp": {
				// A shape of a group: in the story the group is in.
				const parent = frame.dest.kind === "shape" && frame.dest.shape.group ? frame.dest.shape : undefined
				const host = story ?? parent?.story

				if (host === undefined) {
					this.skipGroup(name, name === "shpgrp" ? "shapeGroup" : "shape")
					this.undrawn++
					return true
				}

				const shape: ShapeState = {
					story: host,
					group: name === "shpgrp",
					parent,
					picture: undefined,
					name: "",
					left: 0,
					top: 0,
					right: 0,
					bottom: 0,
					relH: "column",
					relV: "paragraph",
					wrap: 3,
					wrapSide: 0,
					behind: false,
					relHProp: -1,
					relVProp: -1,
					ignoreX: false,
					ignoreY: false,
					textbox: false,
					wordArt: "",
					shapeType: -1,
					filled: undefined,
					fillColor: undefined,
					lined: undefined,
					lineColor: undefined,
					lineWidth: undefined,
					rotation: 0,
					flipH: false,
					flipV: false,
					insets: [91440, 45720, 91440, 45720],
					rel: undefined,
					space: [0, 0, 20000, 20000]
				}
				const start = this.frame.start

				frame.dest = { kind: "shape", shape }
				frame.onEnd = () => {
					const end = this.tokens.position

					// A group's shapes are in its source range.
					if (parent === undefined)
						this.preserve(shape.group ? "shapeGroup" : shape.textbox ? "textbox" : "shape", shape.name, start, end)
					// A group's shapes are counted one by one; one with no picture, text or WordArt is drawn by its
					// preset geometry, if it has one.
					if (!shape.group && shape.picture === undefined && !shape.textbox && shape.wordArt === "" && !this.geometryShape(shape))
						this.undrawn++
					if (shape.picture !== undefined) this.anchoredPicture(shape)
					if (shape.wordArt !== "" && !shape.textbox) this.wordArt(shape)
				}
				return true
			}
			case "shpinst":
				return true
			case "shprslt":
				if (frame.dest.kind === "shape") {
					this.skipGroup(name)
					return true
				}
				return false
			case "shptxt":
				if (frame.dest.kind !== "shape") {
					this.skipGroup(name, "textbox")
					this.undrawn++
					return true
				}

				return this.shapeText(frame.dest.shape)
			case "sp":
				if (frame.dest.kind === "shape" || frame.dest.kind === "picprop") return true
				return this.ignoreGroup()
			case "sn":
				if (frame.dest.kind === "picprop") {
					const dest = frame.dest

					frame.dest = { kind: "capture", text: "", done: text => (dest.name = text.trim()) }
					this.onCaptureEnd()
					return true
				}
				if (frame.dest.kind !== "shape") return this.ignoreGroup()
				{
					const shape = frame.dest.shape

					frame.dest = { kind: "capture", text: "", done: text => (shape.name = text.trim()) }
					this.onCaptureEnd()
				}
				return true
			case "sv": {
				if (frame.dest.kind === "picprop") {
					const dest = frame.dest

					frame.dest = {
						kind: "capture",
						text: "",
						done: text => {
							if (dest.name === "wzDescription") dest.picture.description = text
						}
					}
					this.onCaptureEnd()
					return true
				}
				if (frame.dest.kind !== "shape") return this.ignoreGroup()

				const shape = frame.dest.shape

				// A picture value (pib) stays in the shape: its \pict becomes the shape's picture.
				if (shape.name === "pib") return true

				frame.dest = { kind: "capture", text: "", done: text => this.shapeProperty(shape, shape.name, text.trim()) }
				this.onCaptureEnd()
				return true
			}
			case "picprop": {
				// A picture's shape properties (RTF 1.9.1, "Pictures"): its alternative text is read, the rest stays in
				// the source.
				if (frame.dest.kind !== "pict") return this.ignoreGroup()

				const picture = frame.dest.picture

				frame.dest = { kind: "picprop", picture, name: "" }
				return true
			}
			case "shppict": {
				// The picture's source is the whole wrapper (and a \\nonshppict copy right after it).
				const start = frame.start

				story?.touch(start)
				frame.onEnd = () => {
					const last = this.lastPicture

					if (last !== undefined && last.start >= start) {
						last.start = start
						last.end = this.tokens.position
					}
				}
				return true
			}
			case "object":
				this.objectResults.push(false)
				frame.onEnd = () => {
					if (this.objectResults.pop() === false) this.undrawn++
				}
				return true
			case "result":
				if (this.objectResults.length > 0) this.objectResults[this.objectResults.length - 1] = true
				return true
			case "field":
				return this.field(story)
			case "fldinst":
				return this.fieldInstructions()
			case "fldrslt":
				return this.fieldResult()
			case "bkmkstart":
			case "bkmkend":
				if (story === undefined) return this.ignoreGroup()

				story.touch(frame.start)

				frame.dest = {
					kind: "capture",
					text: "",
					done: text => story.markup(this.doc.bookmark(name === "bkmkstart", text.trim()))
				}
				this.onCaptureEnd()
				return true
			case "footnote":
				return this.note(story)
			case "header":
			case "headerl":
			case "headerr":
			case "headerf":
			case "footer":
			case "footerl":
			case "footerr":
			case "footerf":
				return this.headerFooter(name)
			case "atnid":
			case "atnauthor":
				frame.dest = {
					kind: "capture",
					text: "",
					done: text => {
						if (name === "atnid") this.annotationInitials = text.trim()
						else this.annotationAuthor = text.trim()
					}
				}
				this.onCaptureEnd()
				return true
			case "atrfstart":
			case "atrfend":
				if (story === undefined) return this.ignoreGroup()

				story.touch(frame.start)

				frame.dest = {
					kind: "capture",
					text: "",
					done: text => story.markup(`${MARK}${name === "atrfstart" ? "S" : "E"}${text.trim().replaceAll(MARK, "")}${MARK}`)
				}
				this.onCaptureEnd()
				return true
			case "annotation":
				return this.annotation(story)
			case "atnref":
			case "atndate": {
				const comment = this.doc.currentComment

				frame.dest = {
					kind: "capture",
					text: "",
					done: text => {
						if (comment === undefined) return
						if (name === "atnref") comment.tag = text.trim().replaceAll(MARK, "")
						else comment.date = dttm(Number(text.trim()))
					}
				}
				this.onCaptureEnd()
				return true
			}
			case "listtext":
			case "pntext": {
				if (story === undefined) return this.ignoreGroup()

				story.touch(frame.start)

				story.beginLabel()
				frame.onEnd = () => {
					this.flush()
					story.endLabel()
				}
				this.labelEnds.add(frame.onEnd)
				return true
			}
			case "pn":
				// Word 6/95 numbering: the \\pntext label in the text stands for it.
				return this.ignoreGroup()
			case "nesttableprops":
				frame.nestProps = true
				return true
			case "do":
				return this.drawingObject(story)
			case "dptxbxtext": {
				const box = this.frame.box

				if (box === undefined || frame.dest.kind !== "story") return this.ignoreGroup()

				frame.para = new ParaProps()
				frame.paraOwned = true
				return true
			}
			case "upr":
				frame.upr = true
				return true
			case "ud":
				return true
			default:
				break
		}

		return false
	}

	// The frame that just ended (set while an end action runs).
	private frameAfterEnd!: Frame

	private onCaptureEnd(): void {
		const frame = this.frame

		frame.onEnd = () => {
			if (frame.dest.kind === "capture") frame.dest.done(frame.dest.text)
		}
	}

	private onDateEnd(): void {
		const frame = this.frame

		frame.onEnd = () => {
			if (frame.dest.kind === "datetime") frame.dest.done(frame.dest.date)
		}
	}

	// A known destination where it means nothing (a \list outside \listtable): its text is not shown.
	private ignoreGroup(): boolean {
		this.frame.dest = { kind: "ignore" }

		return true
	}

	private lfoLevel(dest: { readonly override: ListOverrideDef; readonly index: number }): {
		restart: boolean
		start: number
		level: ListLevelDef | undefined
	} {
		const entry = dest.override.levels[dest.index]

		if (entry === undefined) throw new RangeError("No override level")

		return entry
	}

	// ---- fields, notes, comments, headers

	private field(story: Story | undefined): boolean {
		if (story === undefined) return this.ignoreGroup()

		story.touch(this.frame.start)

		const field: FieldState = {
			begin: -1,
			begun: false,
			separated: false,
			lock: false,
			dirty: false,
			story,
			instruction: "",
			result: false
		}

		this.fields.push(field)
		this.frame.dest = { kind: "ignore" }
		this.frame.onEnd = () => {
			this.fields.pop()

			if (!field.begun) return

			const symbol = field.result ? undefined : symbolField(field.instruction)

			if (symbol !== undefined) {
				if (!field.separated) this.inlineIn(story, '<w:fldChar w:fldCharType="separate"/>')

				this.inlineIn(story, symbol)
			}

			this.inlineIn(story, '<w:fldChar w:fldCharType="end"/>')
		}

		return true
	}

	private inlineIn(story: Story, xml: string): void {
		const props = this.frame.char

		if (story.start < 0) story.start = this.tokens.start

		this.noteUnread(story, props)
		story.inline(xml, props.xml(this.doc), props.deleted ? "delText" : "t", this.revision(props))
	}

	// A form field's properties (\\*\\formfield, RTF 1.9.1): its field's w:ffData (ECMA-376 Part 1 §17.16.17), read
	// ahead in the group (which stays in the source, as before).
	private formField(): void {
		const field = this.fields.at(-1)

		if (field === undefined || field.begin < 0) return

		const ahead = new RtfTokenizer(this.bytes, this.tokens.position)
		const words = new Map<string, number>()
		const texts = new Map<string, string>()
		const items: string[] = []
		// Text bytes in the field's code page, characters after \uN skipped as \ucN says (per group), as the body's are.
		const codepage = this.codepage()
		const ucs: number[] = [this.frame.uc]
		const pending: number[] = []
		let depth = 1
		// The text destination being read (\ffname...) and the depth its group opened at.
		let destination = ""
		let at = 0
		let text = ""
		let skip = 0
		const flush = (): void => {
			if (pending.length === 0) return

			text += decodeCodepage(Uint8Array.from(pending), 0, pending.length, codepage)
			pending.length = 0
		}
		const byte = (value: number): void => {
			if (skip > 0) skip--
			else pending.push(value)
		}

		while (depth > 0) {
			const kind = ahead.next()

			if (kind === Token.End) break
			if (kind === Token.GroupStart) {
				depth++
				ucs.push(ucs.at(-1) ?? 1)

				continue
			}

			if (kind === Token.GroupEnd) {
				if (destination !== "" && depth === at) {
					flush()

					if (destination === "ffl") items.push(text)
					else texts.set(destination, text)

					destination = ""
					text = ""
				}

				depth--
				ucs.pop()
				skip = 0

				continue
			}

			if (kind === Token.Word) {
				if (ahead.name === "uc") ucs[ucs.length - 1] = Math.max(0, Math.min(ahead.param, 64))
				else if (destination === "" && FORM_TEXTS.has(ahead.name)) {
					destination = ahead.name
					at = depth
				} else if (destination === "") words.set(ahead.name, ahead.param)
				else if (ahead.name === "u") {
					flush()
					text += String.fromCharCode(ahead.param < 0 ? ahead.param + 65_536 : ahead.param)
					skip = ucs.at(-1) ?? 1
				}

				continue
			}

			if (destination === "") continue

			if (kind === Token.Text) for (let k = ahead.textStart; k < ahead.textEnd; k++) byte(this.bytes[k] ?? 0)
			else if (kind === Token.Hex && ahead.value >= 0) byte(ahead.value)
		}

		this.doc.formField(field.begin, ffData(words, texts, items))
	}

	private fieldInstructions(): boolean {
		const field = this.fields.at(-1)

		if (field === undefined) return this.ignoreGroup()

		if (!field.begun) {
			field.begun = true
			field.begin = this.doc.fieldBegin(
				`<w:fldChar w:fldCharType="begin"${field.lock ? ' w:fldLock="1"' : ""}${field.dirty ? ' w:dirty="1"' : ""}`
			)
			this.inlineIn(field.story, `${MARK}F${String(field.begin)}${MARK}`)
		}

		this.frame.dest = { kind: "story", story: field.story, mode: "instr" }

		return true
	}

	private fieldResult(): boolean {
		const field = this.fields.at(-1)

		if (field === undefined) return false

		if (field.begun && !field.separated) {
			field.separated = true
			this.inlineIn(field.story, '<w:fldChar w:fldCharType="separate"/>')
		}

		this.frame.dest = { kind: "story", story: field.story, mode: "text" }

		return true
	}

	// Records the group of a table the writer may add entries to (the first one of each name).
	private tableGroup(name: RtfTableName): void {
		const start = this.frame.start

		this.groupFloor = Math.max(this.groupFloor, start + 1)

		if (this.tableGroups[name] !== undefined) return

		this.frame.onEnd = () => {
			this.tableGroups[name] ??= { start, end: this.tokens.position }
		}
	}

	private note(story: Story | undefined): boolean {
		if (story === undefined) return this.ignoreGroup()

		story.touch(this.frame.start)

		const custom = !this.noteMark
		const note = this.doc.newNote()

		this.noteMark = false
		this.inlineIn(story, `${MARK}N${note.index}${custom ? "c" : ""}${MARK}`)
		this.enterStory(note.story)

		const start = this.frame.start

		this.frame.onEnd = () => {
			this.flush()
			note.story.finish(this.paraXml(new ParaProps(), new CharProps(), undefined), this.tokens.start)
			note.group = { start, end: this.tokens.position }
		}

		return true
	}

	private annotation(story: Story | undefined): boolean {
		if (story === undefined) return this.ignoreGroup()

		story.touch(this.frame.start)

		const comment = this.doc.newComment(this.annotationAuthor, this.annotationInitials)

		this.annotationAuthor = ""
		this.annotationInitials = ""
		this.inlineIn(story, `${MARK}C${comment.index}${MARK}`)
		this.enterStory(comment.story)

		const start = this.frame.start

		this.frame.onEnd = () => {
			this.flush()
			comment.story.finish(this.paraXml(new ParaProps(), new CharProps(), undefined), this.tokens.start)
			comment.group = { start, end: this.tokens.position }
			this.doc.currentComment = undefined
		}

		return true
	}

	private headerFooter(name: string): boolean {
		const footer = name.startsWith("footer")
		const suffix = name.slice(footer ? 6 : 6)
		const type = suffix === "f" ? "first" : suffix === "l" ? "even" : "default"
		const story = this.doc.newHeaderFooter(footer)

		this.doc.sectionHeaders(footer).set(type, story.index)
		this.enterStory(story.story)

		const start = this.frame.start

		this.frame.onEnd = () => {
			this.flush()
			story.story.finish(this.paraXml(new ParaProps(), new CharProps(), undefined), this.tokens.start)
			story.group = { start, end: this.tokens.position }
		}

		return true
	}

	// A separate story starts with fresh paragraph properties (a writer may omit \pard).
	private enterStory(story: Story): void {
		const frame = this.frame

		frame.dest = { kind: "story", story, mode: "text" }
		frame.para = new ParaProps()
		frame.paraOwned = true
		story.mark = this.tokens.position
	}

	// A Word 6/95 drawing object (\\do): only a text box (\\dptxbx) shows anything, its paragraphs positioned as
	// the box by its offset and size (read ahead: they follow the text). Everything else stays in the source.
	private drawingObject(story: Story | undefined): boolean {
		const frame = this.frame
		const start = frame.start

		if (story === undefined) {
			this.skipGroup("do", "drawingObject")
			return true
		}

		const ahead = new RtfTokenizer(this.bytes, this.tokens.position)
		const box = newFrame()
		let depth = 1
		let textbox = false

		box.wrap = "around"

		while (depth > 0) {
			const kind = ahead.next()

			if (kind === Token.End) break
			if (kind === Token.GroupStart) depth++
			else if (kind === Token.GroupEnd) depth--
			else if (kind === Token.Word && depth === 1) {
				const value = ahead.param

				switch (ahead.name) {
					case "dobxpage":
						box.hAnchor = "page"
						break
					case "dobxmargin":
						box.hAnchor = "margin"
						break
					case "dobxcolumn":
						box.hAnchor = "text"
						break
					case "dobypage":
						box.vAnchor = "page"
						break
					case "dobymargin":
						box.vAnchor = "margin"
						break
					case "dobypara":
						box.vAnchor = "text"
						break
					case "dpx":
						box.x = value
						break
					case "dpy":
						box.y = value
						break
					case "dpxsize":
						box.width = Math.max(0, value)
						break
					case "dpysize":
						box.height = Math.max(0, value)
						break
					case "dptxbx":
						textbox = true
						break
					default:
						break
				}
			}
		}

		if (!textbox) {
			this.skipGroup("do", "drawingObject")
			return true
		}

		const content = new Story(this.doc)
		const depthInTable = frame.para.depth()

		frame.box = box
		frame.dest = { kind: "story", story: content, mode: "text" }
		frame.onEnd = () => {
			this.flush()
			content.finish(this.paraXml(new ParaProps(), new CharProps(), undefined), this.tokens.start)

			for (const block of content.blocks) story.insert(block, depthInTable)

			appendAll(story.relationships, content.relationships)

			this.preserve("drawingObject", "do", start, this.tokens.position)
		}

		return true
	}

	// WordArt: its text as a paragraph positioned as the shape (as a text box's are), centred; the shape stays in
	// the source.
	private wordArt(shape: ShapeState): void {
		const para = new ParaProps()

		para.frame = this.shapeFrame(shape)
		para.jc = "center"

		const content = new Story(this.doc)

		content.text(shape.wordArt, "", "t", "")
		// Ends in the shape's own range (its closing brace), as a text box's paragraphs do: the proof reads it with
		// the shape.
		content.paragraph(
			para.xml(this.doc, list => this.doc.numId(list)),
			0,
			false,
			this.tokens.start
		)

		for (const block of content.blocks) shape.story.insert(block, this.frame.para.depth())
	}

	// The paragraph frame (w:framePr) a shape's text is positioned in: where the shape is, its size.
	private shapeFrame(shape: ShapeState): Positioned {
		const place = shapePlace(shape)
		const box = newFrame()

		box.hAnchor = place.relH === "page" ? "page" : place.relH === "margin" ? "margin" : "text"
		box.vAnchor = place.relV === "page" ? "page" : place.relV === "margin" ? "margin" : "text"
		box.x = place.left
		box.y = place.top
		box.width = Math.max(0, place.right - place.left)
		box.height = Math.max(0, place.bottom - place.top)
		box.wrap = shape.wrap === 1 ? "notBeside" : shape.wrap === 3 ? "none" : "around"

		return box
	}

	// A text box's text (\\shptxt): its paragraphs positioned as the shape (w:framePr: where it is and its size, as
	// the Word 6/95 \\do text boxes are), before the paragraph it is anchored in. The box's line, fill and shape
	// stay in the source (reported as the text box kept so).
	private shapeText(shape: ShapeState): boolean {
		const frame = this.frame
		const box = this.shapeFrame(shape)

		shape.textbox = true

		const content = new Story(this.doc)
		const depthInTable = frame.para.depth()

		frame.box = box
		frame.dest = { kind: "story", story: content, mode: "text" }
		frame.para = new ParaProps()
		frame.paraOwned = true
		frame.onEnd = () => {
			this.flush()
			content.finish(this.paraXml(new ParaProps(), new CharProps(), undefined), this.tokens.start)

			for (const block of content.blocks) shape.story.insert(block, depthInTable)

			// Pictures in the box are related from the part the box's paragraphs are written to.
			appendAll(shape.story.relationships, content.relationships)
		}

		return true
	}

	// ---- equations

	// An equation (\\mmath, or \\moMath / \\moMathPara alone): Office Math between the paragraph's runs. Its group stays
	// in the source (reported as math), written again as it was.
	private math(name: string): void {
		const frame = this.frame
		const dest = frame.dest

		// Where no text shows (a field's instruction, an ignored group), or not opening its own group (the rest of an
		// enclosing one would be read as the equation): skipped.
		if (dest.kind !== "story" || dest.mode !== "text" || !this.firstInGroup(frame) || frame.onEnd !== undefined) {
			this.skipGroup(name, "math")

			return
		}

		const story = dest.story
		const start = frame.start
		const math = new OmmlBuilder()

		story.touch(start)
		frame.dest = { kind: "math", math }
		if (name !== "mmath") math.begin(name.slice(1), frame, undefined)
		frame.onEnd = () => {
			math.end(frame)

			const xml = math.result()

			this.preserve("math", name, start, this.tokens.position)
			if (xml !== "") story.math(xml)
		}
	}

	// A word in an equation: an element's (\\mf, \\mr...) opens its group, a property's inside another element is
	// an empty element with its value; character words give runs their properties. Other groups are skipped (an
	// \\mmathPict fallback picture among them).
	private mathWord(math: OmmlBuilder, name: string, param: number, hasParam: boolean): void {
		const frame = this.frame
		const ignorable = frame.ignorable
		const element = name.length > 1 && name.charCodeAt(0) === 0x6d ? name.slice(1) : ""
		const first = this.firstInGroup(frame)

		frame.ignorable = false

		if (element !== "" && OmmlBuilder.known(element)) {
			if (!first) {
				math.property(element, param, hasParam)

				return
			}

			math.begin(element, frame, hasParam ? param : undefined)
			frame.onEnd = () => math.end(frame)

			return
		}

		if (ignorable || (first && (element !== "" || DESTINATIONS.has(name) || SKIPPED.has(name)))) {
			this.tokens.skipGroup()
			this.popSkipped()

			return
		}

		this.characterWord(name, param, hasParam)
	}

	// Whether the word just read is the first in its group (after \\* and spaces).
	private firstInGroup(frame: Frame): boolean {
		const bytes = this.bytes
		const end = this.tokens.start

		for (let at = frame.start + 1; at < end; at++) {
			const byte = bytes[at]

			if (byte === 0x20 || byte === 0x0d || byte === 0x0a || byte === 0x09) continue
			if (byte === 0x5c && bytes[at + 1] === 0x2a) {
				at++

				continue
			}

			return false
		}

		return true
	}

	// ---- pictures and shapes

	// `source`: the picture's group.
	private picture(story: Story, picture: Picture, source: { readonly start: number; readonly end: number }): void {
		const id = this.doc.media(story, picture, source)
		const docPr = this.doc.nextDrawingId()
		const extent = `<wp:extent cx="${picture.cx}" cy="${picture.cy}"/>`

		this.inlineIn(
			story,
			`<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">${extent}<wp:docPr id="${docPr}" name="Picture ${docPr}"${picture.description === "" ? "" : ` descr="${escapeAttribute(picture.description)}"`}/>${graphic(id, picture, docPr)}</wp:inline></w:drawing>`
		)
	}

	private anchoredPicture(shape: ShapeState): void {
		const picture = shape.picture

		if (picture === undefined) return

		const id = this.doc.media(shape.story, picture)

		this.anchored(shape, "Picture", "", (cx, cy, docPr) => graphic(id, { ...picture, cx, cy }, docPr))
	}

	// A shape with no picture, text or WordArt drawn as its preset geometry (MSOSPT, MS-ODRAW §2.4.24) with its fill
	// and line, as Word draws it. Returns whether it has one.
	private geometryShape(shape: ShapeState): boolean {
		const preset = shape.shapeType < 0 ? undefined : presetOf(shape.shapeType)

		if (preset === undefined) return false

		// Lines and connectors have no inside to fill; fFilled and fLine default to on, white and black.
		const line = shape.shapeType === 20 || isConnector(shape.shapeType)
		const look: ShapeLook = {
			geometry: presetGeometry(preset),
			fill: shape.filled !== false && !line ? (artColor(shape.fillColor) ?? 0xffffff) : undefined,
			line: shape.lined !== false ? (artColor(shape.lineColor) ?? 0) : undefined,
			lineWidth: shape.lineWidth ?? 9525,
			textBox: false,
			insets: shape.insets
		}
		const degrees = shape.rotation / 65536
		const transform = {
			rotation: Math.round((((degrees % 360) + 360) % 360) * 60000),
			flipH: shape.flipH,
			flipV: shape.flipV
		}

		this.anchored(shape, "Shape", SHAPE_NAMESPACES, (cx, cy) => shapeGraphic(cx, cy, look, undefined, transform))

		return true
	}

	// A drawing anchored where the shape is (wp:anchor, ECMA-376 Part 1 §20.4.2.3): `content` its a:graphic at its size
	// in EMUs, `namespaces` what that markup declares.
	private anchored(
		shape: ShapeState,
		kind: string,
		namespaces: string,
		content: (cx: number, cy: number, docPr: number) => string
	): void {
		const place = shapePlace(shape)
		const story = shape.story
		const docPr = this.doc.nextDrawingId()
		const width = Math.max(1, place.right - place.left)
		const height = Math.max(1, place.bottom - place.top)
		const cx = Math.round(width * 635)
		const cy = Math.round(height * 635)
		const relH =
			shape.ignoreX && shape.relHProp >= 0
				? (["margin", "page", "column", "character", "leftMargin", "rightMargin", "insideMargin", "outsideMargin"][
						shape.relHProp
					] ?? "column")
				: place.relH
		const relV =
			shape.ignoreY && shape.relVProp >= 0
				? (["margin", "page", "paragraph", "line", "topMargin", "bottomMargin", "insideMargin", "outsideMargin"][shape.relVProp] ??
					"paragraph")
				: place.relV
		const side = ["bothSides", "left", "right", "largest"][shape.wrapSide] ?? "bothSides"
		const wrap =
			shape.wrap === 1
				? "<wp:wrapTopAndBottom/>"
				: shape.wrap === 2
					? `<wp:wrapSquare wrapText="${side}"/>`
					: shape.wrap === 4
						? `<wp:wrapTight wrapText="${side}"><wp:wrapPolygon edited="0"><wp:start x="0" y="0"/><wp:lineTo x="0" y="21600"/><wp:lineTo x="21600" y="21600"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="0"/></wp:wrapPolygon></wp:wrapTight>`
						: shape.wrap === 5
							? `<wp:wrapThrough wrapText="${side}"><wp:wrapPolygon edited="0"><wp:start x="0" y="0"/><wp:lineTo x="0" y="21600"/><wp:lineTo x="21600" y="21600"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="0"/></wp:wrapPolygon></wp:wrapThrough>`
							: "<wp:wrapNone/>"

		this.inlineIn(
			story,
			`<w:drawing><wp:anchor${namespaces} distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="${docPr}" behindDoc="${shape.behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="${relH}"><wp:posOffset>${Math.round(place.left * 635)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="${relV}"><wp:posOffset>${Math.round(place.top * 635)}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${wrap}<wp:docPr id="${docPr}" name="${kind} ${docPr}"/>${content(cx, cy, docPr)}</wp:anchor></w:drawing>`
		)
	}

	private shapeWord(shape: ShapeState, name: string, param: number): void {
		switch (name) {
			case "shpleft":
				shape.left = param
				break
			case "shptop":
				shape.top = param
				break
			case "shpright":
				shape.right = param
				break
			case "shpbottom":
				shape.bottom = param
				break
			case "shpbxpage":
				shape.relH = "page"
				break
			case "shpbxmargin":
				shape.relH = "margin"
				break
			case "shpbxcolumn":
				shape.relH = "column"
				break
			case "shpbxignore":
				shape.ignoreX = true
				break
			case "shpbypage":
				shape.relV = "page"
				break
			case "shpbymargin":
				shape.relV = "margin"
				break
			case "shpbypara":
				shape.relV = "paragraph"
				break
			case "shpbyignore":
				shape.ignoreY = true
				break
			case "shpwr":
				shape.wrap = param
				break
			case "shpwrk":
				shape.wrapSide = param
				break
			case "shpfblwtxt":
				shape.behind = param === 1
				break
			default:
				break
		}
	}

	private shapeProperty(shape: ShapeState, name: string, value: string): void {
		switch (name) {
			case "posrelh":
				shape.relHProp = Number(value)
				break
			case "posrelv":
				shape.relVProp = Number(value)
				break
			case "fBehindDocument":
				shape.behind = value === "1"
				break
			case "gtextUNICODE":
				shape.wordArt = value
				break
			default: {
				// The rest are integers (booleans 0 / 1, colours OfficeArtCOLORREF, lengths EMUs).
				const number = Number.parseInt(value, 10)

				if (!Number.isFinite(number)) return

				shapeNumber(shape, name, number)
			}
		}
	}

	private pictWord(picture: PictureBuilder, name: string, param: number, hasParam: boolean): void {
		switch (name) {
			case "pngblip":
				picture.source = "png"
				break
			case "jpegblip":
				picture.source = "jpeg"
				break
			case "emfblip":
				picture.source = "emf"
				break
			case "wmetafile":
				picture.source = "wmf"
				picture.mapMode = hasParam ? param : 1
				break
			case "dibitmap":
				picture.source = "dib"
				break
			case "wbitmap":
				picture.source = "ddb"
				break
			case "macpict":
				picture.source = "macpict"
				break
			case "pmmetafile":
				picture.source = "pmmetafile"
				break
			case "picw":
				picture.picw = param
				break
			case "pich":
				picture.pich = param
				break
			case "picwgoal":
				picture.goalW = param
				break
			case "pichgoal":
				picture.goalH = param
				break
			case "picscalex":
				picture.scaleX = param
				break
			case "picscaley":
				picture.scaleY = param
				break
			case "piccropt":
				picture.cropT = param
				break
			case "piccropb":
				picture.cropB = param
				break
			case "piccropl":
				picture.cropL = param
				break
			case "piccropr":
				picture.cropR = param
				break
			default:
				break
		}
	}

	private dateWord(date: number[], name: string, param: number): void {
		const index = ["yr", "mo", "dy", "hr", "min", "sec"].indexOf(name)

		if (index >= 0) date[index] = param
	}

	// ---- tables of the header

	private fontWord(name: string, param: number, hasParam: boolean): void {
		if (name === "f" && hasParam) {
			let font = this.fonts.get(param)

			if (font === undefined) {
				font = { index: param, name: "", named: false, charset: -1, codepage: 0, family: "auto", pitch: 0 }
				this.fonts.set(param, font)
			}

			this.currentFont = font

			return
		}

		const font = this.currentFont

		if (font === undefined) return

		switch (name) {
			case "fcharset":
				font.charset = param
				break
			case "cpg":
				font.codepage = param
				break
			case "fprq":
				font.pitch = param
				break
			case "fnil":
				font.family = "auto"
				break
			case "froman":
				font.family = "roman"
				break
			case "fswiss":
				font.family = "swiss"
				break
			case "fmodern":
				font.family = "modern"
				break
			case "fscript":
				font.family = "script"
				break
			case "fdecor":
				font.family = "decorative"
				break
			default:
				break
		}
	}

	private styleWord(style: StyleDef, name: string, param: number): boolean {
		switch (name) {
			case "s":
				if (style.type === "paragraph") style.number = param
				// \sN also appears inside character style definitions as the linked paragraph style.
				return true
			case "cs":
				style.type = "character"
				style.number = param
				return true
			case "ts":
				style.type = "table"
				style.number = param
				return true
			case "ds":
				style.type = "section"
				style.number = param
				return true
			case "sbasedon":
				style.basedOn = param
				return true
			case "snext":
				style.next = param
				return true
			case "slink":
				style.link = param
				return true
			case "additive":
			case "sautoupd":
			case "shidden":
			case "sqformat":
			case "spriority":
			case "ssemihidden":
			case "sunhideused":
			case "slocked":
			case "spersonal":
			case "scompose":
			case "sreply":
				return true
			default:
				return false
		}
	}

	private levelWord(level: ListLevelDef, name: string, param: number, hasParam: boolean): boolean {
		switch (name) {
			case "levelnfc":
				if (!level.nfcN) level.nfc = param
				return true
			case "levelnfcn":
				level.nfc = param
				level.nfcN = true
				return true
			case "leveljc":
				if (!level.jcN) level.jc = param
				return true
			case "leveljcn":
				level.jc = param
				level.jcN = true
				return true
			case "levelfollow":
				level.follow = param
				return true
			case "levelstartat":
				level.start = param
				return true
			case "levellegal":
				level.legal = !hasParam || param !== 0
				return true
			case "levelnorestart":
				level.noRestart = !hasParam || param !== 0
				return true
			case "levelold":
			case "levelprev":
			case "levelprevspace":
			case "levelspace":
			case "levelindent":
			case "leveltemplateid":
			case "levelpicture":
			case "levelpicturenosize":
				return true
			default:
				return false
		}
	}

	// ---- document, character, paragraph, table and section words

	private documentWord(name: string, param: number, hasParam: boolean): boolean {
		switch (name) {
			case "ansi":
				this.documentCodepage = 1252
				return true
			case "mac":
				this.documentCodepage = 10000
				return true
			case "pc":
				this.documentCodepage = 437
				return true
			case "pca":
				this.documentCodepage = 850
				return true
			case "ansicpg":
				if (hasParam && param > 0) this.documentCodepage = param
				return true
			case "deff":
				this.defaultFont = param
				return true
			case "deftab":
				this.doc.defaultTab = param
				return true
			case "facingp":
				this.doc.evenAndOdd = true
				return true
			case "margmirror":
				this.doc.mirrorMargins = true
				return true
			case "htmautsp":
				this.doc.htmlAutoSpacing = true
				return true
			case "crauth":
			case "prauth":
			case "srauth":
			case "trauth":
			case "crdate":
			case "prdate":
			case "srdate":
			case "trdate":
				return this.revisionWord(name, param)
			case "revisions":
				this.doc.trackRevisions = true
				this.revisionWords.push({ start: this.tokens.start, end: this.tokens.end })
				return true
			case "widowctrl":
				this.widowControl = true
				return true
			case "paperw":
				this.sectionDefaults.width = param
				this.section.width = param
				return true
			case "paperh":
				this.sectionDefaults.height = param
				this.section.height = param
				return true
			case "margl":
				this.sectionDefaults.left = param
				this.section.left = param
				return true
			case "margr":
				this.sectionDefaults.right = param
				this.section.right = param
				return true
			case "margt":
				this.sectionDefaults.top = param
				this.section.top = param
				return true
			case "margb":
				this.sectionDefaults.bottom = param
				this.section.bottom = param
				return true
			case "gutter":
				this.sectionDefaults.gutter = param
				this.section.gutter = param
				return true
			case "landscape":
				this.sectionDefaults.landscape = true
				this.section.landscape = true
				return true
			case "rtf":
				return true
			default:
				return this.noteWord(name, param)
		}
	}

	// Footnote (\\ftn...) and endnote (\\aftn...) numbering and placement for the whole document.
	private noteWord(name: string, param: number): boolean {
		const endnote = name.startsWith("aftn")
		const word = endnote ? name.slice(1) : name

		if (!word.startsWith("ftn")) {
			if (name === "aenddoc" || name === "aendnotes") {
				this.doc.notePr.endnote.position = name === "aenddoc" ? "docEnd" : "sectEnd"
				return true
			}

			return false
		}

		const pr = endnote ? this.doc.notePr.endnote : this.doc.notePr.footnote
		const format = NOTE_FORMATS.get(word)

		if (format !== undefined) pr.format = format
		else if (word === "ftnstart") pr.start = param
		else if (word === "ftnrstpg") pr.restart = "eachPage"
		else if (word === "ftnrestart") pr.restart = "eachSect"
		else if (word === "ftnrstcont") pr.restart = "continuous"
		else if (word === "ftnbj") pr.position = endnote ? pr.position : "pageBottom"
		else if (word === "ftntj") pr.position = endnote ? pr.position : "beneathText"
		else return false

		return true
	}

	private characterWord(name: string, param: number, hasParam: boolean): boolean {
		const field = CHAR_TOGGLES.get(name)

		if (field !== undefined) {
			const value: Toggle = !hasParam || param !== 0 ? 1 : 0

			;(this.char() as unknown as Record<string, Toggle>)[field] = value
			return true
		}

		const emphasis = EMPHASIS.get(name)

		if (emphasis !== undefined) {
			this.char().emphasis = emphasis
			return true
		}

		const underline = UNDERLINES.get(name)

		if (underline !== undefined) {
			this.char().underline = (name === "ul" || name === "uld" || name === "uldb") && hasParam && param === 0 ? "none" : underline
			return true
		}

		switch (name) {
			case "plain": {
				const fresh = new CharProps()
				const frame = this.frame

				frame.char = fresh
				frame.charOwned = true
				return true
			}
			case "f":
				this.char().font = param
				return true
			case "af": {
				const char = this.char()

				if (char.slot === "ascii") char.font = param
				else if (char.slot === "hAnsi") char.hAnsiFont = param
				else if (char.slot === "eastAsia") char.eastAsiaFont = param
				else char.csFont = param
				return true
			}
			case "loch":
				this.char().slot = "ascii"
				return true
			case "hich":
				this.char().slot = "hAnsi"
				return true
			case "dbch":
				this.char().slot = "eastAsia"
				return true
			case "rtlch":
				this.char().slot = "cs"
				return true
			case "ltrch":
				this.char().slot = "cs"
				return true
			case "fs":
				this.char().size = hasParam ? param : 24
				return true
			case "afs":
				this.char().csSize = hasParam ? param : 24
				return true
			case "cf":
				this.char().color = param
				return true
			case "cb":
				this.char().background = param
				return true
			case "highlight":
				this.char().highlight = param
				return true
			case "ulc":
				this.char().underlineColor = param
				return true
			// \\langnpN and \\langfenpN repeat \\langN and \\langfeN (Word writes both pairs; the writer does too).
			case "lang":
			case "langnp":
			case "langfe":
			case "langfenp":
			case "alang": {
				const char = this.char()

				if (!hasParam || param < 0 || param > 0xffff) unread(char, name)
				else if (name === "alang") char.langBidi = param
				else if (name.startsWith("langfe")) char.langEastAsia = param
				else char.lang = param
				return true
			}
			case "animtext": {
				const effect = EFFECTS[param]

				if (effect === undefined) unread(this.char(), name)
				else this.char().effect = effect
				return true
			}
			case "fittext":
				// A width per group, its runs one fitted span: not held run by run.
				unread(this.char(), name)
				return true
			case "chcbpat":
				this.charShading().fill = param
				return true
			case "chcfpat":
				this.charShading().pattern = param
				return true
			case "chshdng":
				this.charShading().percent = param
				return true
			case "chbghoriz":
			case "chbgvert":
			case "chbgfdiag":
			case "chbgbdiag":
			case "chbgcross":
			case "chbgdcross":
			case "chbgdkhoriz":
			case "chbgdkvert":
			case "chbgdkfdiag":
			case "chbgdkbdiag":
			case "chbgdkcross":
			case "chbgdkdcross":
				this.charShading().texture = shadingTexture(name, "chbg")
				return true
			case "super":
				this.char().vertAlign = "superscript"
				return true
			case "sub":
				this.char().vertAlign = "subscript"
				return true
			case "nosupersub":
				this.char().vertAlign = "baseline"
				return true
			case "up":
				this.char().position = hasParam ? param : 6
				return true
			case "dn":
				this.char().position = -(hasParam ? param : 6)
				return true
			case "expnd":
				this.char().spacing = param * 5
				return true
			case "expndtw":
				this.char().spacing = param
				return true
			case "kerning":
				this.char().kern = param
				return true
			case "charscalex":
				this.char().scale = param
				return true
			case "cs":
				this.char().style = param
				return true
			case "chbrdr": {
				const border = newBorder()

				this.char().border = border
				this.border = border
				this.borderOwner = "char"
				return true
			}
			case "revised":
				this.char().inserted = !hasParam || param !== 0
				return true
			case "deleted":
				this.char().deleted = !hasParam || param !== 0
				return true
			case "revauth":
				this.char().insertAuthor = param
				return true
			case "revauthdel":
				this.char().deleteAuthor = param
				return true
			case "revdttm":
				this.char().insertDate = param
				return true
			case "revdttmdel":
				this.char().deleteDate = param
				return true
			case "uc":
				this.frame.uc = Math.max(0, Math.min(param, 64))
				return true
			case "u": {
				let code = param < 0 ? param + 65536 : param

				if (code < 0 || code > 0x10ffff) code = 0xfffd

				this.characters(String.fromCodePoint(code))
				this.skip = this.frame.uc
				return true
			}
			default:
				return false
		}
	}

	private charShading(): Shading {
		const char = this.char()

		char.shading ??= newShading()

		return char.shading
	}

	private positioned(): Positioned {
		const para = this.para()

		if (para.frame === undefined) {
			para.frame = newFrame()
			para.frame.wrap = para.pendingWrap
		}

		return para.frame
	}

	private paraShading(): Shading {
		const para = this.para()

		para.shading ??= newShading()

		return para.shading
	}

	private paragraphWord(name: string, param: number, hasParam: boolean): boolean {
		const alignment = ALIGNMENTS.get(name)

		if (alignment !== undefined) {
			this.para().jc = alignment
			return true
		}

		const textAlignment = TEXT_ALIGNMENTS.get(name)

		if (textAlignment !== undefined) {
			this.para().textAlignment = textAlignment
			return true
		}

		if (UNREAD_PARAGRAPH.has(name)) {
			unread(this.para(), name)
			return true
		}

		const tabKind = TAB_KINDS.get(name)

		if (tabKind !== undefined) {
			this.para().tabKind = tabKind
			return true
		}

		const leader = TAB_LEADERS.get(name)

		if (leader !== undefined) {
			this.para().tabLeader = leader
			return true
		}

		const borderStyle = BORDER_STYLES.get(name)

		if (borderStyle !== undefined) {
			if (this.border !== undefined) {
				this.touchBorder()
				this.border.style = borderStyle
			}
			return true
		}

		switch (name) {
			case "pard": {
				const frame = this.frame

				frame.para = new ParaProps()
				frame.paraOwned = true
				return true
			}
			case "s":
				this.para().style = param
				return true
			case "li":
			case "lin":
				this.para().left = param
				return true
			case "ri":
			case "rin":
				this.para().right = param
				return true
			case "fi":
				this.para().firstLine = param
				return true
			case "sb":
				this.para().before = param
				return true
			case "sa":
				this.para().after = param
				return true
			case "sbauto":
				this.para().beforeAuto = param === 0 ? 0 : 1
				return true
			case "saauto":
				this.para().afterAuto = param === 0 ? 0 : 1
				return true
			case "sl":
				this.para().line = hasParam ? param : 0
				return true
			case "slmult":
				this.para().lineMultiple = param === 1
				return true
			case "keep":
				this.para().keepLines = 1
				return true
			case "keepn":
				this.para().keepNext = 1
				return true
			case "pagebb":
				this.para().pageBreakBefore = 1
				return true
			case "widctlpar":
				this.para().widowControl = 1
				return true
			case "nowidctlpar":
				this.para().widowControl = 0
				return true
			case "contextualspace":
				this.para().contextualSpacing = 1
				return true
			case "nooverflow":
				this.para().overflowPunct = hasParam && param === 0 ? 1 : 0
				return true
			case "aspalpha":
				this.para().autoSpaceDE = hasParam && param === 0 ? 0 : 1
				return true
			case "aspnum":
				this.para().autoSpaceDN = hasParam && param === 0 ? 0 : 1
				return true
			case "adjustright":
				this.para().adjustRightInd = hasParam && param === 0 ? 0 : 1
				return true
			case "qk": {
				const kashida = KASHIDA.get(hasParam ? param : 0)

				if (kashida === undefined) unread(this.para(), name)
				else this.para().jc = kashida
				return true
			}
			case "hyphpar":
				this.para().suppressAutoHyphens = hasParam && param === 0 ? 1 : 0
				return true
			case "noline":
				this.para().suppressLineNumbers = 1
				return true
			case "nosnaplinegrid":
				this.para().snapToGrid = 0
				return true
			case "rtlpar":
				this.para().bidi = 1
				return true
			case "ltrpar":
				this.para().bidi = 0
				return true
			case "intbl":
				this.para().inTable = true
				return true
			case "itap":
				this.para().nesting = param
				return true
			case "ls":
				this.para().list = param
				return true
			case "ilvl":
				this.para().level = param
				return true
			case "outlinelevel":
				this.para().outline = param
				return true
			case "tx":
			case "tb": {
				const para = this.para()

				para.tabs.push({ position: param, kind: name === "tb" ? "bar" : para.tabKind, leader: para.tabLeader })
				para.tabKind = "left"
				para.tabLeader = undefined
				return true
			}
			case "brdrt":
			case "brdrb":
			case "brdrl":
			case "brdrr":
			case "brdrbtw":
			case "brdrbar": {
				const side = (
					{ brdrt: "top", brdrb: "bottom", brdrl: "left", brdrr: "right", brdrbtw: "between", brdrbar: "bar" } as const
				)[name]
				const border = newBorder()

				this.para().borders[side] = border
				this.border = border
				this.borderOwner = "para"
				return true
			}
			case "box": {
				const border = newBorder()
				const para = this.para()

				para.borders.top = border
				para.borders.left = border
				para.borders.bottom = border
				para.borders.right = border
				this.border = border
				this.borderOwner = "para"
				return true
			}
			case "brdrw":
				if (this.border !== undefined) {
					this.touchBorder()
					this.border.width = param
				}
				return true
			case "brsp":
				if (this.border !== undefined) {
					this.touchBorder()
					this.border.space = param
				}
				return true
			case "brdrcf":
				if (this.border !== undefined) {
					this.touchBorder()
					this.border.color = param
				}
				return true
			case "cbpat":
				this.paraShading().fill = param
				return true
			case "absw":
				this.positioned().width = param
				return true
			case "absh":
				this.positioned().height = param
				return true
			case "phmrg":
			case "phpg":
			case "phcol":
				this.positioned().hAnchor = name === "phmrg" ? "margin" : name === "phpg" ? "page" : "text"
				return true
			case "pvmrg":
			case "pvpg":
			case "pvpara":
				this.positioned().vAnchor = name === "pvmrg" ? "margin" : name === "pvpg" ? "page" : "text"
				return true
			case "posx":
			case "posnegx": {
				const frame = this.positioned()

				frame.x = param
				frame.xAlign = undefined
				return true
			}
			case "posy":
			case "posnegy": {
				const frame = this.positioned()

				frame.y = param
				frame.yAlign = undefined
				return true
			}
			case "posxc":
			case "posxi":
			case "posxo":
			case "posxr":
			case "posxl":
				this.positioned().xAlign = ({ posxc: "center", posxi: "inside", posxo: "outside", posxr: "right", posxl: "left" } as const)[
					name
				]
				return true
			case "posyil":
			case "posyt":
			case "posyc":
			case "posyb":
			case "posyin":
			case "posyout":
				this.positioned().yAlign = (
					{ posyil: "inline", posyt: "top", posyc: "center", posyb: "bottom", posyin: "inside", posyout: "outside" } as const
				)[name]
				return true
			case "dxfrtext": {
				const frame = this.positioned()

				frame.hSpace = param
				frame.vSpace = param
				return true
			}
			case "dfrmtxtx":
				this.positioned().hSpace = param
				return true
			case "dfrmtxty":
				this.positioned().vSpace = param
				return true
			case "dropcapli":
				this.positioned().lines = param
				return true
			case "dropcapt":
				this.positioned().dropCap = param === 2 ? "margin" : "drop"
				return true
			// Wrapping words appear on every Word paragraph: they shape a frame without making one.
			case "nowrap":
			case "overlay":
			case "wraparound":
			case "wraptight":
			case "wrapthrough":
			case "wrapdefault": {
				const para = this.para()
				const wrap = (
					{
						nowrap: "notBeside",
						overlay: "none",
						wraparound: "around",
						wraptight: "tight",
						wrapthrough: "through",
						wrapdefault: "auto"
					} as const
				)[name]

				if (para.frame !== undefined) para.frame.wrap = wrap
				else para.pendingWrap = wrap
				return true
			}
			case "cfpat":
				this.paraShading().pattern = param
				return true
			case "shading":
				this.paraShading().percent = param
				return true
			case "bghoriz":
			case "bgvert":
			case "bgfdiag":
			case "bgbdiag":
			case "bgcross":
			case "bgdcross":
			case "bgdkhoriz":
			case "bgdkvert":
			case "bgdkfdiag":
			case "bgdkbdiag":
			case "bgdkcross":
			case "bgdkdcross":
				this.paraShading().texture = shadingTexture(name, "bg")
				return true
			// \\levelN, "the outline level of the paragraph" (obsolete): whether it counts as \\outlinelevelN does,
			// from 0, the specification leaves open.
			case "level":
				unread(this.para(), name)
				return true
			default:
				return false
		}
	}

	// A border word changes the border last named; the properties holding it are serialized again.
	private touchBorder(): void {
		if (this.borderOwner === "para") this.frame.para.cached = undefined
		else if (this.borderOwner === "char") this.frame.char.cached = undefined
	}

	private tableWord(name: string, param: number, hasParam: boolean): boolean {
		const row = this.row
		const cell = this.cell

		switch (name) {
			case "trowd": {
				this.row = newRow()
				this.cell = newCell()
				// In \\oldtprops: the old definition starts afresh, the row's stays the one defined.
				if (this.frame.old !== undefined) return true
				this.rows.set(this.frame.nestProps ? Math.max(2, this.frame.para.depth()) : 1, this.row)
				return true
			}
			case "trgaph":
				row.gap = param
				return true
			case "trleft":
				row.left = param
				return true
			case "trrh":
				row.height = param
				return true
			case "trhdr":
				row.header = true
				return true
			case "trkeep":
				row.cantSplit = true
				return true
			case "trql":
				row.jc = undefined
				return true
			case "trqc":
				row.jc = "center"
				return true
			case "trqr":
				row.jc = "right"
				return true
			case "taprtl":
				row.bidi = true
				return true
			case "trautofit":
				row.autofit = param === 1
				return true
			case "trwWidth":
				row.width = param
				return true
			case "trftsWidth":
				row.widthType = param
				return true
			case "ts":
				row.style = param
				return true
			case "trpaddl":
				row.padding.left = param
				return true
			case "trpaddr":
				row.padding.right = param
				return true
			case "trpaddt":
				row.padding.top = param
				return true
			case "trpaddb":
				row.padding.bottom = param
				return true
			case "trbrdrt":
			case "trbrdrl":
			case "trbrdrb":
			case "trbrdrr":
			case "trbrdrh":
			case "trbrdrv": {
				const side = (
					{
						trbrdrt: "top",
						trbrdrl: "left",
						trbrdrb: "bottom",
						trbrdrr: "right",
						trbrdrh: "insideH",
						trbrdrv: "insideV"
					} as const
				)[name]
				const border = newBorder()

				row.borders[side] = border
				this.border = border
				this.borderOwner = "none"
				return true
			}
			case "clbrdrt":
			case "clbrdrl":
			case "clbrdrb":
			case "clbrdrr": {
				const side = ({ clbrdrt: "top", clbrdrl: "left", clbrdrb: "bottom", clbrdrr: "right" } as const)[name]
				const border = newBorder()

				cell.borders[side] = border
				this.border = border
				this.borderOwner = "none"
				return true
			}
			case "clcbpat":
				cell.shading = { ...(cell.shading ?? newShading()), fill: param }
				return true
			case "clcfpat":
				cell.shading = { ...(cell.shading ?? newShading()), pattern: param }
				return true
			case "clshdng":
				cell.shading = { ...(cell.shading ?? newShading()), percent: param }
				return true
			case "clbghoriz":
			case "clbgvert":
			case "clbgfdiag":
			case "clbgbdiag":
			case "clbgcross":
			case "clbgdcross":
			case "clbgdkhor":
			case "clbgdkvert":
			case "clbgdkfdiag":
			case "clbgdkbdiag":
			case "clbgdkcross":
			case "clbgdkdcross":
				cell.shading = { ...(cell.shading ?? newShading()), texture: shadingTexture(name, "clbg") }
				return true
			// Row shading (RTF 1.9.1 "Row Shading and Background Color"): the table's w:shd.
			case "trcbpat":
				row.shading = { ...(row.shading ?? newShading()), fill: param }
				return true
			case "trcfpat":
				row.shading = { ...(row.shading ?? newShading()), pattern: param }
				return true
			case "trshdng":
				row.shading = { ...(row.shading ?? newShading()), percent: param }
				return true
			case "trbghoriz":
			case "trbgvert":
			case "trbgfdiag":
			case "trbgbdiag":
			case "trbgcross":
			case "trbgdcross":
			case "trbgdkhor":
			case "trbgdkvert":
			case "trbgdkfdiag":
			case "trbgdkbdiag":
			case "trbgdkcross":
			case "trbgdkdcross":
				row.shading = { ...(row.shading ?? newShading()), texture: shadingTexture(name, "trbg") }
				return true
			// \\trpatN: a row's pattern by a number the specification does not give.
			case "trpat":
				if (!` ${row.unread} `.includes(" trpat ")) row.unread = `${row.unread} trpat`.trim()
				return true
			case "tblind":
				row.indent = param
				return true
			case "tblindtype":
				row.indentType = param
				return true
			case "trwWidthB":
				row.widthBefore = param
				return true
			case "trftsWidthB":
				row.widthBeforeType = param
				return true
			case "trwWidthA":
				row.widthAfter = param
				return true
			case "trftsWidthA":
				row.widthAfterType = param
				return true
			case "clvertalt":
				cell.vAlign = "top"
				return true
			case "clvertalc":
				cell.vAlign = "center"
				return true
			case "clvertalb":
				cell.vAlign = "bottom"
				return true
			case "clmgf":
				cell.mergeFirst = true
				return true
			case "clmrg":
				cell.merged = true
				return true
			case "clvmgf":
				cell.vMergeFirst = true
				return true
			case "clvmrg":
				cell.vMerged = true
				return true
			case "clwWidth":
				cell.width = param
				return true
			case "clftsWidth":
				cell.widthType = param
				return true
			case "clNoWrap":
				cell.noWrap = true
				return true
			// Compared table cells (RTF 1.9.1, "Tables"): a cell inserted or deleted, by whom and when.
			case "clins":
			case "cldel":
				cell.revision = {
					kind: name === "clins" ? "cellIns" : "cellDel",
					author: cell.revision?.author ?? -1,
					date: cell.revision?.date ?? 0
				}
				return true
			case "clinsauth":
			case "cldelauth":
				cell.revision = {
					kind: cell.revision?.kind ?? (name === "clinsauth" ? "cellIns" : "cellDel"),
					author: param,
					date: cell.revision?.date ?? 0
				}
				return true
			case "clinsdttm":
			case "cldeldttm":
				cell.revision = {
					kind: cell.revision?.kind ?? (name === "clinsdttm" ? "cellIns" : "cellDel"),
					author: cell.revision?.author ?? -1,
					date: param
				}
				return true
			case "cltxtbrl":
				cell.textDirection = "tbRl"
				return true
			case "cltxbtlr":
				cell.textDirection = "btLr"
				return true
			// Word writes \clpadt for the left padding and \clpadl for the top (LibreOffice 7.5 reads them so).
			case "clpadt":
				cell.padding.left = param
				return true
			case "clpadl":
				cell.padding.top = param
				return true
			case "clpadb":
				cell.padding.bottom = param
				return true
			case "clpadr":
				cell.padding.right = param
				return true
			case "cellx": {
				row.cells.push({ ...cell, right: param })
				this.cell = newCell()
				return true
			}
			case "cell":
				this.endCell(1)
				return true
			case "nestcell":
				this.endCell(Math.max(2, this.frame.para.depth()))
				return true
			case "row":
				this.endRow(1)
				return true
			case "nestrow":
				this.endRow(Math.max(2, this.frame.para.depth()))
				return true
			default:
				void hasParam
				return false
		}
	}

	private sectionWord(name: string, param: number, hasParam: boolean): boolean {
		const section = this.section
		const format = PAGE_FORMATS.get(name)

		if (format !== undefined) {
			section.pageFormat = format
			return true
		}

		switch (name) {
			case "sectd": {
				// In \\oldsprops: the old properties start afresh, the section's references stay.
				if (this.frame.old !== undefined) {
					this.section = this.sectionDefaults.clone()
					return true
				}

				// Inside a header, footer or note no section starts: the body's keeps its properties. Its headers and
				// footers are no section properties: a \\sectd within a section (Word writes one after a field, the
				// section's words again after it) keeps them; \\sect ends them with the section (endSection).
				const dest = this.frame.dest

				if (dest.kind === "story" && dest.story === this.doc.body) this.section = this.sectionDefaults.clone()
				return true
			}
			case "pgwsxn":
				section.width = param
				return true
			case "pghsxn":
				section.height = param
				return true
			case "marglsxn":
				section.left = param
				return true
			case "margrsxn":
				section.right = param
				return true
			case "margtsxn":
				section.top = param
				return true
			case "margbsxn":
				section.bottom = param
				return true
			case "guttersxn":
				section.gutter = param
				return true
			case "headery":
				section.header = param
				return true
			case "footery":
				section.footer = param
				return true
			case "lndscpsxn":
				section.landscape = true
				return true
			case "cols":
				section.columns = param
				return true
			case "colsx":
				section.columnSpace = param
				return true
			case "linebetcol":
				section.columnLine = true
				return true
			case "colno":
				// w:cols holds at most 45 columns (ECMA-376 Part 1 §17.6.4).
				while (section.columnWidths.length < Math.min(param, 45))
					section.columnWidths.push({ width: 0, space: section.columnSpace })
				return true
			case "colw": {
				const last = section.columnWidths.at(-1)

				if (last !== undefined) last.width = param
				return true
			}
			case "colsr": {
				const last = section.columnWidths.at(-1)

				if (last !== undefined) last.space = param
				return true
			}
			case "sbknone":
				section.breakType = "continuous"
				return true
			case "sbkcol":
				section.breakType = "nextColumn"
				return true
			case "sbkpage":
				section.breakType = "nextPage"
				return true
			case "sbkeven":
				section.breakType = "evenPage"
				return true
			case "sbkodd":
				section.breakType = "oddPage"
				return true
			case "titlepg":
				section.titlePage = true
				return true
			case "pgnstarts":
				section.pageStart = param
				return true
			case "pgnrestart":
				if (section.pageStart < 0) section.pageStart = 1
				return true
			case "pgncont":
				section.pageStart = -1
				return true
			case "vertalt":
				section.vAlign = "top"
				return true
			case "vertalc":
				section.vAlign = "center"
				return true
			case "vertalj":
				section.vAlign = "both"
				return true
			case "vertalb":
				section.vAlign = "bottom"
				return true
			case "rtlsect":
				section.bidi = true
				return true
			case "ltrsect":
				section.bidi = false
				return true
			case "linemod":
				section.lineNumbers.countBy = param
				return true
			case "linex":
				section.lineNumbers.distance = param
				return true
			case "linestarts":
				section.lineNumbers.start = param
				return true
			case "linecont":
				section.lineNumbers.restart = "continuous"
				return true
			case "lineppage":
				section.lineNumbers.restart = "newPage"
				return true
			case "linerestart":
				section.lineNumbers.restart = "newSection"
				return true
			case "sect":
				this.endSection()
				return true
			default:
				void hasParam
				return false
		}
	}

	private specialWord(name: string, param: number, hasParam: boolean): void {
		const character = CHARACTERS.get(name)

		if (character !== undefined) {
			this.characters(character)
			return
		}

		switch (name) {
			case "par":
				this.endParagraph()
				return
			case "tab":
				this.inline("<w:tab/>")
				return
			case "line":
				this.inline("<w:br/>")
				return
			case "page":
				this.inline('<w:br w:type="page"/>')
				return
			case "column":
				this.inline('<w:br w:type="column"/>')
				return
			case "lbr":
				this.inline(`<w:br w:clear="${["none", "left", "right", "all"][param] ?? "none"}"/>`)
				return
			case "chftn": {
				const dest = this.frame.dest

				if (dest.kind === "story" && this.doc.isNote(dest.story)) this.inline(`${MARK}R${this.doc.noteIndex(dest.story)}${MARK}`)
				else this.noteMark = true
				return
			}
			case "ftnalt": {
				const dest = this.frame.dest

				if (dest.kind === "story" && this.doc.isNote(dest.story)) this.doc.setNoteKind(dest.story, "endnote")
				return
			}
			case "chatn": {
				const dest = this.frame.dest

				if (dest.kind === "story" && this.doc.isComment(dest.story)) this.inline("<w:annotationRef/>")
				return
			}
			case "chpgn":
				this.simpleField("PAGE", "1")
				return
			case "chdate":
				this.simpleField("DATE", "")
				return
			case "chtime":
				this.simpleField("TIME", "")
				return
			case "sectnum":
				this.simpleField("SECTION", "1")
				return
			case "fldlock": {
				const field = this.fields.at(-1)

				if (field !== undefined) field.lock = true
				return
			}
			case "flddirty": {
				const field = this.fields.at(-1)

				if (field !== undefined) field.dirty = true
				return
			}
			default:
				void hasParam
		}
	}

	private simpleField(instruction: string, result: string): void {
		if (this.frame.dest.kind !== "story") return

		this.inline('<w:fldChar w:fldCharType="begin"/>')
		this.inline(`<w:instrText xml:space="preserve"> ${instruction} </w:instrText>`)
		this.inline('<w:fldChar w:fldCharType="separate"/>')
		if (result !== "") this.inline(`<w:t>${escapeText(result)}</w:t>`)
		this.inline('<w:fldChar w:fldCharType="end"/>')
	}

	// ---- paragraphs, cells, rows, sections

	private paraXml(para: ParaProps, mark: CharProps, sectPr: string | undefined): string {
		const box = this.frame.box

		if (box !== undefined && para.frame === undefined) {
			para = para.clone()
			para.cached = undefined
			para.frame = box
		}

		const props = para.xml(this.doc, list => this.doc.numId(list))
		let rPr = mark.xml(this.doc)
		// The paragraph mark inserted or deleted: \\revised or \\deleted in force at \\par, the mark's own w:ins or
		// w:del (ECMA-376 Part 1 §17.13.5.16, §17.13.5.14), first in its properties.
		const revision = this.revision(mark)

		if (revision !== "") {
			const tag = revision.replace(/>$/u, "/>").replace(/^<w:(ins|del)/u, open => `${open} w:id="${this.doc.nextId()}"`)

			rPr = rPr === "" ? `<w:rPr>${tag}</w:rPr>` : rPr.replace("<w:rPr>", `<w:rPr>${tag}`)
		}

		const old = para.old
		const change =
			old === undefined
				? ""
				: `${this.doc.change("pPrChange", old.author, old.date)}<w:pPr>${old.props.xml(this.doc, list => this.doc.numId(list))}</w:pPr></w:pPrChange>`

		return props + rPr + (sectPr ?? "") + change
	}

	// The paragraph's own words and its mark's (see noteUnread).
	private noteParagraph(story: Story, para: ParaProps, mark: CharProps): void {
		const names = shadingConflict(para.shading) ? `${para.unread} shading`.trim() : para.unread

		if (names !== "" && !story.unread.includes(names)) story.unread = story.unread === "" ? names : `${story.unread} ${names}`

		this.noteUnread(story, mark)
	}

	private withLabel(para: ParaProps): boolean {
		return !(para.list > 0 && this.doc.numId(para.list) !== undefined)
	}

	private endParagraph(sectPr?: string): void {
		const dest = this.frame.dest

		if (dest.kind !== "story") return

		const para = this.frame.para
		const story = dest.story

		this.noteParagraph(story, para, this.frame.char)
		story.paragraph(
			this.paraXml(para, this.frame.char, sectPr),
			sectPr === undefined ? para.depth() : 0,
			this.withLabel(para),
			this.tokens.end,
			this.tokens.start
		)
	}

	private endCell(depth: number): void {
		const dest = this.frame.dest

		if (dest.kind !== "story") return

		const para = this.frame.para
		const story = dest.story

		this.noteParagraph(story, para, this.frame.char)
		story.paragraph(this.paraXml(para, this.frame.char, undefined), depth, this.withLabel(para), this.tokens.end, this.tokens.start)
		story.cell(depth)
		this.nested = depth >= 2 ? { story, mark: story.mark } : undefined
	}

	private endRow(depth: number): void {
		const dest = this.frame.dest

		if (dest.kind !== "story") return

		const story = dest.story

		if (!story.empty) {
			const para = this.frame.para

			this.noteParagraph(story, para, this.frame.char)
			story.paragraph(this.paraXml(para, this.frame.char, undefined), depth, this.withLabel(para), this.tokens.end, this.tokens.start)
			story.cell(depth)
		} else {
			story.discard()
		}

		story.row(depth, this.rows.get(depth) ?? this.row, this.tokens.end)
		this.nested = depth >= 2 ? { story, mark: story.mark } : undefined
	}

	private sectionXml(): string {
		let references = ""

		for (const footer of [false, true]) {
			const set = this.doc.sectionHeaders(footer)
			const tag = footer ? "footer" : "header"

			for (const [type, index] of set)
				references += `<w:${tag}Reference w:type="${type}" r:id="${this.doc.headerRelationship(index)}"/>`

			// \header (or \headerr) alone in a facing-pages document is on left and right pages alike.
			const shared = set.get("default")

			if (this.doc.evenAndOdd && shared !== undefined && !set.has("even")) {
				references += `<w:${tag}Reference w:type="even" r:id="${this.doc.headerRelationship(shared)}"/>`
			}
		}

		const old = this.section.old
		const change =
			old === undefined
				? ""
				: `${this.doc.change("sectPrChange", old.author, old.date)}<w:sectPr>${old.props.xml()}</w:sectPr></w:sectPrChange>`

		return `<w:sectPr>${references}${this.section.xml()}${change}</w:sectPr>`
	}

	private endSection(): void {
		const dest = this.frame.dest

		if (dest.kind !== "story" || dest.story !== this.doc.body) return

		this.endParagraph(this.sectionXml())
		// The next section inherits these properties; its headers and footers default to the previous ones'.
		this.doc.sectionHeaders(false).clear()
		this.doc.sectionHeaders(true).clear()
	}
}

// Run properties whose markup asks nothing of the document (no revision ids).
function plainChar(props: CharProps): boolean {
	return !props.inserted && !props.deleted && props.old === undefined
}

// A word in force that the translation cannot hold (see CharProps.unread).
function unread(props: CharProps | ParaProps, name: string): void {
	if (!` ${props.unread} `.includes(` ${name} `)) props.unread = props.unread === "" ? name : `${props.unread} ${name}`
}

function onlySpace(bytes: Uint8Array, from: number, to: number): boolean {
	for (let at = from; at < to; at++) {
		const byte = bytes[at]

		if (byte !== 0x20 && byte !== 0x0d && byte !== 0x0a && byte !== 0x09) return false
	}

	return from <= to
}

function graphic(relationshipId: string, picture: Picture, id: number): string {
	const crop = picture.crop
	const srcRect = crop === undefined ? "" : `<a:srcRect l="${crop.left}" t="${crop.top}" r="${crop.right}" b="${crop.bottom}"/>`

	return `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${escapeAttribute(relationshipId)}"/>${srcRect}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${picture.cx}" cy="${picture.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`
}

function hex(component: number): string {
	return Math.max(0, Math.min(255, component < 0 ? 0 : component))
		.toString(16)
		.padStart(2, "0")
		.toUpperCase()
}

// The character a SYMBOL field draws (Word computes its result from the instruction): \\f names the font
// (a symbol font's codes as Word keeps them, U+F020..U+F0FF), \\u marks a Unicode code. Undefined when the
// instruction is not a SYMBOL field.
export function symbolField(instruction: string): string | undefined {
	const match = /^\s*SYMBOL\s+(0x[0-9a-f]+|\d+)(.*)$/isu.exec(instruction)

	if (match === null) return undefined

	const code = Number(match[1])
	const switches = match[2] ?? ""
	const font = /\\f\s*(?:"([^"]*)"|(\S+))/u.exec(switches)
	const name = font?.[1] ?? font?.[2]
	const unicode = /\\u\b/u.test(switches)

	if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return undefined

	if (name !== undefined && !unicode && code < 0x100) {
		return `<w:sym w:font="${escapeAttribute(name)}" w:char="${(0xf000 + code).toString(16).toUpperCase()}"/>`
	}

	return `<w:t>${escapeText(String.fromCodePoint(code))}</w:t>`
}

// A shape's integer property (RTF 1.9.1 "Shapes", MS-ODRAW §2.3).
function shapeNumber(shape: ShapeState, name: string, value: number): void {
	switch (name) {
		case "shapeType":
			shape.shapeType = value
			break
		case "fFilled":
			shape.filled = value !== 0
			break
		case "fillColor":
			shape.fillColor = value >>> 0
			break
		case "fLine":
			shape.lined = value !== 0
			break
		case "lineColor":
			shape.lineColor = value >>> 0
			break
		case "lineWidth":
			shape.lineWidth = Math.max(0, value)
			break
		case "rotation":
			shape.rotation = value | 0
			break
		case "fFlipH":
			shape.flipH = value !== 0
			break
		case "fFlipV":
			shape.flipV = value !== 0
			break
		case "dxTextLeft":
			shape.insets[0] = value
			break
		case "dyTextTop":
			shape.insets[1] = value
			break
		case "dxTextRight":
			shape.insets[2] = value
			break
		case "dyTextBottom":
			shape.insets[3] = value
			break
		case "relLeft":
		case "relTop":
		case "relRight":
		case "relBottom": {
			const rel = (shape.rel ??= [0, 0, 0, 0])

			rel[["relLeft", "relTop", "relRight", "relBottom"].indexOf(name)] = value
			break
		}
		case "groupLeft":
			shape.space[0] = value
			break
		case "groupTop":
			shape.space[1] = value
			break
		case "groupRight":
			shape.space[2] = value
			break
		case "groupBottom":
			shape.space[3] = value
			break
		default:
			break
	}
}

// Where a shape is: its own place, or for a shape of a group its rectangle in the group's coordinate space
// (relLeft..., in groupLeft...) mapped onto the group's place. A member without one shows at the group's corner at
// its own size.
function shapePlace(shape: ShapeState): { left: number; top: number; right: number; bottom: number; relH: string; relV: string } {
	const parent = shape.parent

	if (parent === undefined) return shape

	const outer = shapePlace(parent)
	const rel = shape.rel

	if (rel === undefined)
		return {
			left: outer.left,
			top: outer.top,
			right: outer.left + (shape.right - shape.left),
			bottom: outer.top + (shape.bottom - shape.top),
			relH: outer.relH,
			relV: outer.relV
		}

	const [x0, y0, x1, y1] = parent.space
	const scaleX = x1 === x0 ? 1 : (outer.right - outer.left) / (x1 - x0)
	const scaleY = y1 === y0 ? 1 : (outer.bottom - outer.top) / (y1 - y0)

	return {
		left: outer.left + (rel[0] - x0) * scaleX,
		top: outer.top + (rel[1] - y0) * scaleY,
		right: outer.left + (rel[2] - x0) * scaleX,
		bottom: outer.top + (rel[3] - y0) * scaleY,
		relH: outer.relH,
		relV: outer.relV
	}
}

const SHAPE_NAMESPACES =
	' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"'

// Destinations of \\formfield holding text.
const FORM_TEXTS = new Set(["ffname", "ffdeftext", "ffformat", "ffhelptext", "ffstattext", "ffentrymcr", "ffexitmcr", "ffl"])
const TEXT_TYPES = ["regular", "number", "date", "currentDate", "currentTime", "calculated"]

// w:ffData (ECMA-376 Part 1 §17.16.17) of a form field's RTF properties: \\fftype 0 text, 1 check box, 2 drop-down.
// The longest value each form field text may be, in UTF-16 units, as Office and the Open XML SDK validate them (the
// schema's own maxLength is looser: ECMA-376 Part 1 §17.18 ST_FFName 65, ST_FFHelpTextVal 256): a name 20, a macro 33,
// help 255, status 140, a default or drop-down entry 255, a format 64; 25 drop-down entries, an index among them, a
// maximum length up to 32767. Longer values are cut to them.
const FORM_TEXT_LIMITS: Readonly<Record<string, number>> = {
	ffname: 20,
	ffentrymcr: 33,
	ffexitmcr: 33,
	ffhelptext: 255,
	ffstattext: 140,
	ffdeftext: 255,
	ffformat: 64,
	ffl: 255
}
const FORM_LIST_ENTRIES = 25
const FORM_MAX_LENGTH = 32_767

// `text` cut to `limit` UTF-16 units, never inside a surrogate pair.
function cutUtf16(text: string, limit: number): string {
	if (text.length <= limit) return text

	const code = text.charCodeAt(limit - 1)

	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit)
}

function ffData(words: ReadonlyMap<string, number>, texts: ReadonlyMap<string, string>, items: readonly string[]): string {
	const clamp = (name: string, text: string): string => cutUtf16(text, FORM_TEXT_LIMITS[name] ?? text.length)
	const value = (name: string): string => ` w:val="${escapeAttribute(clamp(name, texts.get(name) ?? ""))}"`
	const type = words.get("fftype") ?? 0
	let out = `<w:ffData><w:name${value("ffname")}/><w:enabled/><w:calcOnExit w:val="${words.get("ffrecalc") === 1 ? 1 : 0}"/>`

	if (texts.has("ffentrymcr")) out += `<w:entryMacro${value("ffentrymcr")}/>`
	if (texts.has("ffexitmcr")) out += `<w:exitMacro${value("ffexitmcr")}/>`
	if (texts.has("ffhelptext")) out += `<w:helpText w:type="text"${value("ffhelptext")}/>`
	if (texts.has("ffstattext")) out += `<w:statusText w:type="text"${value("ffstattext")}/>`

	if (type === 1) {
		const size = words.get("ffhps")

		out += `<w:checkBox>${size === undefined || size <= 0 || words.get("ffsize") === 0 ? "<w:sizeAuto/>" : `<w:size w:val="${size}"/>`}<w:default w:val="${words.get("ffdefres") === 1 ? 1 : 0}"/>`
		out += words.has("ffres") && words.get("ffres") !== 25 ? `<w:checked w:val="${words.get("ffres") === 1 ? 1 : 0}"/>` : ""
		out += "</w:checkBox>"
	} else if (type === 2) {
		const result = words.get("ffres")

		// An index among the entries kept (\\ffres 25: none chosen).
		const last = Math.max(0, Math.min(items.length, FORM_LIST_ENTRIES) - 1)

		out += "<w:ddList>"
		out += result !== undefined && result !== 25 && result >= 0 ? `<w:result w:val="${Math.min(result, last)}"/>` : ""
		out += `<w:default w:val="${Math.min(Math.max(0, words.get("ffdefres") ?? 0), last)}"/>`
		out += items
			.slice(0, FORM_LIST_ENTRIES)
			.map(item => `<w:listEntry w:val="${escapeAttribute(clamp("ffl", item))}"/>`)
			.join("")
		out += "</w:ddList>"
	} else {
		const kind = TEXT_TYPES[words.get("fftypetxt") ?? 0] ?? "regular"
		const max = words.get("ffmaxlen") ?? 0

		out += `<w:textInput>${kind === "regular" ? "" : `<w:type w:val="${kind}"/>`}`
		out += texts.has("ffdeftext") ? `<w:default${value("ffdeftext")}/>` : ""
		out += max > 0 ? `<w:maxLength w:val="${Math.min(max, FORM_MAX_LENGTH)}"/>` : ""
		out += texts.has("ffformat") ? `<w:format${value("ffformat")}/>` : ""
		out += "</w:textInput>"
	}

	return `${out}</w:ffData>`
}
