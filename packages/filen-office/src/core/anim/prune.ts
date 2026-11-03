import { isMediaBehavior } from "./attributes"
import type { SourceRef } from "../presentation/model"
import type { AnimTarget, CommonTimeNode, TimeCondition, TimeNode, TimingTree } from "./model"
import { decodeUtf8, encodeUtf8, type XmlDocument } from "../xml/index"

// The markup an inverse held for a time node whose source element a save took out of the file (written as it was),
// or undefined (none, or the empty mark of a node an edit made).
export function heldMarkup(ctn: CommonTimeNode): Uint8Array | undefined {
	return ctn.raw === undefined || ctn.raw.length === 0 ? undefined : ctn.raw
}

export function holdMarkup(ctn: CommonTimeNode, raw: Uint8Array): void {
	ctn.raw = raw
}

// Held markup put back where it was: the namespace declarations it was given to be read on its own that are in scope
// there already (same prefix, same URI: `scope`, by prefix, "" for the default) taken off its start tag again, so
// the element is the bytes it was.
export function inScope(raw: Uint8Array, scope: ReadonlyMap<string, string>): Uint8Array {
	let end = 1
	let quote = 0

	for (; end < raw.length; end++) {
		const byte = raw[end]

		if (quote !== 0) {
			if (byte === quote) quote = 0
		} else if (byte === 0x22 || byte === 0x27) quote = byte as number
		else if (byte === 0x3e) break
	}

	const head = decodeUtf8(raw, 0, end)
	// A declaration's whitespace starts where a run of it does (the lookbehind): tried inside every run, the scan was
	// quadratic in it.
	const kept = head.replace(/(?<!\s)\s+xmlns(?::([\w.-]+))?="([^"]*)"/gu, (whole, prefix: string | undefined, value: string) =>
		scope.get(prefix ?? "") === value ? "" : whole
	)

	if (kept === head) return raw

	const bytes = encodeUtf8(kept)
	const out = new Uint8Array(bytes.length + raw.length - end)

	out.set(bytes, 0)
	out.set(raw.subarray(end), bytes.length)

	return out
}

// The declarations a document's root element makes, by prefix.
export function rootScope(document: XmlDocument): Map<string, string> {
	const scope = new Map<string, string>()

	for (const attribute of document.attributes(document.documentElement())) {
		if (attribute.name === "xmlns") scope.set("", attribute.value)
		else if (attribute.name.startsWith("xmlns:")) scope.set(attribute.name.slice(6), attribute.value)
	}

	return scope
}

// A slide's timing without what animates or is triggered by shapes that are gone (a shape deleted from the slide), as
// PowerPoint removes them with the shape: the behaviours that target one of them, the nodes a click on one of them
// begins or ends (its trigger sequence), the build entries naming one, then every container those removals left
// empty and every node condition that named a removed node. undefined: nothing of the timing is left. The input is
// never changed; the result is a new tree when something went, the input itself otherwise.

function isGone(target: AnimTarget | undefined, gone: ReadonlySet<number>): boolean {
	return target !== undefined && target.kind !== "slide" && target.kind !== "sound" && gone.has(target.shape)
}

function triggeredBy(conditions: readonly TimeCondition[], gone: ReadonlySet<number>): boolean {
	return conditions.some(condition => isGone(condition.tgtEl, gone))
}

// Whether anything of `tree` names a shape of `gone`.
export function timingTargets(tree: TimingTree | undefined, gone: ReadonlySet<number>): boolean {
	if (tree === undefined || gone.size === 0) return false
	if (tree.builds.some(build => gone.has(build.shape))) return true

	const stack: TimeNode[] = [tree.root]

	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		const ctn = node.ctn

		if (triggeredBy(ctn.stCondLst, gone) || triggeredBy(ctn.endCondLst, gone)) return true
		if (node.kind === "behavior" && isGone(isMediaBehavior(node.behavior) ? node.behavior.target : node.behavior.common.target, gone))
			return true

		for (const child of ctn.children) stack.push(child)
		for (const child of ctn.subTnLst ?? []) stack.push(child)
	}

	return false
}

// `roots`, when given, gets the topmost nodes that went (each with everything under it).
export function withoutShapes(tree: TimingTree, gone: ReadonlySet<number>, roots?: TimeNode[]): TimingTree | undefined {
	if (!timingTargets(tree, gone)) return tree

	const pruned = withoutTargets(tree, target => isGone(target, gone), roots)

	return pruned === undefined ? undefined : { ...pruned, builds: tree.builds.filter(build => !gone.has(build.shape)) }
}

// `tree` without what animates, or is triggered by, a target `gone` answers true for (the build list as it was); the
// input is never changed. undefined: nothing is left.
export function withoutTargets(tree: TimingTree, gone: (target: AnimTarget) => boolean, roots?: TimeNode[]): TimingTree | undefined {
	const removed = new Set<number>()
	const triggered = (conditions: readonly TimeCondition[]): boolean =>
		conditions.some(condition => condition.tgtEl !== undefined && gone(condition.tgtEl))
	const keep = (node: TimeNode): TimeNode | undefined => {
		const ctn = node.ctn

		if (
			triggered(ctn.stCondLst) ||
			triggered(ctn.endCondLst) ||
			(node.kind === "behavior" && gone(isMediaBehavior(node.behavior) ? node.behavior.target : node.behavior.common.target))
		) {
			collect(node, removed)

			return undefined
		}

		// After-effects of a node that stays go with what they name.
		const subs = ctn.subTnLst?.map(keep).filter((child): child is TimeNode => child !== undefined)
		const subsSame =
			subs === undefined || (subs.length === ctn.subTnLst?.length && subs.every((child, k) => child === ctn.subTnLst?.[k]))

		if (ctn.children.length === 0) return subsSame ? node : ({ ...node, ctn: { ...ctn, subTnLst: subs } } as TimeNode)

		const children = ctn.children.map(keep).filter((child): child is TimeNode => child !== undefined)

		if (children.length === 0) {
			removed.add(ctn.id)

			return undefined
		}

		return subsSame && children.length === ctn.children.length && children.every((child, k) => child === ctn.children[k])
			? node
			: ({ ...node, ctn: { ...ctn, children, ...(subs === undefined ? {} : { subTnLst: subs }) } } as TimeNode)
	}
	const root = keep(tree.root)

	if (roots !== undefined) topmost(tree.root, removed, roots)
	if (root === undefined) return undefined
	if (removed.size === 0 && root === tree.root) return tree

	return { ...tree, root: removed.size === 0 ? root : withoutReferences(root, removed) }
}

function topmost(node: TimeNode, removed: ReadonlySet<number>, out: TimeNode[]): void {
	if (removed.has(node.ctn.id)) {
		out.push(node)

		return
	}

	for (const child of node.ctn.children) topmost(child, removed, out)
	for (const child of node.ctn.subTnLst ?? []) topmost(child, removed, out)
}

function collect(node: TimeNode, into: Set<number>): void {
	into.add(node.ctn.id)

	for (const child of node.ctn.children) collect(child, into)
	for (const child of node.ctn.subTnLst ?? []) collect(child, into)
}

// Node conditions that named a removed node dropped (nothing would ever resolve them).
function withoutReferences(node: TimeNode, removed: ReadonlySet<number>): TimeNode {
	const ctn = node.ctn
	const named = (list: readonly TimeCondition[] | undefined): boolean =>
		list !== undefined && list.some(condition => condition.tn !== undefined && removed.has(condition.tn))
	const keep = (list: TimeCondition[]): TimeCondition[] =>
		named(list) ? list.filter(condition => condition.tn === undefined || !removed.has(condition.tn)) : list
	const children = ctn.children.map(child => withoutReferences(child, removed))
	const subs = ctn.subTnLst?.map(child => withoutReferences(child, removed))
	const changed =
		subs?.some((child, k) => child !== ctn.subTnLst?.[k]) === true ||
		named(ctn.stCondLst) ||
		named(ctn.endCondLst) ||
		named(ctn.prevCondLst) ||
		named(ctn.nextCondLst) ||
		children.some((child, k) => child !== ctn.children[k])

	if (!changed) return node

	return {
		...node,
		ctn: {
			...ctn,
			stCondLst: keep(ctn.stCondLst),
			endCondLst: keep(ctn.endCondLst),
			...(ctn.prevCondLst === undefined ? {} : { prevCondLst: keep(ctn.prevCondLst) }),
			...(ctn.nextCondLst === undefined ? {} : { nextCondLst: keep(ctn.nextCondLst) }),
			...(subs === undefined ? {} : { subTnLst: subs }),
			children
		}
	} as TimeNode
}

// The session's timing bound node for node onto the timing a save wrote from it and read back (the same tree, in the
// same order): each node and build entry takes the source element the file now holds for it, so a moved node keeps
// naming itself (a path from the part's root would name whatever took its place). False when the trees differ.
export function bindWrittenTiming(mine: TimingTree, theirs: TimingTree): boolean {
	const pairs: [TimeNode, TimeNode][] = []
	const same = (a: TimeNode, b: TimeNode): boolean => {
		const subs = a.ctn.subTnLst ?? []
		const theirSubs = b.ctn.subTnLst ?? []

		if (a.kind !== b.kind || a.ctn.children.length !== b.ctn.children.length || subs.length !== theirSubs.length) return false

		pairs.push([a, b])

		return (
			a.ctn.children.every((child, k) => same(child, b.ctn.children[k] as TimeNode)) &&
			subs.every((child, k) => same(child, theirSubs[k] as TimeNode))
		)
	}

	if (!same(mine.root, theirs.root) || mine.builds.length !== theirs.builds.length) return false
	if (mine.builds.some((build, k) => build.kind !== theirs.builds[k]?.kind || build.shape !== theirs.builds[k]?.shape)) return false

	for (const [a, b] of pairs) {
		if (b.ctn.src === undefined) delete a.ctn.src
		else a.ctn.src = b.ctn.src

		delete a.ctn.raw
	}

	// In place: an inverse holding the same entries sees them rebound too.
	mine.builds.forEach((build, k) => {
		const entry = build as { src?: SourceRef; raw?: Uint8Array }
		const src = theirs.builds[k]?.src

		if (src === undefined) delete entry.src
		else entry.src = src

		delete entry.raw
	})

	if (theirs.src === undefined) delete mine.src
	else mine.src = theirs.src

	if (theirs.alternate === undefined) delete mine.alternate
	else mine.alternate = theirs.alternate

	delete mine.alternateRaw

	return true
}
