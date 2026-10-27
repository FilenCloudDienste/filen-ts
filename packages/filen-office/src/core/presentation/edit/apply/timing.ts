import type { TimeNode, TimingTree } from "../../../anim/model"
import { refused, type Deck, type Refused, type SourceRef } from "../../model"
import type { ApplyContext, ApplyFamily, ApplyResult, Touch } from "../apply"
import { cloneModel } from "../changes"
import type { OpOf, TimingOp } from "../ops"

// Applies the timing ops to the model. setTiming sets a slide's timing; the effect-level ops are not built yet and are
// refused as notImplemented.
//
// A tree whose nodes carry held markup (`ctn.raw`, what a shape delete's inverse holds for each subtree it took out) is
// a restore, not a replacement: those subtrees go back into the slide's timing as it is now, each at its place among
// its siblings, and every other node stays the live one (its source, so the writer keeps its span). A put-back subtree
// keeps its source while that still reads, else it is written from the held bytes.

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

function restored(held: TimingTree, live: TimingTree | undefined, context: ApplyContext): TimingTree | Refused {
	if (live === undefined) {
		if (held.root.ctn.raw === undefined) return refused("stale", "the slide's timing changed since")

		const root = putBack(held.root, context)
		const src = held.src !== undefined && sourceReads(held.src, context) ? held.src : undefined

		return { root, builds: cloneModel(held.builds), ...(src === undefined ? {} : { src }) }
	}

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

export const applyTiming: ApplyFamily<TimingOp> = {
	apply: (deck, op, context) =>
		op.kind === "setTiming" ? setTiming(deck, op, context) : refused("notImplemented", `apply timing ${op.kind}`),
	touches: (op): readonly Touch[] =>
		op.kind === "setTiming" ? [{ kind: "slide", slide: op.slide, dirt: { kind: "slidePart", part: "timing" } }] : []
}
