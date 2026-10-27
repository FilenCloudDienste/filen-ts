import { isMediaBehavior } from "./attributes"
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
	const kept = head.replace(/\s+xmlns(?::([\w.-]+))?="([^"]*)"/gu, (whole, prefix: string | undefined, value: string) =>
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
	}

	return false
}

// `roots`, when given, gets the topmost nodes that went (each with everything under it).
export function withoutShapes(tree: TimingTree, gone: ReadonlySet<number>, roots?: TimeNode[]): TimingTree | undefined {
	if (!timingTargets(tree, gone)) return tree

	const removed = new Set<number>()
	const keep = (node: TimeNode): TimeNode | undefined => {
		const ctn = node.ctn

		if (
			triggeredBy(ctn.stCondLst, gone) ||
			triggeredBy(ctn.endCondLst, gone) ||
			(node.kind === "behavior" && isGone(isMediaBehavior(node.behavior) ? node.behavior.target : node.behavior.common.target, gone))
		) {
			collect(node, removed)

			return undefined
		}

		if (ctn.children.length === 0) return node

		const children = ctn.children.map(keep).filter((child): child is TimeNode => child !== undefined)

		if (children.length === 0) {
			removed.add(ctn.id)

			return undefined
		}

		return children.length === ctn.children.length && children.every((child, k) => child === ctn.children[k])
			? node
			: ({ ...node, ctn: { ...ctn, children } } as TimeNode)
	}
	const root = keep(tree.root)

	if (roots !== undefined) topmost(tree.root, removed, roots)
	if (root === undefined) return undefined

	const builds = tree.builds.filter(build => !gone.has(build.shape))

	return { ...tree, root: removed.size === 0 ? root : withoutReferences(root, removed), builds }
}

function topmost(node: TimeNode, removed: ReadonlySet<number>, out: TimeNode[]): void {
	if (removed.has(node.ctn.id)) {
		out.push(node)

		return
	}

	for (const child of node.ctn.children) topmost(child, removed, out)
}

function collect(node: TimeNode, into: Set<number>): void {
	into.add(node.ctn.id)

	for (const child of node.ctn.children) collect(child, into)
}

// Node conditions that named a removed node dropped (nothing would ever resolve them).
function withoutReferences(node: TimeNode, removed: ReadonlySet<number>): TimeNode {
	const ctn = node.ctn
	const named = (list: readonly TimeCondition[] | undefined): boolean =>
		list !== undefined && list.some(condition => condition.tn !== undefined && removed.has(condition.tn))
	const keep = (list: TimeCondition[]): TimeCondition[] =>
		named(list) ? list.filter(condition => condition.tn === undefined || !removed.has(condition.tn)) : list
	const children = ctn.children.map(child => withoutReferences(child, removed))
	const changed =
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
			children
		}
	} as TimeNode
}
