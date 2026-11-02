import { appendAll } from "../../../arrays"
import type { AnimTarget, Behavior, Build, TimeCondition, TimeNode, TimingTree } from "../../../anim/model"
import { isMediaBehavior } from "../../../anim/attributes"
import { withoutTargets } from "../../../anim/prune"
import {
	IdAllocator,
	readSequences,
	timedEffect,
	usedIds,
	withStart,
	writeSequences,
	type EffectSequence,
	type SequenceEffect,
	type EffectStart,
	type EffectTrigger,
	type SlideSequences
} from "../../../anim/presets/effects/index"
import {
	refused,
	type Deck,
	type Paragraph,
	type Refused,
	type ShapeNode,
	type SlideNode,
	type SourceRef,
	type TextBody
} from "../../model"
import type { ApplyContext, ApplyFamily, ApplyResult, Inverse, Touch } from "../apply"
import { cloneModel, digestOf } from "../changes"
import type { EffectTiming, OpOf, TimingOp } from "../ops"

// Applies the timing ops to the model. setTiming sets a slide's timing whole. The effect ops author one effect of a
// slide's sequences (core/anim/presets/effects/sequence.ts): add one where it plays, remove it, move it within its
// sequence, change its timing (start, delay, duration, repeat, rewind, trigger) or one of its behaviours. Effects are
// addressed by their effect par's ctn id; an inverse that puts an effect back holds its source element's bytes, so
// an undo after a save's rebase writes it as it was.
//
// A tree whose nodes carry held markup (`ctn.raw`, what a shape delete's inverse holds for each subtree it took out) is
// a restore, not a replacement: those subtrees go back into the slide's timing as it is now, each at its place among
// its siblings, and every other node stays the live one (its source, so the writer keeps its span). A put-back subtree
// keeps its source while that still reads, else it is written from the held bytes. A tree whose root carries held
// markup is put back whole (heldWhole): each node keeps its source while that reads, else a node with held bytes is
// written from them and the rest from the model.
//
// Every effect op's inverse puts the slide's timing back whole, so an undo writes the file's own bytes, before a save
// and after one. A text edit that adds or deletes paragraphs of a body its timing animates by paragraph remaps those
// effects by paragraph identity (remapParagraphs, part of the text op).

function sourceReads(src: SourceRef | undefined, context: ApplyContext): boolean {
	return src !== undefined && context.sourceBytes(src) instanceof Uint8Array
}

function isRestore(node: TimeNode): boolean {
	return node.ctn.raw !== undefined || node.ctn.children.some(isRestore)
}

// A held subtree as it goes back: its sources when they still read (the held bytes then dropped), else none.
function putBack(node: TimeNode, context: ApplyContext): TimeNode {
	const copy = cloneModel(node)
	const strip = (time: TimeNode, keepSource: boolean): void => {
		if (!keepSource) delete time.ctn.src
		if (time !== copy || keepSource) delete time.ctn.raw

		for (const child of time.ctn.children) strip(child, keepSource)
	}

	strip(copy, (copy.ctn.raw?.length ?? 0) === 0 || sourceReads(copy.ctn.src, context))

	return copy
}

// `held`'s put-back subtrees merged into `live` (the same tree without them); a structure that differs refuses.
function merge(held: TimeNode, live: TimeNode, context: ApplyContext): TimeNode | Refused {
	if (held.kind !== live.kind) return refused("stale", `timing node ${String(held.ctn.id)} changed since`)

	const children: TimeNode[] = []
	let at = 0

	for (const child of held.ctn.children) {
		if (child.ctn.raw !== undefined) {
			children.push(putBack(child, context))

			continue
		}

		const now = live.ctn.children[at++]

		if (now === undefined) return refused("stale", `timing node ${String(child.ctn.id)} is gone`)

		const merged = merge(child, now, context)

		if ("reason" in merged) return merged

		children.push(merged)
	}

	if (at !== live.ctn.children.length) return refused("stale", `timing node ${String(live.ctn.id)} gained children`)

	// The live node with the condition lists the delete took references out of.
	return {
		...live,
		ctn: {
			...live.ctn,
			stCondLst: held.ctn.stCondLst,
			endCondLst: held.ctn.endCondLst,
			...(held.ctn.prevCondLst === undefined ? {} : { prevCondLst: held.ctn.prevCondLst }),
			...(held.ctn.nextCondLst === undefined ? {} : { nextCondLst: held.ctn.nextCondLst }),
			children
		}
	} as TimeNode
}

// Whether a source ref still reads, asked once per document and epoch (refs of one epoch read alike).
function liveness(context: ApplyContext): (src: SourceRef | undefined) => boolean {
	const memo = new Map<string, boolean>()

	return src => {
		if (src === undefined) return false

		const key = `${src.format}\u0000${src.part}\u0000${src.format === "odp" ? String(src.fragment) : ""}\u0000${String(src.epoch)}`
		let reads = memo.get(key)

		if (reads === undefined) {
			reads = sourceReads(src, context)
			memo.set(key, reads)
		}

		return reads
	}
}

// A tree held whole put back: each node on its source while that reads; else one with held bytes written from them
// (what is under it with them), the rest from the model.
function putWhole(held: TimingTree, context: ApplyContext): TimingTree {
	const copy = cloneModel(held)
	const reads = liveness(context)
	const visit = (node: TimeNode, covered: boolean): void => {
		const ctn = node.ctn
		const raw = ctn.raw
		let under = covered

		if (!covered && raw !== undefined && raw.length > 0 && !reads(ctn.src)) {
			delete ctn.src
			under = true
		} else {
			delete ctn.raw

			if (!reads(ctn.src)) delete ctn.src
		}

		for (const child of ctn.children) visit(child, under)
		for (const child of ctn.subTnLst ?? []) visit(child, under)
	}

	visit(copy.root, false)

	const builds = copy.builds.map(build => {
		const { raw, src, ...rest } = build

		if (reads(src)) return { ...rest, src } as Build

		return (raw !== undefined && raw.length > 0 ? { ...rest, raw } : rest) as Build
	})

	return { root: copy.root, builds, ...(reads(copy.src) ? { src: copy.src } : {}) }
}

function restored(held: TimingTree, live: TimingTree | undefined, context: ApplyContext): TimingTree | Refused {
	if (held.root.ctn.raw !== undefined) return putWhole(held, context)
	if (live === undefined) return refused("stale", "the slide's timing changed since")

	const root = merge(cloneModel(held.root), live.root, context)

	if ("reason" in root) return root

	return { root, builds: cloneModel(held.builds), ...(live.src === undefined ? {} : { src: live.src }) }
}

function setTiming(deck: Deck, op: OpOf<"timing"> & { kind: "setTiming" }, context: ApplyContext): ApplyResult<typeof op> {
	const node = deck.nodes.get(op.slide)

	if (node === undefined) return refused("notFound", `slide ${String(op.slide)}`)

	let next: TimingTree | undefined

	if (op.timing !== undefined && isRestore(op.timing.root)) {
		const tree = restored(op.timing, node.timing, context)

		if ("reason" in tree) return tree

		next = tree
	} else if (op.timing !== undefined) {
		// A whole tree read before a save names spans the new file does not have.
		const src = op.timing.src ?? op.timing.root.ctn.src

		if (src !== undefined && !sourceReads(src, context)) return refused("stale", `timing read from ${src.part}`)

		// The history keeps the op's tree: the slide gets its own copy.
		next = cloneModel(op.timing)
	}

	const prior = node.timing

	if (next === undefined) delete node.timing
	else node.timing = next

	node.revision++

	return {
		kind: "applied",
		inverse: { ops: [{ family: "timing", kind: "setTiming", slide: op.slide, timing: prior }], bytes: 0 },
		op
	}
}

// --- Inverses that put the timing back whole ---

// Every node of a tree, after-effect nodes included.
function nodesOf(tree: TimingTree | undefined): Set<TimeNode> {
	const out = new Set<TimeNode>()
	const stack = tree === undefined ? [] : [tree.root]

	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		out.add(node)
		appendAll(stack, node.ctn.children)
		appendAll(stack, node.ctn.subTnLst ?? [])
	}

	return out
}

type Role = "root" | "seq" | "click" | "group"

const CHILD_ROLE: Readonly<Record<Role, Role | undefined>> = { root: "seq", seq: "click", click: "group", group: undefined }

// `prior` (the slide's timing before a step) as the step's inverse holds it, put back whole (setTiming): a node the step
// left in the live tree is that node (a save's rebase rebinds it with the live tree); a sequence container (the root,
// a sequence, a click or group par) the step replaced is a copy of it, written from the model once its source is gone;
// every other node it replaced or took out (an effect, a media node) carries its source element's bytes, written as
// they were once a save took that element out. The root carries the (empty) mark of a tree put back whole.
function heldWhole(
	prior: TimingTree,
	live: TimingTree | undefined,
	context: ApplyContext
): { readonly timing: TimingTree; readonly bytes: number } {
	const kept = nodesOf(live)
	let bytes = 0
	const hold = (node: TimeNode): TimeNode => {
		if (kept.has(node)) return node

		const source = node.ctn.src === undefined ? undefined : context.sourceBytes(node.ctn.src)
		const raw = source instanceof Uint8Array ? source : node.ctn.raw

		if (raw === undefined || raw.length === 0) return node

		bytes += raw.length

		return { ...node, ctn: { ...node.ctn, raw } } as TimeNode
	}
	const copy = (node: TimeNode, role: Role): TimeNode => {
		if (role !== "root" && kept.has(node)) return node

		const next = CHILD_ROLE[role]
		const children = node.ctn.children.map(child =>
			next !== undefined && (next === "seq" ? child.kind === "seq" : child.kind === "par") ? copy(child, next) : hold(child)
		)

		return { ...node, ctn: { ...node.ctn, children, ...(role === "root" ? { raw: new Uint8Array(0) } : {}) } } as TimeNode
	}
	const liveBuilds = new Set(live?.builds ?? [])
	const builds = prior.builds.map(build => {
		if (liveBuilds.has(build) || build.src === undefined) return build

		const source = context.sourceBytes(build.src)

		if (!(source instanceof Uint8Array)) return build

		bytes += source.length

		return { ...build, raw: source }
	})

	return { timing: { ...prior, root: copy(prior.root, "root"), builds }, bytes }
}

function wholeInverse(slide: SlideNode, prior: TimingTree | undefined, context: ApplyContext): Inverse {
	if (prior === undefined) return { ops: [{ family: "timing", kind: "setTiming", slide: slide.ref, timing: undefined }], bytes: 0 }

	const held = heldWhole(prior, slide.timing, context)

	return { ops: [{ family: "timing", kind: "setTiming", slide: slide.ref, timing: held.timing }], bytes: held.bytes }
}

// --- Effect ops ---

type Placed = { readonly sequence: EffectSequence; readonly index: number }

function find(sequences: SlideSequences, id: number): Placed | undefined {
	for (const sequence of [sequences.main, ...sequences.interactive]) {
		const index = sequence.effects.findIndex(effect => effect.node.ctn.id === id)

		if (index >= 0) return { sequence, index }
	}

	return undefined
}

function sequenceFor(sequences: SlideSequences, trigger: EffectTrigger | undefined): EffectSequence {
	if (trigger === undefined) return sequences.main

	const found = sequences.interactive.find(sequence => sequence.trigger?.shape === trigger.shape)

	if (found !== undefined) return found

	const made: EffectSequence = { trigger, effects: [], clicks: [] }

	sequences.interactive.push(made)

	return made
}

function startOf(effect: TimeNode): EffectStart {
	return effect.ctn.nodeType === "withEffect" ? "with" : effect.ctn.nodeType === "afterEffect" ? "after" : "click"
}

function targetOf(node: TimeNode): AnimTarget | undefined {
	if (node.kind === "behavior") return isMediaBehavior(node.behavior) ? node.behavior.target : node.behavior.common.target

	for (const child of node.ctn.children) {
		const target = targetOf(child)

		if (target !== undefined) return target
	}

	return undefined
}

function shapeOf(effect: TimeNode): number | undefined {
	const target = targetOf(effect)

	return target === undefined || target.kind === "slide" || target.kind === "sound" ? undefined : target.shape
}

function buildKey(shape: number, grpId: number): string {
	return `${String(shape)}:${String(grpId)}`
}

function effectKeys(sequences: SlideSequences): Set<string> {
	const out = new Set<string>()

	for (const sequence of [sequences.main, ...sequences.interactive]) {
		for (const { node } of sequence.effects) {
			const shape = shapeOf(node)

			if (shape !== undefined) out.add(buildKey(shape, node.ctn.grpId ?? 0))
		}
	}

	return out
}

function findShape(shapes: readonly ShapeNode[], id: number): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.id === id) return shape

		const inner = shape.children === undefined ? undefined : findShape(shape.children, id)

		if (inner !== undefined) return inner
	}

	return undefined
}

function hasText(shape: ShapeNode | undefined): boolean {
	return shape?.text?.paragraphs.some(paragraph => paragraph.runs.length > 0) === true
}

// The build list after an op: builds of a shape and group no effect plays any more go (PowerPoint keeps none), and
// an effect added on a shape's text gets the build PowerPoint writes for it (by paragraph, or the text as one object).
function buildsAfter(slide: SlideNode, before: ReadonlySet<string>, sequences: SlideSequences, added: TimeNode | undefined): Build[] {
	const after = effectKeys(sequences)
	const builds = sequences.builds.filter(build => {
		const key = buildKey(build.shape, build.grpId)

		return !before.has(key) || after.has(key)
	})
	const target = added === undefined ? undefined : targetOf(added)

	if (added !== undefined && target !== undefined && (target.kind === "text" || target.kind === "shape")) {
		const grpId = added.ctn.grpId ?? 0
		const key = buildKey(target.shape, grpId)
		const shape = findShape(slide.shapes, target.shape)

		if (!builds.some(build => buildKey(build.shape, build.grpId) === key) && shape?.kind === "sp" && hasText(shape)) {
			builds.push(
				target.kind === "text"
					? { kind: "bldP", shape: target.shape, grpId, build: "p" }
					: { kind: "bldP", shape: target.shape, grpId, animBg: true }
			)
		}
	}

	return builds
}

// `next` with the markup held by its changed nodes let go: a node an edit made anew (a copy with other children, targets
// or start) is written from the model, never from bytes of what it was. Nodes the edit kept are `prior`'s own.
function withoutStaleHeld(prior: TimingTree | undefined, next: TimingTree): TimingTree {
	const kept = nodesOf(prior)
	const visit = (node: TimeNode): TimeNode => {
		if (kept.has(node)) return node

		const ctn = node.ctn
		const children = ctn.children.map(visit)
		const subs = ctn.subTnLst?.map(visit)
		const same =
			ctn.raw === undefined &&
			children.every((child, k) => child === ctn.children[k]) &&
			(subs === undefined || subs.every((child, k) => child === ctn.subTnLst?.[k]))

		if (same) return node

		const { raw: _held, ...rest } = ctn

		return { ...node, ctn: { ...rest, children, ...(subs === undefined ? {} : { subTnLst: subs }) } } as TimeNode
	}
	const root = visit(next.root)

	return root === next.root ? next : { ...next, root }
}

function setTree(slide: SlideNode, tree: TimingTree | undefined): void {
	if (tree === undefined) delete slide.timing
	else slide.timing = withoutStaleHeld(slide.timing, tree)

	slide.revision++
}

interface Authoring {
	readonly format: Deck["format"]
	readonly slide: SlideNode
	readonly sequences: SlideSequences
	readonly ids: IdAllocator
	readonly keys: ReadonlySet<string>
}

function authoring(deck: Deck, op: { readonly slide: OpOf<"timing">["slide"] }): Authoring | Refused {
	const slide = deck.nodes.get(op.slide)

	if (slide === undefined) return refused("notFound", `slide ${String(op.slide)}`)

	const sequences = readSequences(slide.timing)

	if ("kind" in sequences) return refused("unsupported", sequences.detail)

	return {
		format: deck.format,
		slide,
		sequences,
		ids: new IdAllocator(slide.timing === undefined ? new Set() : usedIds(slide.timing.root)),
		keys: effectKeys(sequences)
	}
}

function commit(state: Authoring, added?: TimeNode): void {
	const sequences: SlideSequences = { ...state.sequences, builds: buildsAfter(state.slide, state.keys, state.sequences, added) }

	setTree(state.slide, writeSequences(sequences, state.ids, state.format === "odp" ? "delay" : "node"))
}

// An effect going into the tree: its ids made unique on the slide (the op as applied names them), and a held effect
// back on its source while that still reads, else written from its bytes.
function placed(effect: TimeNode, state: Authoring, context: ApplyContext): TimeNode {
	const copy = cloneModel(effect)
	const ids = state.ids
	const renumber = (node: TimeNode): void => {
		if (node.ctn.id <= 0 || ids.has(node.ctn.id)) node.ctn.id = ids.take()
		else ids.add(node.ctn.id)

		for (const child of node.ctn.children) renumber(child)
		for (const child of node.ctn.subTnLst ?? []) renumber(child)
	}

	renumber(copy)

	if (copy.ctn.raw !== undefined) {
		const live = sourceReads(copy.ctn.src, context)
		const strip = (node: TimeNode, root: boolean): void => {
			if (live) delete node.ctn.raw
			else {
				delete node.ctn.src

				if (!root) delete node.ctn.raw
			}

			for (const child of node.ctn.children) strip(child, false)
			for (const child of node.ctn.subTnLst ?? []) strip(child, false)
		}

		strip(copy, true)
	}

	if (copy.ctn.grpId === undefined) {
		const shape = shapeOf(copy)
		let next = 0

		for (const sequence of [state.sequences.main, ...state.sequences.interactive]) {
			for (const { node } of sequence.effects)
				if (shape !== undefined && shapeOf(node) === shape) next = Math.max(next, (node.ctn.grpId ?? 0) + 1)
		}

		copy.ctn.grpId = next
	}

	return copy
}

function triggerOfOp(trigger: EffectTiming["trigger"]): EffectTrigger | undefined | Refused {
	if (trigger === undefined || trigger.kind === "none") return undefined
	if (trigger.kind === "bookmark") return refused("unsupported", "media bookmark triggers")

	return { kind: "shapeClick", shape: trigger.shape }
}

function clamp(at: number | undefined, length: number): number {
	return at === undefined || !Number.isFinite(at) ? length : Math.max(0, Math.min(length, Math.trunc(at)))
}

function addEffect(deck: Deck, op: OpOf<"timing"> & { kind: "addEffect" }, context: ApplyContext): ApplyResult<typeof op> {
	const state = authoring(deck, op)

	if ("reason" in state) return state

	const trigger = triggerOfOp(op.trigger)

	if (trigger !== undefined && "reason" in trigger) return trigger

	// A master's field the slide shows (ODP) is not the slide's to animate: the file could not name it.
	const animated = shapeOf(op.effect)
	const owner = animated === undefined ? undefined : findShape(state.slide.shapes, animated)

	if (owner?.lock === "master") return refused("locked", owner.lock)

	const effect = placed(op.effect, state, context)
	const sequence = sequenceFor(state.sequences, trigger)
	const prior = state.slide.timing

	sequence.effects.splice(clamp(op.at, sequence.effects.length), 0, { node: effect, start: startOf(effect) })
	commit(state, effect)

	return { kind: "applied", inverse: wholeInverse(state.slide, prior, context), op: { ...op, effect: cloneModel(effect) } }
}

function removeEffect(deck: Deck, op: OpOf<"timing"> & { kind: "removeEffect" }, context: ApplyContext): ApplyResult<typeof op> {
	const state = authoring(deck, op)

	if ("reason" in state) return state

	const where = find(state.sequences, op.node)

	if (where === undefined) return refused("notFound", `effect ${String(op.node)}`)

	const prior = state.slide.timing

	where.sequence.effects.splice(where.index, 1)
	commit(state)

	return { kind: "applied", inverse: wholeInverse(state.slide, prior, context), op }
}

function moveEffect(deck: Deck, op: OpOf<"timing"> & { kind: "moveEffect" }, context: ApplyContext): ApplyResult<typeof op> {
	const state = authoring(deck, op)

	if ("reason" in state) return state

	const where = find(state.sequences, op.node)

	if (where === undefined) return refused("notFound", `effect ${String(op.node)}`)

	const effects = where.sequence.effects
	const [moving] = effects.splice(where.index, 1)
	const to = clamp(op.to, effects.length)

	if (moving === undefined) return refused("notFound", `effect ${String(op.node)}`)

	const prior = state.slide.timing

	effects.splice(to, 0, moving)
	commit(state)

	return { kind: "applied", inverse: wholeInverse(state.slide, prior, context), op: { ...op, to } }
}

function setEffectTiming(deck: Deck, op: OpOf<"timing"> & { kind: "setEffectTiming" }, context: ApplyContext): ApplyResult<typeof op> {
	const state = authoring(deck, op)

	if ("reason" in state) return state

	const where = find(state.sequences, op.node)
	const current = where?.sequence.effects[where.index]

	if (where === undefined || current === undefined) return refused("notFound", `effect ${String(op.node)}`)

	const trigger = triggerOfOp(op.timing.trigger)

	if (trigger !== undefined && "reason" in trigger) return trigger

	const prior = state.slide.timing
	const effect = timedEffect(current.node, op.timing)
	const entry = { node: effect, start: op.timing.start ?? current.start }
	const moves = op.timing.trigger !== undefined && (trigger?.shape ?? -1) !== (where.sequence.trigger?.shape ?? -1)

	if (moves) {
		where.sequence.effects.splice(where.index, 1)
		sequenceFor(state.sequences, trigger).effects.push(entry)
	} else where.sequence.effects[where.index] = entry

	commit(state)

	return { kind: "applied", inverse: wholeInverse(state.slide, prior, context), op }
}

// `tree` with the behaviour node `id` given `behavior`; undefined when the tree has no such node.
function replaceBehavior(node: TimeNode, id: number, behavior: Behavior): TimeNode | undefined {
	if (node.kind === "behavior" && node.ctn.id === id) return { ...node, behavior }

	for (const key of ["children", "subTnLst"] as const) {
		const list = node.ctn[key]

		if (list === undefined) continue

		for (const [index, child] of list.entries()) {
			const replaced = replaceBehavior(child, id, behavior)

			if (replaced !== undefined) {
				const copy = [...list]

				copy[index] = replaced

				return { ...node, ctn: { ...node.ctn, [key]: copy } } as TimeNode
			}
		}
	}

	return undefined
}

function behaviorOf(node: TimeNode, id: number): Behavior | undefined {
	const stack = [node]

	for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
		if (at.kind === "behavior" && at.ctn.id === id) return at.behavior

		appendAll(stack, at.ctn.children)
		appendAll(stack, at.ctn.subTnLst ?? [])
	}

	return undefined
}

function setBehavior(deck: Deck, op: OpOf<"timing"> & { kind: "setBehavior" }, context: ApplyContext): ApplyResult<typeof op> {
	const slide = deck.nodes.get(op.slide)
	const tree = slide?.timing

	if (slide === undefined) return refused("notFound", `slide ${String(op.slide)}`)

	const prior = tree === undefined ? undefined : behaviorOf(tree.root, op.node)

	if (tree === undefined || prior === undefined) return refused("notFound", `behaviour ${String(op.node)}`)

	const root = replaceBehavior(tree.root, op.node, cloneModel(op.behavior))

	if (root === undefined) return refused("notFound", `behaviour ${String(op.node)}`)

	setTree(slide, { ...tree, root })

	return { kind: "applied", inverse: wholeInverse(slide, tree, context), op }
}

export const applyTiming: ApplyFamily<TimingOp> = {
	apply: (deck, op, context) => {
		switch (op.kind) {
			case "setTiming":
				return setTiming(deck, op, context)
			case "addEffect":
				return addEffect(deck, op, context)
			case "removeEffect":
				return removeEffect(deck, op, context)
			case "moveEffect":
				return moveEffect(deck, op, context)
			case "setEffectTiming":
				return setEffectTiming(deck, op, context)
			case "setBehavior":
				return setBehavior(deck, op, context)
		}
	},
	touches: (op): readonly Touch[] => [{ kind: "slide", slide: op.slide, dirt: { kind: "slidePart", part: "timing" } }]
}

// --- Paragraph targets across a text edit ---

// A by-paragraph effect names its paragraph by index (p:pRg, an ODF paragraph by its text:p): a text edit that adds or
// deletes paragraphs moves the effects with their paragraphs, as PowerPoint does. Paragraphs are matched by identity:
// their source element (a paragraph the edit kept, edited or not), then, between those, by content from either end,
// and what is left pairs up in order (an edited paragraph, a split's first half). The effects of a deleted paragraph
// go (containers left empty and builds no effect plays any more with them); a paragraph inserted inside a by-paragraph
// run (the paragraphs before and after it animated by the same build, or the run's last paragraph before it at the
// end) gets a copy of the run's effect, placed with the run.

function sourceKey(src: SourceRef | undefined): string | undefined {
	if (src === undefined) return undefined

	return `${src.part}\u0000${src.format === "odp" ? String(src.fragment) : ""}\u0000${String(src.node)}\u0000${String(src.epoch)}`
}

function paragraphDigest(paragraph: Paragraph): string {
	return digestOf({ pPr: paragraph.pPr, runs: paragraph.runs, endRPr: paragraph.endRPr })
}

// Per paragraph before, its index after (-1: deleted).
export function paragraphMap(before: readonly Paragraph[], after: readonly Paragraph[]): Int32Array {
	const map = new Int32Array(before.length).fill(-1)
	const byKey = new Map<string, number>()

	after.forEach((paragraph, j) => {
		const key = sourceKey(paragraph.src)

		if (key !== undefined && !byKey.has(key)) byKey.set(key, j)
	})

	// Source anchors, in order.
	const anchors: [number, number][] = []
	let last = -1

	before.forEach((paragraph, i) => {
		const key = sourceKey(paragraph.src)
		const j = key === undefined ? undefined : byKey.get(key)

		if (j !== undefined && j > last) {
			anchors.push([i, j])
			last = j
		}
	})
	anchors.push([before.length, after.length])

	const digestBefore = new Map<number, string>()
	const digestAfter = new Map<number, string>()
	const same = (i: number, j: number): boolean => {
		const a = before[i]
		const b = after[j]

		if (a === undefined || b === undefined) return false
		if (sourceKey(a.src) !== sourceKey(b.src)) return false

		let left = digestBefore.get(i)
		let right = digestAfter.get(j)

		if (left === undefined) digestBefore.set(i, (left = paragraphDigest(a)))
		if (right === undefined) digestAfter.set(j, (right = paragraphDigest(b)))

		return left === right
	}
	let i0 = 0
	let j0 = 0

	for (const [i1, j1] of anchors) {
		let a = i0
		let b = j0
		let c = i1
		let d = j1

		for (; a < c && b < d && same(a, b); a++, b++) map[a] = b
		for (; c > a && d > b && same(c - 1, d - 1); c--, d--) map[c - 1] = d - 1
		for (; a < c && b < d; a++, b++) map[a] = b

		if (i1 < before.length) map[i1] = j1

		i0 = i1 + 1
		j0 = j1 + 1
	}

	return map
}

type ParagraphTarget = Extract<AnimTarget, { readonly kind: "text" }>

function paragraphTargetOn(target: AnimTarget | undefined, shape: number): target is ParagraphTarget {
	return target !== undefined && target.kind === "text" && target.unit === "para" && target.shape === shape
}

// Whether the tree animates paragraphs of `shape` one range at a time.
function animatesParagraphs(tree: TimingTree | undefined, shape: number): boolean {
	const stack = tree === undefined ? [] : [tree.root]

	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		if (node.kind === "behavior" && !isMediaBehavior(node.behavior) && paragraphTargetOn(node.behavior.common.target, shape))
			return true

		appendAll(stack, node.ctn.children)
		appendAll(stack, node.ctn.subTnLst ?? [])
	}

	return false
}

// A paragraph range moved by `map`: its kept paragraphs' new range, or undefined when none is kept.
function movedRange(target: ParagraphTarget, map: Int32Array): ParagraphTarget | undefined {
	let start = -1
	let end = -1

	for (let i = target.start; i <= target.end; i++) {
		const j = map[i] ?? -1

		if (j < 0) continue
		if (start < 0) start = j

		end = j
	}

	if (start < 0) return undefined

	return start === target.start && end === target.end ? target : { ...target, start, end }
}

function movedConditions(list: TimeCondition[], shape: number, map: Int32Array): TimeCondition[] {
	let changed = false
	const out = list.map(condition => {
		const target = condition.tgtEl

		if (!paragraphTargetOn(target, shape)) return condition

		const moved = movedRange(target, map)

		if (moved === undefined || moved === target) return condition

		changed = true

		return { ...condition, tgtEl: moved }
	})

	return changed ? out : list
}

// `node` with its paragraph targets on `shape` moved (none of them deleted: those went first); copy on write.
function moveTargets(node: TimeNode, shape: number, map: Int32Array): TimeNode {
	const ctn = node.ctn
	const children = ctn.children.map(child => moveTargets(child, shape, map))
	const subs = ctn.subTnLst?.map(child => moveTargets(child, shape, map))
	const stCondLst = movedConditions(ctn.stCondLst, shape, map)
	const endCondLst = movedConditions(ctn.endCondLst, shape, map)
	let behavior: Behavior | undefined

	if (node.kind === "behavior" && !isMediaBehavior(node.behavior)) {
		const target = node.behavior.common.target
		const moved = paragraphTargetOn(target, shape) ? movedRange(target, map) : undefined

		if (moved !== undefined && moved !== target)
			behavior = { ...node.behavior, common: { ...node.behavior.common, target: moved } } as Behavior
	}

	const same =
		behavior === undefined &&
		stCondLst === ctn.stCondLst &&
		endCondLst === ctn.endCondLst &&
		children.every((child, k) => child === ctn.children[k]) &&
		(subs === undefined || subs.every((child, k) => child === ctn.subTnLst?.[k]))

	if (same) return node

	const moved = { ...ctn, stCondLst, endCondLst, children, ...(subs === undefined ? {} : { subTnLst: subs }) }

	return (behavior === undefined ? { ...node, ctn: moved } : { kind: "behavior", behavior, ctn: moved }) as TimeNode
}

// The single paragraph an effect animates on `shape`, or undefined (none, or more than one).
function effectParagraph(effect: TimeNode, shape: number): number | undefined {
	let found: number | undefined
	const stack = [effect]

	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		if (node.kind === "behavior") {
			const target = isMediaBehavior(node.behavior) ? node.behavior.target : node.behavior.common.target

			if (!paragraphTargetOn(target, shape) || target.start !== target.end) return undefined
			if (found !== undefined && found !== target.start) return undefined

			found = target.start
		}

		appendAll(stack, node.ctn.children)
		appendAll(stack, node.ctn.subTnLst ?? [])
	}

	return found
}

// A copy of a run's effect for paragraph `to`: no source, its paragraph targets moved there, its ids new on the slide.
function copiedEffect(effect: TimeNode, shape: number, to: number, ids: IdAllocator): TimeNode {
	const copy = cloneModel(effect)
	const visit = (node: TimeNode): TimeNode => {
		const ctn = node.ctn

		delete ctn.src
		delete ctn.raw
		ctn.id = ids.take()
		ctn.children = ctn.children.map(visit)

		if (ctn.subTnLst !== undefined) ctn.subTnLst = ctn.subTnLst.map(visit)
		if (node.kind !== "behavior" || isMediaBehavior(node.behavior)) return node

		const target = node.behavior.common.target

		return paragraphTargetOn(target, shape)
			? ({
					...node,
					behavior: { ...node.behavior, common: { ...node.behavior.common, target: { ...target, start: to, end: to } } }
				} as TimeNode)
			: node
	}

	return visit(copy)
}

interface RunEffect {
	readonly sequence: EffectSequence
	readonly entry: SequenceEffect
	readonly grpId: number
}

// The inserted paragraphs' copies of their runs' effects, put in `tree` (authorable trees only).
function withInserted(tree: TimingTree, shape: number, map: Int32Array, count: number, format: Deck["format"]): TimingTree | undefined {
	const kept = new Int32Array(count).fill(-1)

	map.forEach((j, i) => {
		if (j >= 0) kept[j] = i
	})

	const inserted: number[] = []

	for (let j = 0; j < count; j++) if (kept[j] === -1) inserted.push(j)

	if (inserted.length === 0) return tree

	const sequences = readSequences(tree)

	if ("kind" in sequences) return tree

	// The run effects by paragraph (after), per build group.
	const byParagraph = new Map<number, RunEffect[]>()

	for (const sequence of [sequences.main, ...sequences.interactive]) {
		for (const entry of sequence.effects) {
			const paragraph = effectParagraph(entry.node, shape)

			if (paragraph === undefined) continue

			const list = byParagraph.get(paragraph)
			const run: RunEffect = { sequence, entry, grpId: entry.node.ctn.grpId ?? 0 }

			if (list === undefined) byParagraph.set(paragraph, [run])
			else list.push(run)
		}
	}

	if (byParagraph.size === 0) return tree

	const ids = new IdAllocator(usedIds(tree.root))
	let changed = false

	for (const j of inserted) {
		let previous = j - 1
		let next = j + 1

		// The paragraph before it: a kept one, or one inserted before it that took a copy already.
		while (previous >= 0 && kept[previous] === -1 && !byParagraph.has(previous)) previous--
		while (next < count && kept[next] === -1) next++

		const before = previous >= 0 ? (byParagraph.get(previous) ?? []) : []
		const after = next < count ? (byParagraph.get(next) ?? []) : undefined

		for (const run of before.length > 0 ? before : (after ?? [])) {
			const following = after?.find(other => other.grpId === run.grpId && other.sequence === run.sequence)

			// Inside the run: its paragraph after is animated by the same build, or the run reaches the body's end.
			if (before.length > 0 && after !== undefined && following === undefined) continue

			const start = following?.entry.start ?? run.entry.start
			const effect = withStart(copiedEffect(run.entry.node, shape, j, ids), start)
			const entry: SequenceEffect = { node: effect, start }
			const effects = run.sequence.effects
			let at: number

			// Before the effect of the paragraph after it, else after the one it copies.
			if (following !== undefined) at = effects.indexOf(following.entry)
			else {
				at = effects.indexOf(run.entry) + 1

				// A click of its own follows what plays with or after the effect it copies.
				if (start === "click") while (at < effects.length && effects[at]?.start !== "click") at++
			}

			effects.splice(Math.max(0, at), 0, entry)
			;(byParagraph.get(j) ?? byParagraph.set(j, []).get(j))?.push({ sequence: run.sequence, entry, grpId: run.grpId })
			changed = true
		}
	}

	return changed ? writeSequences(sequences, ids, format === "odp" ? "delay" : "node") : tree
}

// The slide's timing after a text edit of `shape` from `before` to `after`: its paragraph targets on that shape moved
// with their paragraphs. Answers the inverse that puts the timing back as it was, or undefined when nothing moved.
export function remapParagraphs(
	format: Deck["format"],
	slide: SlideNode,
	shape: number,
	before: TextBody | undefined,
	after: TextBody | undefined,
	context: ApplyContext
): Inverse | undefined {
	const prior = slide.timing

	if (prior === undefined || !animatesParagraphs(prior, shape)) return undefined

	const from = before?.paragraphs ?? []
	const to = after?.paragraphs ?? []
	const map = paragraphMap(from, to)
	let identity = from.length === to.length

	for (let i = 0; identity && i < map.length; i++) identity = map[i] === i

	if (identity) return undefined

	// The effects of deleted paragraphs go; the rest move.
	const pruned = withoutTargets(prior, target => paragraphTargetOn(target, shape) && movedRange(target, map) === undefined)
	let next: TimingTree | undefined

	if (pruned === undefined) next = undefined
	else {
		const moved: TimingTree = { ...pruned, root: moveTargets(pruned.root, shape, map) }

		next = withInserted(moved, shape, map, to.length, format)
	}

	if (next !== undefined) {
		const before = readSequences(prior)
		const keys = "kind" in before ? new Set<string>() : effectKeys(before)
		const after = readSequences(next)

		// Builds of this shape that no effect plays any more go with their effects.
		if (!("kind" in after)) {
			const left = effectKeys(after)
			const builds = next.builds.filter(
				build =>
					build.shape !== shape || !keys.has(buildKey(build.shape, build.grpId)) || left.has(buildKey(build.shape, build.grpId))
			)

			if (builds.length !== next.builds.length) next = { ...next, builds }
		}
	}

	if (next === prior) return undefined
	if (next === undefined) delete slide.timing
	else slide.timing = withoutStaleHeld(prior, next)

	slide.revision++

	return wholeInverse(slide, prior, context)
}
