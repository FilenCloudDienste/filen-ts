import { appendAll } from "../../../arrays"
import { bookmarkCondition, isBookmarkCondition } from "../../media"
import type { CommonTimeNode, TimeCondition, TimeNode, TimeNodeType, TimingTree } from "../../model"

// A slide's effects as authoring sees them: the main sequence and each trigger's interactive sequence as flat lists of
// effects, each with how it starts (on click, with the previous, after the previous), read from and written back to
// the ECMA-376 §19.5 tree PowerPoint writes: tmRoot → mainSeq | interactiveSeq → click pars → with/after group pars →
// effect pars → behaviours. The tree is the truth; writing rebuilds the click and group pars from the list and
// keeps every container that holds the same effects with the same begin as it was (its source span stays).

export type EffectStart = "click" | "with" | "after"

// A click on a shape, or a bookmark of a medium (MS-PPTX p14:bmkTgt) reached as it plays.
export type EffectTrigger =
	| { readonly kind: "shapeClick"; readonly shape: number }
	| { readonly kind: "bookmark"; readonly shape: number; readonly bookmark: string }

export function sameTrigger(a: EffectTrigger | undefined, b: EffectTrigger | undefined): boolean {
	if (a === undefined || b === undefined) return a === b

	return a.kind === b.kind && a.shape === b.shape && (a.kind !== "bookmark" || (b.kind === "bookmark" && a.bookmark === b.bookmark))
}

export interface SequenceEffect {
	readonly node: TimeNode
	readonly start: EffectStart
}

export interface EffectSequence {
	// Absent: the main sequence.
	readonly trigger?: EffectTrigger
	// The seq node as read (absent for a sequence made now).
	readonly seq?: TimeNode
	effects: SequenceEffect[]
	// The click pars as read, each with its group pars, for reuse.
	readonly clicks: readonly { readonly node: TimeNode; readonly groups: readonly TimeNode[] }[]
}

export interface SlideSequences {
	// The timing root as read (absent: the slide has none yet).
	readonly root?: TimeNode
	readonly main: EffectSequence
	readonly interactive: EffectSequence[]
	readonly builds: TimingTree["builds"]
	readonly src?: TimingTree["src"]
	readonly alternate?: TimingTree["alternate"]
}

// Why a tree cannot be authored: a sequence whose children are not click pars of group pars of effects.
export interface SequenceRefusal {
	readonly kind: "unsupported"
	readonly detail: string
}

function isContainer(node: TimeNode): boolean {
	return node.kind === "par" || node.kind === "seq" || node.kind === "excl"
}

// The click par starts by itself (the first group of a slide whose first effect is with or after the previous): one
// of its conditions waits for no click (an indefinite delay waits, as does LibreOffice's smil:begin="next", read as
// onNext).
export function automatic(click: TimeNode): boolean {
	return click.ctn.stCondLst.some(condition => condition.delay !== "indefinite" && condition.evt !== "onNext")
}

function startOf(effect: TimeNode, click: number, group: number, index: number, auto: boolean, interactive: boolean): EffectStart {
	if (index > 0) return "with"
	if (group > 0) return "after"
	if (click === 0 && (auto || interactive)) {
		if (effect.ctn.nodeType === "afterEffect") return "after"
		if (effect.ctn.nodeType === "withEffect") return "with"

		return interactive ? "click" : "with"
	}

	return "click"
}

function readSequence(seq: TimeNode | undefined, trigger: EffectTrigger | undefined): EffectSequence | SequenceRefusal {
	const effects: SequenceEffect[] = []
	const clicks: { node: TimeNode; groups: TimeNode[] }[] = []

	for (const [c, click] of (seq?.ctn.children ?? []).entries()) {
		if (click.kind !== "par") return { kind: "unsupported", detail: `click group ${String(click.ctn.id)} is a ${click.kind}` }

		const auto = automatic(click)

		clicks.push({ node: click, groups: click.ctn.children })

		for (const [g, group] of click.ctn.children.entries()) {
			if (group.kind !== "par") return { kind: "unsupported", detail: `effect group ${String(group.ctn.id)} is a ${group.kind}` }

			for (const [e, effect] of group.ctn.children.entries()) {
				if (!isContainer(effect)) return { kind: "unsupported", detail: `behaviour ${String(effect.ctn.id)} outside an effect` }

				effects.push({ node: effect, start: startOf(effect, c, g, e, auto, trigger !== undefined) })
			}
		}
	}

	return { ...(trigger === undefined ? {} : { trigger }), ...(seq === undefined ? {} : { seq }), effects, clicks }
}

function triggerOf(seq: TimeNode): EffectTrigger | undefined {
	const bookmark = seq.ctn.stCondLst.find(isBookmarkCondition)

	if (bookmark?.tgtEl?.kind === "shape" && bookmark.bookmark !== undefined)
		return { kind: "bookmark", shape: bookmark.tgtEl.shape, bookmark: bookmark.bookmark }

	const condition = seq.ctn.stCondLst.find(c => c.evt === "onClick" && c.tgtEl !== undefined)
	const target = condition?.tgtEl

	return target !== undefined && target.kind !== "slide" && target.kind !== "sound"
		? { kind: "shapeClick", shape: target.shape }
		: undefined
}

export function readSequences(tree: TimingTree | undefined): SlideSequences | SequenceRefusal {
	const root = tree?.root
	let main: EffectSequence | undefined
	const interactive: EffectSequence[] = []

	for (const child of root?.ctn.children ?? []) {
		if (child.kind !== "seq") continue

		if (child.ctn.nodeType === "mainSeq" && main === undefined) {
			const read = readSequence(child, undefined)

			if ("kind" in read) return read

			main = read
		} else if (child.ctn.nodeType === "interactiveSeq") {
			const trigger = triggerOf(child)

			if (trigger === undefined)
				return { kind: "unsupported", detail: `interactive sequence ${String(child.ctn.id)} has no shape trigger` }

			const read = readSequence(child, trigger)

			if ("kind" in read) return read

			interactive.push(read)
		}
	}

	return {
		...(root === undefined ? {} : { root }),
		main: main ?? { effects: [], clicks: [] },
		interactive,
		builds: tree?.builds ?? [],
		...(tree?.src === undefined ? {} : { src: tree.src }),
		...(tree?.alternate === undefined ? {} : { alternate: tree.alternate })
	}
}

// --- Writing ---

// Every ctn id of a tree, after-effect nodes included.
export function usedIds(node: TimeNode, out: Set<number> = new Set()): Set<number> {
	const stack = [node]

	for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
		out.add(at.ctn.id)
		appendAll(stack, at.ctn.children)
		appendAll(stack, at.ctn.subTnLst ?? [])
	}

	return out
}

export class IdAllocator {
	private readonly used: Set<number>
	private next = 1

	constructor(used: Set<number>) {
		this.used = used
	}

	take(): number {
		while (this.used.has(this.next)) this.next++

		this.used.add(this.next)

		return this.next
	}

	has(id: number): boolean {
		return this.used.has(id)
	}

	add(id: number): void {
		this.used.add(id)
	}
}

function scalar(value: number | "indefinite" | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0
}

// How long a node plays once begun, its own begin delay included (ms; an indefinite part counts as 0).
export function extentOf(node: TimeNode): number {
	const ctn = node.ctn
	const begin = scalar(ctn.stCondLst[0]?.delay)
	let span: number

	if (typeof ctn.dur === "number") span = ctn.dur
	else {
		span = 0

		for (const child of ctn.children) span = Math.max(span, extentOf(child))
	}

	if (ctn.autoRev === true) span *= 2

	const repeat = ctn.repeatCount

	if (typeof repeat === "number" && repeat > 0) span = (span * repeat) / 1000

	return begin + span
}

function sameConditions(a: readonly TimeCondition[], b: readonly TimeCondition[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

function container(
	base: CommonTimeNode | undefined,
	ids: IdAllocator,
	stCondLst: TimeCondition[],
	children: TimeNode[],
	id?: number
): TimeNode {
	const ctn: CommonTimeNode =
		base === undefined
			? { id: id ?? ids.take(), fill: "hold", stCondLst, endCondLst: [], children }
			: { ...base, stCondLst: sameConditions(base.stCondLst, stCondLst) ? base.stCondLst : stCondLst, children }

	return { kind: "par", ctn }
}

function sameChildren(a: readonly TimeNode[], b: readonly TimeNode[]): boolean {
	return a.length === b.length && a.every((node, index) => node === b[index])
}

const NODE_TYPES: Readonly<Record<EffectStart, TimeNodeType>> = {
	click: "clickEffect",
	with: "withEffect",
	after: "afterEffect"
}

// The effect as it plays at its start: its node type follows.
export function withStart(effect: TimeNode, start: EffectStart): TimeNode {
	const nodeType = NODE_TYPES[start]

	return effect.ctn.nodeType === nodeType ? effect : ({ ...effect, ctn: { ...effect.ctn, nodeType } } as TimeNode)
}

// How a main sequence's first click par that waits for no click begins: as PowerPoint writes it (an indefinite delay
// and the sequence's onBegin by node id), or by a plain delay, its turn in the sequence (as LibreOffice writes ODF,
// smil:begin="0s": no node id to name across pages).
export type AutoStart = "node" | "delay"

// The click pars of a sequence from its effect list. `mainSeq`: the main sequence's id (a slide whose first effect
// does not wait for a click begins it with the sequence).
function writeClicks(sequence: EffectSequence, ids: IdAllocator, mainSeq: number | undefined, autoStart: AutoStart): TimeNode[] {
	const plan: SequenceEffect[][][] = []

	const interactive = sequence.trigger !== undefined

	for (const [index, effect] of sequence.effects.entries()) {
		// An interactive sequence's first effects play on the trigger's first click, however they start.
		if (plan.length === 0 || (effect.start === "click" && !(interactive && index === 0))) plan.push([[]])

		const click = plan[plan.length - 1] ?? []
		let group = click[click.length - 1] ?? []

		if (group.length > 0 && effect.start === "after") {
			group = []
			click.push(group)
		}

		group.push(effect)
	}

	const out: TimeNode[] = []

	for (const [c, groups] of plan.entries()) {
		const old = sequence.clicks[c]
		const first = groups[0]?.[0]
		const waits = interactive ? c > 0 : first?.start === "click"
		const stCondLst: TimeCondition[] = waits
			? [{ delay: "indefinite" }]
			: interactive || autoStart === "delay" || mainSeq === undefined
				? [{ delay: 0 }]
				: [{ delay: "indefinite" }, { evt: "onBegin", delay: 0, tn: mainSeq }]
		// A new click par is numbered before its groups, as PowerPoint numbers a tree (document order).
		const clickId = old === undefined ? ids.take() : undefined
		const groupNodes: TimeNode[] = []
		let offset = 0
		let previousSame = true

		for (const [g, effects] of groups.entries()) {
			const children = effects.map(effect => withStart(effect.node, effect.start))
			const oldGroup = old?.groups[g]
			const same = oldGroup !== undefined && sameChildren(oldGroup.ctn.children, children)
			// A group keeps its begin while it and every group before it in its click are as they were.
			const oldDelay = oldGroup?.ctn.stCondLst[0]?.delay
			const delay = g === 0 ? 0 : previousSame && same && typeof oldDelay === "number" ? oldDelay : offset
			const node =
				same && oldGroup !== undefined && oldDelay === delay ? oldGroup : container(oldGroup?.ctn, ids, [{ delay }], children)

			groupNodes.push(node)
			previousSame = previousSame && same
			offset = delay + Math.max(0, ...children.map(extentOf))
		}

		out.push(
			old !== undefined && sameChildren(old.node.ctn.children, groupNodes) && sameConditions(old.node.ctn.stCondLst, stCondLst)
				? old.node
				: container(old?.node.ctn, ids, stCondLst, groupNodes, clickId)
		)
	}

	return out
}

const SLIDE = { kind: "slide" } as const

function mainSeqNode(old: TimeNode | undefined, ids: IdAllocator): TimeNode {
	if (old !== undefined) return old

	return {
		kind: "seq",
		ctn: {
			id: ids.take(),
			dur: "indefinite",
			nodeType: "mainSeq",
			concurrent: true,
			nextAc: "seek",
			stCondLst: [],
			endCondLst: [],
			children: [],
			prevCondLst: [{ evt: "onPrev", delay: 0, tgtEl: SLIDE }],
			nextCondLst: [{ evt: "onNext", delay: 0, tgtEl: SLIDE }]
		}
	}
}

function interactiveNode(old: TimeNode | undefined, trigger: EffectTrigger, ids: IdAllocator): TimeNode {
	if (old !== undefined) return old

	const click: TimeCondition =
		trigger.kind === "bookmark"
			? bookmarkCondition(trigger.shape, trigger.bookmark)
			: { evt: "onClick", delay: 0, tgtEl: { kind: "shape", shape: trigger.shape } }

	return {
		kind: "seq",
		ctn: {
			id: ids.take(),
			restart: "whenNotActive",
			fill: "hold",
			// As PowerPoint writes a trigger's sequence: the trigger's click is not the slide's too.
			evtFilter: "cancelBubble",
			nodeType: "interactiveSeq",
			concurrent: true,
			nextAc: "seek",
			stCondLst: [click],
			endCondLst: [],
			endSync: { evt: "end", delay: 0, rtn: "all" },
			children: [],
			nextCondLst: [click]
		}
	}
}

function withChildren(node: TimeNode, children: TimeNode[]): TimeNode {
	return sameChildren(node.ctn.children, children) ? node : ({ ...node, ctn: { ...node.ctn, children } } as TimeNode)
}

// The slide's timing with `sequences` written back: undefined when nothing is left to play.
export function writeSequences(sequences: SlideSequences, ids: IdAllocator, autoStart: AutoStart = "node"): TimingTree | undefined {
	const old = sequences.root
	const mainNode = sequences.main.effects.length === 0 ? undefined : mainSeqNode(sequences.main.seq, ids)
	const main = mainNode === undefined ? undefined : withChildren(mainNode, writeClicks(sequences.main, ids, mainNode.ctn.id, autoStart))
	const interactive = new Map<TimeNode, TimeNode>()
	const added: TimeNode[] = []

	for (const sequence of sequences.interactive) {
		if (sequence.effects.length === 0 || sequence.trigger === undefined) continue

		const seq = interactiveNode(sequence.seq, sequence.trigger, ids)
		const written = withChildren(seq, writeClicks(sequence, ids, undefined, autoStart))

		if (sequence.seq === undefined) added.push(written)
		else interactive.set(sequence.seq, written)
	}

	// The root's other children (media nodes) stay where they are; the sequences take their places.
	const children: TimeNode[] = []
	let mainPlaced = false

	for (const child of old?.ctn.children ?? []) {
		if (child === sequences.main.seq) {
			if (main !== undefined) children.push(main)

			mainPlaced = true
		} else if (child.kind === "seq" && child.ctn.nodeType === "interactiveSeq") {
			const written = interactive.get(child)

			if (written !== undefined) children.push(written)
		} else children.push(child)
	}

	if (!mainPlaced && main !== undefined) children.unshift(main)

	appendAll(children, added)

	if (children.length === 0 && sequences.builds.length === 0) return undefined

	const root: TimeNode =
		old === undefined
			? {
					kind: "par",
					ctn: {
						id: ids.take(),
						dur: "indefinite",
						restart: "never",
						nodeType: "tmRoot",
						stCondLst: [],
						endCondLst: [],
						children
					}
				}
			: withChildren(old, children)

	return {
		root,
		builds: [...sequences.builds],
		...(sequences.src === undefined ? {} : { src: sequences.src }),
		...(sequences.alternate === undefined ? {} : { alternate: sequences.alternate })
	}
}
