import type { Rgba } from "../drawingml/index"
import type { ColorModel, ShapeRef, SlideNode, SlideRef, SourceRef } from "../presentation/model"

// Timing and transitions, format-neutral (ECMA-376 §19.5 and §19.3.1.50; ODF SMIL animations map onto the same
// tree). The player follows the tree, never the presetID: presets label the pane and feed authoring only.
// Times are ms; "indefinite" waits for an event.

export type TimeValue = number | "indefinite"

export interface TimingTree {
	root: TimeNode
	// p:bldLst.
	builds: Build[]
	src?: SourceRef
}

export type TimeNodeKind = "par" | "seq" | "excl"

export type TimeNodeType =
	"clickEffect" | "withEffect" | "afterEffect" | "mainSeq" | "interactiveSeq" | "clickPar" | "withGroup" | "afterGroup" | "tmRoot"

export type PresetClass = "entr" | "exit" | "emph" | "path" | "verb" | "mediacall"

export interface CommonTimeNode {
	id: number
	presetID?: number
	presetClass?: PresetClass
	presetSubtype?: number
	// An ODF preset id and subtype with no ECMA number (another application's names), as written.
	presetName?: string
	presetSubtypeName?: string
	nodeType?: TimeNodeType
	grpId?: number
	fill?: "remove" | "freeze" | "hold" | "transition"
	restart?: "always" | "whenNotActive" | "never"
	dur?: TimeValue
	// 1/1000 of a repetition (ST_TLTimeNodeRepeatCount), or indefinite.
	repeatCount?: TimeValue
	repeatDur?: TimeValue
	// 1/100,000.
	spd?: number
	accel?: number
	decel?: number
	autoRev?: boolean
	syncBehavior?: "canSlip" | "locked"
	masterRel?: "sameClick" | "lastClick" | "nextClick"
	stCondLst: TimeCondition[]
	endCondLst: TimeCondition[]
	endSync?: TimeCondition
	iterate?: {
		readonly type: "el" | "wd" | "lt"
		readonly interval: { readonly ms: number } | { readonly pct: number }
		readonly backwards: boolean
	}
	// seq only.
	nextAc?: "none" | "seek"
	prevAc?: "none" | "skipTimed"
	concurrent?: boolean
	prevCondLst?: TimeCondition[]
	nextCondLst?: TimeCondition[]
	children: TimeNode[]
	// p:subTnLst: nodes played relative to this one by their masterRel (after-effects such as dim or hide, and their
	// sounds), read for playback and written back from the model where the source has none.
	subTnLst?: TimeNode[]
	src?: SourceRef
	// The node's source element as bytes, held by an inverse after a save took that element out of the file: written
	// as it was while the node has no live source.
	raw?: Uint8Array
}

export type TimeEventName =
	| "onBegin"
	| "onEnd"
	| "begin"
	| "end"
	| "onClick"
	| "onDblClick"
	| "onMouseOver"
	| "onMouseOut"
	| "onNext"
	| "onPrev"
	| "onStopAudio"
	| "onMediaBookmark"

export interface TimeCondition {
	readonly evt?: TimeEventName
	readonly delay: TimeValue
	readonly tgtEl?: AnimTarget
	// p:tn: a time node by id.
	readonly tn?: number
	readonly rtn?: "first" | "last" | "all"
	readonly bookmark?: string
}

// A time node: a container (par/seq/excl) or a behaviour.
export type TimeNode =
	| { readonly kind: TimeNodeKind; readonly ctn: CommonTimeNode }
	| { readonly kind: "behavior"; readonly behavior: Behavior; readonly ctn: CommonTimeNode }

export interface BehaviorCommon {
	readonly target: AnimTarget
	readonly attrNames: readonly string[]
	readonly additive?: "base" | "sum" | "repl" | "mult" | "none"
	readonly accumulate?: "none" | "always"
	readonly override?: "normal" | "childStyle"
	readonly xfrmType?: "pt" | "img"
	readonly from?: string
	readonly to?: string
	readonly by?: string
	readonly rctx?: string
}

export interface TimeAnimateValue {
	// 1/100,000 of the duration, or indefinite.
	readonly tm: TimeValue
	readonly fmla?: string
	readonly val?: string | number | boolean | ColorModel
}

export type Behavior =
	| {
			readonly type: "anim"
			readonly common: BehaviorCommon
			readonly tavLst: readonly TimeAnimateValue[]
			readonly calcmode?: "discrete" | "lin" | "fmla"
			readonly valueType?: "str" | "num" | "clr"
	  }
	| {
			readonly type: "animClr"
			readonly common: BehaviorCommon
			readonly clrSpc: "rgb" | "hsl"
			readonly dir?: "cw" | "ccw"
			readonly by?: ColorModel | { readonly h: number; readonly s: number; readonly l: number }
			readonly from?: ColorModel
			readonly to?: ColorModel
	  }
	| {
			readonly type: "animEffect"
			readonly common: BehaviorCommon
			readonly transition?: "in" | "out" | "none"
			readonly filter?: string
			readonly prLst?: string
	  }
	| {
			readonly type: "animMotion"
			readonly common: BehaviorCommon
			// ECMA §19.5.4 path syntax, slide-relative.
			readonly path?: string
			readonly origin?: "parent" | "layout"
			readonly pathEditMode?: "relative" | "fixed"
			readonly rAng?: number
			readonly rCtr?: { readonly x: number; readonly y: number }
			readonly ptsTypes?: string
	  }
	| { readonly type: "animRot"; readonly common: BehaviorCommon; readonly by?: number; readonly from?: number; readonly to?: number }
	| {
			readonly type: "animScale"
			readonly common: BehaviorCommon
			readonly zoomContents?: boolean
			readonly by?: { readonly x: number; readonly y: number }
			readonly from?: { readonly x: number; readonly y: number }
			readonly to?: { readonly x: number; readonly y: number }
	  }
	| { readonly type: "set"; readonly common: BehaviorCommon; readonly to?: string | number | boolean | ColorModel }
	| { readonly type: "cmd"; readonly common: BehaviorCommon; readonly cmdType: "evt" | "call" | "verb"; readonly cmd: string }
	| {
			readonly type: "audio" | "video"
			readonly target: AnimTarget
			readonly vol?: number
			readonly mute?: boolean
			readonly numSld?: number
			readonly showWhenStopped?: boolean
			readonly fullScrn?: boolean
			readonly isNarration?: boolean
	  }

export type AnimTarget =
	| { readonly kind: "shape"; readonly shape: number }
	| { readonly kind: "text"; readonly shape: number; readonly unit: "para" | "char"; readonly start: number; readonly end: number }
	| { readonly kind: "graphic"; readonly shape: number; readonly part: "dgm" | "chart"; readonly id: string; readonly bldStep?: string }
	| { readonly kind: "bg"; readonly shape: number }
	| { readonly kind: "subShape"; readonly shape: number; readonly subShape: string }
	| { readonly kind: "sound"; readonly embed?: string; readonly name?: string }
	| { readonly kind: "ink"; readonly shape: number }
	| { readonly kind: "slide" }

// A build entry's source element, and (held by an inverse after a save took that element out of the file) its bytes,
// written as they were while it has no live source.
export interface BuildSource {
	readonly src?: SourceRef
	readonly raw?: Uint8Array
}

export type Build = BuildSource &
	(
		| {
				readonly kind: "bldP"
				readonly shape: number
				readonly grpId: number
				readonly build?: "whole" | "p" | "cust" | "allAtOnce"
				readonly bldLvl?: number
				readonly animBg?: boolean
				readonly rev?: boolean
				readonly autoUpdateAnimBg?: boolean
		  }
		| { readonly kind: "bldDgm"; readonly shape: number; readonly grpId: number; readonly bld?: string }
		| { readonly kind: "bldOleChart"; readonly shape: number; readonly grpId: number; readonly bld?: string; readonly animBg?: boolean }
		| { readonly kind: "bldGraphic"; readonly shape: number; readonly grpId: number; readonly whole: boolean; readonly bld?: string }
	)

export interface Transition {
	// An ECMA name (fade, push, wipe…), a p14 name (vortex, ripple…), a p15 prstTrans preset, or morph.
	kind: string
	namespace: "p" | "p14" | "p15" | "morph"
	// dir, orient, pattern, invX, invY, thruBlk… as written.
	options: { readonly [name: string]: string | number | boolean }
	durationMs?: number
	speed?: "slow" | "med" | "fast"
	advance: { onClick: boolean; afterMs?: number }
	sound?: { readonly kind: "embedded"; readonly part: string; readonly name?: string; readonly loop: boolean } | { readonly kind: "stop" }
	// The file's own mc:Fallback, kept for playback without a renderer for `kind` and re-emitted unchanged.
	fallback?: SourceRef
	src?: SourceRef
}

// The compiled, event-driven engine (core/anim/timegraph.ts implements it). State depends on the event history
// (interactive sequences, onNext ends, nextAc="seek", restart, bookmarks), so sampling is pure for a given event
// log and time.

export interface CompiledTimegraph {
	readonly slide: SlideRef
	readonly mainSteps: number
	readonly interactive: readonly { readonly trigger: ShapeRef; readonly seq: number }[]
	readonly tracks: readonly Track[]
	// What a realm that plays the graph compiles its own from (compile() output never crosses a realm boundary).
	readonly source?: TimegraphSource
}

// A slide's timing as the worker resolved it, for compile() where the graph plays (compileSource).
export interface TimegraphSource {
	readonly timing: TimingTree | undefined
	readonly layers: LayerIndex
	// Per layer of `layers`, the layer it moves with (a paragraph range its shape's, a shape its nearest animated
	// group's), -1 for none: the player composes a layer's state after its parent's.
	readonly parents: Int32Array
	// EMU.
	readonly slideSize: { readonly cx: number; readonly cy: number }
	// Per shape the timing targets: id, x, y, cx, cy (EMU, as rendered: inherited placeholder boxes included).
	readonly geometry: Float64Array
	// animClr/set colours resolved against the slide's theme and colour map: [JSON.stringify(ColorModel), Rgba].
	readonly colors: readonly (readonly [string, Rgba])[]
	// The transition the slide is entered with (as the player draws it: a kind it does not draw is its fallback).
	readonly transition?: Transition
	// The slide's own transition when the player draws its fallback instead (a p14/p15 kind without a renderer).
	readonly authored?: Transition
}

// One animated attribute of one layer over one behaviour's active interval.
export interface Track {
	// Index into the LayerIndex the graph was compiled with.
	readonly layer: number
	// The ctn id of the behaviour.
	readonly node: number
	readonly attribute: string
	readonly kind: "value" | "color" | "motion" | "rotation" | "scale" | "set" | "filter" | "command" | "media"
	// Text sub-range for paragraph or character builds.
	readonly range?: { readonly unit: "para" | "char"; readonly start: number; readonly end: number }
}

export type TimeEvent =
	| { readonly kind: "slideBegin" }
	| { readonly kind: "next" }
	| { readonly kind: "prev" }
	| { readonly kind: "click"; readonly shape: number }
	| { readonly kind: "dblClick"; readonly shape: number }
	| { readonly kind: "hover"; readonly shape: number; readonly entered: boolean }
	| { readonly kind: "mediaBookmark"; readonly shape: number; readonly bookmark: string }
	| { readonly kind: "mediaEnd"; readonly shape: number }

// A layer's sampled state, routed per the attribute matrix (core/anim/attributes.ts).
export interface LayerState {
	readonly layer: number
	readonly visible: boolean
	readonly opacity: number
	// Compositor transform on the layer bitmap (a b c d e f, slide px).
	readonly matrix: readonly number[]
	// An animEffect filter in progress.
	readonly filter?: { readonly name: string; readonly progress: number; readonly reverse: boolean }
	// The layer switches to its SVG/DOM painter for colour and text attributes.
	readonly dom?: {
		readonly fill?: Rgba
		readonly stroke?: Rgba
		readonly textColor?: Rgba
		readonly fontWeight?: number
		readonly fontStyle?: "normal" | "italic"
		readonly underline?: boolean
	}
	// A sampled font size (points) the layer's text is laid out again at.
	readonly fontSize?: number
	// toggle: play when paused or stopped, else pause (a togglePause call). `activation`: when the command's node began
	// (graph ms), so each trigger activation is a new command even when it says the same.
	readonly media?: {
		readonly command: "play" | "pause" | "stop" | "resume" | "seek" | "toggle"
		readonly atMs?: number
		readonly activation?: number
	}
}

// Opaque to callers: restore() takes back what snapshot() gave.
export interface TimegraphSnapshot {
	readonly step: number
	readonly state: Uint8Array
}

export interface TimegraphInstance {
	// click, next, prev, shape click/hover, media bookmark/end, slide begin.
	fire(event: TimeEvent, atMs: number): void
	// Pure for a given event log and t.
	sample(tMs: number): LayerState[]
	// Taken at each main-sequence step boundary.
	snapshot(): TimegraphSnapshot
	// "previous" restores the boundary snapshot.
	restore(snapshot: TimegraphSnapshot): void
	// For timed advance and afterEffect scheduling: the first begin or end after `after` (default: the last event's
	// time).
	nextActivation(after?: number): number | undefined
}

// The slide's layers as the graph addresses them: per layer, its shape and its text sub-range when the layer is
// one paragraph or character run of a built body.
export interface LayerIndex {
	readonly shapes: Int32Array
	readonly ranges?: readonly ({ readonly unit: "para" | "char"; readonly start: number; readonly end: number } | undefined)[]
	// Per layer that is a run of a by-letter or by-word build (a "char" range; [-1, -1] is its shape's drawing without
	// the text, played as the build's first element), RUN_INTS ints: its paragraph, its first letter's ordinal in that
	// paragraph, its letter count, its first word's ordinal, its word count; -1s for every other layer.
	readonly runs?: Int32Array
	// Per layer, its own box (EMU: x, y, cx, cy) when it is not its shape's (a run's glyphs); NaN otherwise.
	readonly boxes?: Float64Array
}

// The timing budgets of a hostile deck (values in core/presentation/budget.ts); exceeding one refuses `tooLarge`
// or `tooDeep`.
export interface TimingBudgets {
	readonly nodesPerSlide: number
	readonly depth: number
	readonly motionSegments: number
	// repeatCount × dur is capped at this much schedule.
	readonly scheduleMs: number
	readonly eventsPerShow: number
}

export interface TimegraphEngine {
	compile(slide: SlideNode, layers: LayerIndex, budgets: TimingBudgets): CompiledTimegraph
	instantiate(graph: CompiledTimegraph): TimegraphInstance
}
