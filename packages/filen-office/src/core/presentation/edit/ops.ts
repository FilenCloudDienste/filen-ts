import type { ChartEditType, SheetChartEdit } from "../../xlsx/charts/edit"
import type { ChartGrouping } from "../../xlsx/charts/model"
import type { Behavior, TimeNode, TimingTree, Transition } from "../../anim/model"
import type { JumpRewrite } from "./integrity"
import type {
	Action,
	Background,
	ColorModel,
	CustomShow,
	EdgeFractions,
	ShapeNode,
	ShapePropsEdit,
	ShapeRef,
	ShapeStyleRefs,
	Section,
	SlideNode,
	SlideRef,
	TableCellProps,
	TextBody,
	Xfrm
} from "../model"

// Every edit to a deck, as data: the page sends one per command, the worker applies it in place and keeps its
// inverse (edit/apply.ts). Grouped by family; each family has one apply file and one emit file per format, owned by
// one slice, so a family grows without touching another's. Ops cross the worker boundary by structured clone (only
// inserted image and workbook bytes are transferred; model values are cloned, so the sender keeps them), and hold no
// functions or ports.
//
// Inverses: an inverse holds typed values only for prior state that was itself an edit (`props`, a local xfrm);
// prior state that came from the source is held as bytes — `raw`, source markup serialized when the op was applied,
// re-read on apply and written back byte for byte — never as a SourceRef, so it survives a save's rebase (after which
// "the source group" would be the edit itself). shape.restore is that inverse for every op on one shape whose prior
// state was source.

export type DeckOpFamily =
	| "slide"
	| "shape"
	| "text"
	| "table"
	| "picture"
	| "chart"
	| "media"
	| "notes"
	| "comment"
	| "timing"
	| "transition"
	| "motionPath"
	| "design"
	| "smartart"
	| "ink"
	| "mediaTiming"

export const DECK_OP_FAMILIES: readonly DeckOpFamily[] = [
	"slide",
	"shape",
	"text",
	"table",
	"picture",
	"chart",
	"media",
	"notes",
	"comment",
	"timing",
	"transition",
	"motionPath",
	"design",
	"smartart",
	"ink",
	"mediaTiming"
]

// A source part of a removed slide (the slide, its notes, its comments, its charts…), to restore on undo.
export interface RawPart {
	readonly name: string
	readonly contentType: string
	readonly bytes: Uint8Array
	// Its relationships part, when it has one.
	readonly rels?: Uint8Array
	// Internal targets of its relationships the package did not have when the part was held (a damaged source): written
	// back as they were, never refused as this save's damage. Model part names.
	readonly absent?: readonly string[]
}

export type SlideOp =
	// `ref` is allocated by the page's session mirror or by apply (absent); `at` is the index in deck.slides.
	| { readonly family: "slide"; readonly kind: "add"; readonly at: number; readonly layout: SlideRef; readonly ref?: SlideRef }
	| { readonly family: "slide"; readonly kind: "duplicate"; readonly slide: SlideRef; readonly at?: number; readonly ref?: SlideRef }
	| { readonly family: "slide"; readonly kind: "delete"; readonly slides: readonly SlideRef[] }
	// The inverse of delete: the slides' parts as they were, at their indices.
	| {
			readonly family: "slide"
			readonly kind: "restore"
			readonly slides: readonly {
				readonly ref: SlideRef
				readonly at: number
				readonly parts: readonly RawPart[]
				// The nodes' typed state when deleted (the slide, then its notes): the edits on them, and the whole of a slide
				// an op made (it has no parts).
				readonly nodes?: readonly SlideNode[]
				// On the first entry: the custom shows as they were, and the jumps the delete rewrote (edit/integrity.ts).
				readonly customShows?: readonly CustomShow[]
				readonly jumps?: readonly JumpRewrite[]
			}[]
	  }
	| { readonly family: "slide"; readonly kind: "move"; readonly slides: readonly SlideRef[]; readonly to: number }
	| { readonly family: "slide"; readonly kind: "hide"; readonly slides: readonly SlideRef[]; readonly hidden: boolean }
	| { readonly family: "slide"; readonly kind: "setLayout"; readonly slide: SlideRef; readonly layout: SlideRef }
	// Removes local xfrm and props of placeholders (PowerPoint's Reset).
	| { readonly family: "slide"; readonly kind: "reset"; readonly slide: SlideRef }
	| { readonly family: "slide"; readonly kind: "setSections"; readonly sections: readonly Section[] }

export type ZOrder = "front" | "back" | "forward" | "backward"

export type ShapeOp =
	// `parent`: a group's id on the slide; `index`: z-position among its siblings (end when absent). With `raw`, the
	// shape is that source element (an undone delete).
	| {
			readonly family: "shape"
			readonly kind: "insert"
			readonly slide: SlideRef
			readonly shape: ShapeNode
			readonly index?: number
			readonly parent?: number
			readonly raw?: Uint8Array
	  }
	| { readonly family: "shape"; readonly kind: "delete"; readonly slide: SlideRef; readonly shapes: readonly number[] }
	// undefined removes the local xfrm (the placeholder inherits its box again).
	| { readonly family: "shape"; readonly kind: "setXfrm"; readonly target: ShapeRef; readonly xfrm: Xfrm | undefined }
	// Several shapes of one slide moved, resized or turned at once (a drag or nudge of a multi-selection): one step.
	// undefined removes that shape's local xfrm.
	| {
			readonly family: "shape"
			readonly kind: "setXfrms"
			readonly slide: SlideRef
			readonly xfrms: readonly { readonly id: number; readonly xfrm: Xfrm | undefined }[]
	  }
	// The shape's element replaced by these bytes (whole-node dirt): the inverse of setProps, setStyle, setAlt,
	// setAction, picture crop/adjust/replace, media setPoster/setPlayback, every mediaTiming op and the table ops
	// (the graphicFrame) when their prior state was source.
	| { readonly family: "shape"; readonly kind: "restore"; readonly target: ShapeRef; readonly raw: Uint8Array }
	// Each present group replaces that group; undefined in `props` for a group restores the source group.
	| { readonly family: "shape"; readonly kind: "setProps"; readonly target: ShapeRef; readonly props: ShapePropsEdit }
	| { readonly family: "shape"; readonly kind: "setStyle"; readonly target: ShapeRef; readonly style: ShapeStyleRefs | undefined }
	| {
			readonly family: "shape"
			readonly kind: "zOrder"
			readonly slide: SlideRef
			readonly shapes: readonly number[]
			readonly to: ZOrder
	  }
	| {
			readonly family: "shape"
			readonly kind: "group"
			readonly slide: SlideRef
			readonly shapes: readonly number[]
			readonly id?: number
			readonly name?: string
	  }
	| { readonly family: "shape"; readonly kind: "ungroup"; readonly slide: SlideRef; readonly group: number }
	| {
			readonly family: "shape"
			readonly kind: "align"
			readonly slide: SlideRef
			readonly shapes: readonly number[]
			readonly edge: "left" | "center" | "right" | "top" | "middle" | "bottom"
			readonly relativeTo: "slide" | "selection"
	  }
	| {
			readonly family: "shape"
			readonly kind: "distribute"
			readonly slide: SlideRef
			readonly shapes: readonly number[]
			readonly axis: "horizontal" | "vertical"
			readonly relativeTo: "slide" | "selection"
	  }
	| {
			readonly family: "shape"
			readonly kind: "setAlt"
			readonly target: ShapeRef
			readonly alt: { readonly descr?: string; readonly title?: string; readonly decorative?: boolean } | undefined
	  }
	| {
			readonly family: "shape"
			readonly kind: "setAction"
			readonly target: ShapeRef
			readonly trigger: "click" | "hover"
			readonly action: Action | undefined
	  }

export type TextOp =
	// The whole new body of one shape. `burst` groups the transactions of one typing run into one history step.
	| {
			readonly family: "text"
			readonly kind: "setText"
			readonly target: ShapeRef
			readonly body: TextBody
			readonly burst?: number
			readonly raw?: Uint8Array
	  }
	// The worker's autofit result for a body: normAutofit fontScale and lnSpcReduction (1/100,000), spAutoFit height (EMU).
	| {
			readonly family: "text"
			readonly kind: "setAutofitResult"
			readonly target: ShapeRef
			readonly fontScale?: number
			readonly lnSpcReduction?: number
			readonly height?: number
	  }
	// Every match of `query` in the target bodies replaced by `replacement` (each takes the formatting of the first
	// character it replaces); `match` (paragraph, start, end in find text, edit/find.ts) limits a target to that one
	// match, refused as stale when it no longer holds there.
	| {
			readonly family: "text"
			readonly kind: "replace"
			readonly query: string
			readonly replacement: string
			readonly caseSensitive?: boolean
			readonly wholeWord?: boolean
			readonly targets: readonly {
				readonly target: ShapeRef
				// The body is the notes of slide `target.slide` (target.id is the notes body's shape id); applied, the op
				// names the notes slide's own ref instead.
				readonly notes?: boolean
				readonly match?: readonly [number, number, number]
			}[]
	  }

export interface CellRange {
	readonly row: number
	readonly col: number
	readonly rows: number
	readonly cols: number
}

export type TableOp =
	| { readonly family: "table"; readonly kind: "insertRows"; readonly target: ShapeRef; readonly at: number; readonly count: number }
	| { readonly family: "table"; readonly kind: "deleteRows"; readonly target: ShapeRef; readonly at: number; readonly count: number }
	| { readonly family: "table"; readonly kind: "insertColumns"; readonly target: ShapeRef; readonly at: number; readonly count: number }
	| { readonly family: "table"; readonly kind: "deleteColumns"; readonly target: ShapeRef; readonly at: number; readonly count: number }
	| { readonly family: "table"; readonly kind: "merge"; readonly target: ShapeRef; readonly range: CellRange }
	| { readonly family: "table"; readonly kind: "split"; readonly target: ShapeRef; readonly row: number; readonly col: number }
	| {
			readonly family: "table"
			readonly kind: "setCellText"
			readonly target: ShapeRef
			readonly row: number
			readonly col: number
			readonly body: TextBody
			readonly burst?: number
			readonly raw?: Uint8Array
	  }
	| {
			readonly family: "table"
			readonly kind: "setCellProps"
			readonly target: ShapeRef
			readonly range: CellRange
			readonly props: TableCellProps
	  }
	| {
			readonly family: "table"
			readonly kind: "setStyle"
			readonly target: ShapeRef
			readonly styleId: string | undefined
			readonly flags?: { readonly [flag in "firstRow" | "lastRow" | "firstCol" | "lastCol" | "bandRow" | "bandCol"]?: boolean }
	  }
	// EMU.
	| { readonly family: "table"; readonly kind: "setColumnWidth"; readonly target: ShapeRef; readonly col: number; readonly width: number }
	| { readonly family: "table"; readonly kind: "setRowHeight"; readonly target: ShapeRef; readonly row: number; readonly height: number }

// An image prepared in the worker (decoded, size-checked, re-encoded when needed), held by the op until a save
// gives it a part.
export interface InsertedImage {
	readonly bytes: Uint8Array
	readonly contentType: string
	readonly width: number
	readonly height: number
}

export interface PictureAdjust {
	// -100,000..100,000.
	readonly brightness?: number
	readonly contrast?: number
	readonly grayscale?: boolean
	readonly biLevel?: number
	readonly duotone?: readonly [ColorModel, ColorModel]
	readonly alpha?: number
}

export type PictureOp =
	| {
			readonly family: "picture"
			readonly kind: "insert"
			readonly slide: SlideRef
			readonly shape: ShapeNode
			readonly image: InsertedImage
			readonly index?: number
	  }
	| { readonly family: "picture"; readonly kind: "replace"; readonly target: ShapeRef; readonly image: InsertedImage }
	| { readonly family: "picture"; readonly kind: "crop"; readonly target: ShapeRef; readonly crop: EdgeFractions | undefined }
	| { readonly family: "picture"; readonly kind: "adjust"; readonly target: ShapeRef; readonly adjust: PictureAdjust | undefined }

export type ChartOp =
	// A new chart part with an embedded workbook holding `cells` (rows of the data range, the first row and column
	// the names).
	| {
			readonly family: "chart"
			readonly kind: "insert"
			readonly slide: SlideRef
			readonly shape: ShapeNode
			readonly type: ChartEditType
			readonly grouping?: ChartGrouping
			readonly cells: readonly (readonly (string | number | null)[])[]
	  }
	| { readonly family: "chart"; readonly kind: "edit"; readonly target: ShapeRef; readonly edit: SheetChartEdit }
	// Edit Data: the embedded workbook as the sheet worker saved it; the chart's caches refresh from it.
	| {
			readonly family: "chart"
			readonly kind: "setWorkbook"
			readonly target: ShapeRef
			readonly workbook: Uint8Array
			readonly contentType: string
	  }

// A file the page handed the worker (a device File, structured-cloned without copying its bytes).
export interface FileLike {
	readonly size: number
	readonly type: string
	readonly name: string
	slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> }
}

// An inserted medium as the worker registered it (core media registry): read once at insert for its CRC-32 and
// probe, once more at save as a stored entry.
export interface InsertedMedia {
	// The worker's media registry id.
	readonly id: number
	readonly kind: "audio" | "video"
	readonly contentType: string
	readonly size: number
	readonly crc32: number
	readonly durationMs?: number
	readonly poster?: InsertedImage
}

export interface MediaPlayback {
	// 0..100,000.
	readonly volume?: number
	readonly mute?: boolean
	readonly loop?: boolean
	readonly rewind?: boolean
	readonly autoPlay?: boolean
	readonly fullScreen?: boolean
	readonly hideWhenStopped?: boolean
}

export type MediaOp =
	| {
			readonly family: "media"
			readonly kind: "insert"
			readonly slide: SlideRef
			readonly shape: ShapeNode
			readonly media: InsertedMedia
			readonly index?: number
	  }
	| { readonly family: "media"; readonly kind: "setPoster"; readonly target: ShapeRef; readonly poster: InsertedImage }
	| { readonly family: "media"; readonly kind: "setPlayback"; readonly target: ShapeRef; readonly playback: MediaPlayback }

export type NotesOp = {
	readonly family: "notes"
	readonly kind: "setNotes"
	readonly slide: SlideRef
	readonly body: TextBody
	readonly burst?: number
	readonly raw?: Uint8Array
}

export interface CommentModel {
	readonly id: string
	// An Author id of the deck (added when new).
	readonly author: string
	readonly text: string
	// ISO 8601.
	readonly created: string
	readonly anchor?: { readonly shape?: number; readonly x?: number; readonly y?: number }
	readonly resolved?: boolean
}

export type CommentOp =
	| {
			readonly family: "comment"
			readonly kind: "add"
			readonly slide: SlideRef
			readonly comment: CommentModel
			readonly authorName?: string
	  }
	| {
			readonly family: "comment"
			readonly kind: "reply"
			readonly slide: SlideRef
			readonly parent: string
			readonly comment: CommentModel
			readonly authorName?: string
	  }
	| { readonly family: "comment"; readonly kind: "edit"; readonly slide: SlideRef; readonly id: string; readonly text: string }
	| { readonly family: "comment"; readonly kind: "resolve"; readonly slide: SlideRef; readonly id: string; readonly resolved: boolean }
	| { readonly family: "comment"; readonly kind: "delete"; readonly slide: SlideRef; readonly id: string; readonly raw?: Uint8Array }

export interface EffectTiming {
	readonly start?: "click" | "with" | "after"
	readonly durationMs?: number
	readonly delayMs?: number
	readonly repeat?: number | "untilNextClick" | "untilEndOfSlide"
	readonly rewind?: boolean
	readonly autoReverse?: boolean
	readonly trigger?:
		| { readonly kind: "shapeClick"; readonly shape: number }
		| { readonly kind: "bookmark"; readonly shape: number; readonly bookmark: string }
}

export type TimingOp =
	// The whole tree of one slide (undefined removes p:timing); with `raw`, that source element.
	| {
			readonly family: "timing"
			readonly kind: "setTiming"
			readonly slide: SlideRef
			readonly timing: TimingTree | undefined
			readonly raw?: Uint8Array
	  }
	// One effect (a click/with/after group's par with its behaviours) placed at `at` in the main sequence.
	| { readonly family: "timing"; readonly kind: "addEffect"; readonly slide: SlideRef; readonly effect: TimeNode; readonly at?: number }
	| { readonly family: "timing"; readonly kind: "removeEffect"; readonly slide: SlideRef; readonly node: number }
	| { readonly family: "timing"; readonly kind: "moveEffect"; readonly slide: SlideRef; readonly node: number; readonly to: number }
	| {
			readonly family: "timing"
			readonly kind: "setEffectTiming"
			readonly slide: SlideRef
			readonly node: number
			readonly timing: EffectTiming
	  }
	| {
			readonly family: "timing"
			readonly kind: "setBehavior"
			readonly slide: SlideRef
			readonly node: number
			readonly behavior: Behavior
	  }

export type TransitionOp = {
	readonly family: "transition"
	readonly kind: "set"
	readonly slides: readonly SlideRef[]
	readonly transition: Transition | undefined
	// Per slide of `slides`, its p:transition (with its mc:AlternateContent) as it was.
	readonly raws?: readonly (Uint8Array | undefined)[]
}

export type MotionPathOp = {
	readonly family: "motionPath"
	readonly kind: "setPath"
	readonly slide: SlideRef
	// The animMotion behaviour's ctn id.
	readonly node: number
	// ECMA §19.5.4 path syntax, slide-relative.
	readonly path: string
	readonly origin?: "parent" | "layout"
	readonly pathEditMode?: "relative" | "fixed"
	readonly rAng?: number
}

// A theme of the Filen gallery by id and variant, or one the deck already has (by its part).
export type ThemeChoice =
	{ readonly kind: "gallery"; readonly id: string; readonly variant: number } | { readonly kind: "deck"; readonly part: string }

export type DesignOp =
	| {
			readonly family: "design"
			readonly kind: "setTheme"
			readonly theme: ThemeChoice
			readonly slides?: readonly SlideRef[]
			readonly raw?: readonly RawPart[]
	  }
	| { readonly family: "design"; readonly kind: "setVariant"; readonly master: SlideRef; readonly variant: number }
	// EMU; "maximize" or "ensureFit" scales content like PowerPoint's dialog.
	| {
			readonly family: "design"
			readonly kind: "setSize"
			readonly cx: number
			readonly cy: number
			readonly type?: string
			readonly scale: "maximize" | "ensureFit" | "none"
	  }
	| {
			readonly family: "design"
			readonly kind: "setBackground"
			readonly slides: readonly SlideRef[] | "all"
			readonly background: Background | undefined
			readonly hideGraphics?: boolean
			// Per slide of `slides` (a list), its p:bg as it was.
			readonly raws?: readonly (Uint8Array | undefined)[]
	  }

// A SmartArt layout, style or colours definition by its uniqueId: our gallery's, or the file's own embedded one.
export interface SmartArtDefRef {
	readonly uniqueId: string
	readonly source: "gallery" | "deck"
}

export type SmartArtOp =
	| {
			readonly family: "smartart"
			readonly kind: "insert"
			readonly slide: SlideRef
			readonly shape: ShapeNode
			readonly layout: SmartArtDefRef
			readonly texts: readonly string[]
	  }
	// `node`: a dgm:pt modelId.
	| { readonly family: "smartart"; readonly kind: "setNodeText"; readonly target: ShapeRef; readonly node: string; readonly text: string }
	| {
			readonly family: "smartart"
			readonly kind: "addNode"
			readonly target: ShapeRef
			readonly relativeTo: string
			readonly position: "before" | "after" | "above" | "below"
			readonly text?: string
			// The new pt's modelId (allocated by the page's mirror, so the next op can name it).
			readonly id?: string
	  }
	| { readonly family: "smartart"; readonly kind: "removeNode"; readonly target: ShapeRef; readonly node: string }
	| { readonly family: "smartart"; readonly kind: "promote" | "demote"; readonly target: ShapeRef; readonly node: string }
	| {
			readonly family: "smartart"
			readonly kind: "moveNode"
			readonly target: ShapeRef
			readonly node: string
			readonly direction: "up" | "down"
	  }
	| {
			readonly family: "smartart"
			readonly kind: "setLayout" | "setStyle" | "setColors"
			readonly target: ShapeRef
			readonly def: SmartArtDefRef
	  }
	// The diagram's parts as they were (the inverse of any of the above).
	| { readonly family: "smartart"; readonly kind: "restore"; readonly target: ShapeRef; readonly parts: readonly RawPart[] }

// One pen or highlighter stroke: x, y pairs in slide EMU.
export interface InkStroke {
	readonly points: Float64Array
	// EMU.
	readonly width: number
	readonly color: ColorModel
	readonly highlighter: boolean
}

export type InkOp = {
	readonly family: "ink"
	readonly kind: "add"
	readonly slide: SlideRef
	readonly strokes: readonly InkStroke[]
	// The group's name (from the locale), and its id when the page allocated one.
	readonly name: string
	readonly id?: number
}

export type MediaTimingOp =
	| {
			readonly family: "mediaTiming"
			readonly kind: "setTrim"
			readonly target: ShapeRef
			readonly startMs: number
			readonly endMs: number
	  }
	| { readonly family: "mediaTiming"; readonly kind: "setFade"; readonly target: ShapeRef; readonly inMs: number; readonly outMs: number }
	| {
			readonly family: "mediaTiming"
			readonly kind: "addBookmark"
			readonly target: ShapeRef
			readonly name: string
			readonly timeMs: number
	  }
	| { readonly family: "mediaTiming"; readonly kind: "removeBookmark"; readonly target: ShapeRef; readonly name: string }

// Several ops as one step, applied in order and all or nothing: a refusal undoes the ones before it, in reverse,
// and refuses the batch. Its inverse is its ops' inverses, the last op's first.
export interface BatchOp {
	readonly family: "batch"
	readonly kind: "batch"
	readonly ops: readonly DeckOp[]
}

// One family's op (every op but a batch).
export type FamilyOp =
	| SlideOp
	| ShapeOp
	| TextOp
	| TableOp
	| PictureOp
	| ChartOp
	| MediaOp
	| NotesOp
	| CommentOp
	| TimingOp
	| TransitionOp
	| MotionPathOp
	| DesignOp
	| SmartArtOp
	| InkOp
	| MediaTimingOp

export type DeckOp = FamilyOp | BatchOp

export type OpOf<F extends DeckOpFamily> = Extract<DeckOp, { readonly family: F }>
