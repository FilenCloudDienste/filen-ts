import type { ByteSource } from "../../opc/index"
import { resolvePath, structuralPath, visitSources, type PathStep } from "../../pptx/sourcePath"
import { NodeKind, type XmlDocument } from "../../xml/index"
import { refused, type Deck, type Refused, type ShapeNode, type SlideNode, type SourceRef } from "../../presentation/model"
import { openOdp, type OdpOpenOptions, type OdpParts } from "../read/document"
import { readOdpTiming } from "../../anim/odf"
import type { TimeCondition, TimeNode } from "../../anim/model"
import type { Fragment } from "../read/context"
import { odpWriteSource } from "./source"

// A deck moved onto its saved file (§1.5.6): the saved package read again taking over the session's deck (its refs,
// nodes and history), then every source ref of a parsed page rebound into the page the save wrote for it. The saved
// file's pages are the deck's slides in order, so slide i's page is page i: a ref into the page its slide was read
// from (or copied from, for a duplicate; or held by an undo) is found again there by its path (element names and
// positions among same-named siblings), a copied page's refs keep their nodes. styles.xml is copied: its refs move to
// the new epoch as they are.

const RESOURCE_FILLS: ReadonlySet<string> = new Set(["gradient", "pattern", "picture"])

// What the open takes for a rebase (OdpOpenOptions gains `adopt`).
type RebaseOptions = OdpOpenOptions & { readonly adopt: Deck }

export async function rebaseOdpDeck(deck: Deck, parts: OdpParts, source: ByteSource): Promise<OdpParts | Refused> {
	// Refs the previous reading handed out stay retired: the history may restore a slide under one.
	const options: RebaseOptions = { epoch: parts.epoch + 1, budgets: parts.budgets, adopt: deck, refsAbove: parts.refsIssued() }
	const opened = await openOdp(source, options)

	if (opened.kind === "refused") return opened
	if (opened.deck !== deck) return refused("notImplemented", "the reader cannot take over the deck (OdpOpenOptions.adopt)")

	const before = odpWriteSource(parts)
	const after = odpWriteSource(opened.parts)

	// Styles a save retired stay known to the session: held markup may still name them.
	for (const [name, markup] of before.retired) after.retired.set(name, markup)
	for (const [name, place] of before.retiredAfter) after.retiredAfter.set(name, place)
	after.adoptHeld(before)
	// The charts translated for pages parsed before the save, whose objects the saved file holds unchanged.
	opened.parts.carryCharts(parts)
	const epoch = opened.parts.epoch
	const savedContent = opened.parts.content.bytes
	const key = (src: { readonly part: string; readonly fragment: number }): string => `${src.part}\u0000${String(src.fragment)}`
	const memo = new Map<string, Map<number, number | undefined>>()

	for (const [index, ref] of deck.slides.entries()) {
		const node = deck.nodes.get(ref)
		const src = node?.src
		const span = opened.parts.content.pages[index]

		if (node === undefined || src?.format !== "odp" || span === undefined) continue

		const from = before.fragmentOf(src)

		if (from === undefined) continue

		const to = after.fragment(span)
		const notes = node.notes === undefined ? undefined : deck.nodes.get(node.notes)

		// A page the save wrote: its shapes are the slide's in order (gate 2 read it back shape for shape), so each
		// shape's refs move onto the element at its place, wherever the shape was read from (the page, or markup an
		// undo held), its inner refs by their paths under it. A path from the page's root would name another shape
		// once one was put back before it.
		if (wasWritten(from, src.fragment, span)) {
			const written = after.readHeld(to)

			adoptByOrder(node.shapes, written.slide.shapes, to)

			// A background written through a drawing resource (gradient, pattern, picture) as the file now has it, so
			// the next save finds the page as it reads and leaves it.
			if (node.background?.kind === "fill" && RESOURCE_FILLS.has(node.background.fill.kind)) {
				const read = opened.parts.pageFields(to, to.document.firstChildElement(to.document.documentElement())).background

				if (read !== undefined) node.background = read
			}

			if (notes !== undefined && written.notes !== undefined) adoptByOrder(notes.shapes, written.notes.shapes, to)

			// Its timing likewise, node for node (an undo may have put nodes back that a path would mistake).
			if (node.timing !== undefined) {
				const page = to.document.firstChildElement(to.document.documentElement())
				const read = readOdpTiming(to, page, node.shapes, parts.budgets.timing)

				if (read?.src !== undefined && bindTiming(node.timing.root, read.root)) node.timing.src = read.src
			}
		}

		// The rest (a copied page's refs, the page's own, its timing) by their paths from the page's root.
		rebind(node, from, to)

		if (notes !== undefined) rebind(notes, from, to)
	}

	// Every other ref (styles.xml: masters, notes masters) moves to the new epoch: unchanged when styles.xml is, else (a
	// save added drawing resources or master pages before it) onto the same element of the same master page, found by
	// its name.
	const moveStyles = stylesMover(parts.stylesFragment, opened.parts.stylesFragment)

	visitSources(deck, src => {
		if (src.format !== "odp" || src.part !== "styles.xml") return src

		const node = moveStyles(src.node)

		return node === undefined ? src : { ...src, node, epoch }
	})

	return opened.parts

	// Whether the save wrote the page anew (a page from held markup always), not copied its bytes.
	function wasWritten(from: Fragment, offset: number, span: { readonly start: number; readonly end: number }): boolean {
		if (from.part !== "content.xml") return true

		const old = before.spanAt(offset)

		if (old === undefined || old.end - old.start !== span.end - span.start) return true

		const a = parts.content.bytes
		const b = savedContent

		for (let k = 0; k < span.end - span.start; k++) if (a[old.start + k] !== b[span.start + k]) return true

		return false
	}

	// The session's time nodes given the written ones' sources, all or none (the same structure, kind by kind); a node
	// written from held markup reads from the file from now on.
	function bindTiming(mine: TimeNode, theirs: TimeNode): boolean {
		const pairs: [TimeNode, TimeNode][] = []
		const same = (a: TimeNode, b: TimeNode): boolean => {
			if (a.kind !== b.kind || a.ctn.children.length !== b.ctn.children.length) return false

			pairs.push([a, b])

			return a.ctn.children.every((child, k) => same(child, b.ctn.children[k] as TimeNode))
		}

		if (!same(mine, theirs)) return false

		// The reader numbers time nodes in document order: the session's take the numbers the file now reads with (and
		// the node conditions naming them follow), so an unchanged node compares equal to the file's.
		const ids = new Map<number, number>()

		for (const [a, b] of pairs) ids.set(a.ctn.id, b.ctn.id)

		const renamed = (list: TimeCondition[] | undefined): TimeCondition[] | undefined =>
			list?.map(condition => (condition.tn === undefined ? condition : { ...condition, tn: ids.get(condition.tn) ?? condition.tn }))

		for (const [a, b] of pairs) {
			if (b.ctn.src === undefined) delete a.ctn.src
			else a.ctn.src = b.ctn.src

			delete a.ctn.raw
			a.ctn.id = b.ctn.id
			a.ctn.stCondLst = renamed(a.ctn.stCondLst) ?? []
			a.ctn.endCondLst = renamed(a.ctn.endCondLst) ?? []

			const previous = renamed(a.ctn.prevCondLst)
			const next = renamed(a.ctn.nextCondLst)

			if (previous !== undefined) a.ctn.prevCondLst = previous
			if (next !== undefined) a.ctn.nextCondLst = next
		}

		return true
	}

	// Each session shape moved onto the shape the written page holds at its place: all of them or, when the two lists
	// are not the same shapes in the same order, none (their refs then move by path, or stay readable as held).
	function adoptByOrder(session: readonly ShapeNode[], written: readonly ShapeNode[], page: Fragment): void {
		const mine = session.filter(shape => shape.synthetic !== true)
		const theirs = written.filter(shape => shape.synthetic !== true)

		if (mine.length !== theirs.length || mine.some((shape, k) => shape.kind !== theirs[k]?.kind || shape.name !== theirs[k]?.name))
			return

		mine.forEach((shape, k) => {
			const other = theirs[k] as ShapeNode
			const src = shape.src
			const held = src?.format === "odp" ? before.fragmentOf(src) : undefined

			if (src?.format !== "odp" || other.src?.format !== "odp" || held === undefined) return

			moveShape(shape, held, src.node, page, other.src.node)
			adoptByOrder(
				(shape.children ?? []).filter(child => child.src?.format === "odp" && child.src.epoch !== page.epoch),
				(other.children ?? []).filter((_, j) => {
					const child = shape.children?.[j]

					return child?.src?.format === "odp" && child.src.epoch !== page.epoch
				}),
				page
			)
		})
	}

	// The refs of a shape (and everything under it) into `held` moved under element `onto` of `page`, by their path
	// below the shape's own element.
	function moveShape(shape: ShapeNode, held: Fragment, element: number, page: Fragment, onto: number): void {
		const base = structuralPath(held.document, element)?.length ?? 0

		visitSources(shape, src => {
			if (src.format !== "odp" || src.part !== held.part) return src
			if (src.node === element) return { format: "odp", part: page.part, fragment: page.offset, node: onto, epoch: page.epoch }

			const path = structuralPath(held.document, src.node)
			const found = path === undefined ? undefined : resolveBelow(page.document, onto, path.slice(base))

			return found === undefined ? src : { format: "odp", part: page.part, fragment: page.offset, node: found, epoch: page.epoch }
		})
	}

	// The refs under one node (its shapes, paragraphs, cells) into `from` moved into `to`.
	function rebind(node: SlideNode, from: Fragment, to: Fragment): void {
		visitSources(node, src => remap(src, from, to))
	}

	function remap(src: SourceRef, from: Fragment, to: Fragment): SourceRef {
		if (src.format !== "odp" || src.part !== from.part || src.fragment !== from.offset || src.epoch !== from.epoch) return src

		// A duplicate's page and its original's are two targets of one source fragment.
		const pair = `${key(src)}\u0000${String(to.offset)}`
		let nodes = memo.get(pair)

		if (nodes === undefined) {
			nodes = new Map()
			memo.set(pair, nodes)
		}

		if (!nodes.has(src.node)) {
			const path = structuralPath(from.document, src.node)
			// A shape the save took out of its draw:a (its click action rewritten) or put into one is the same shape.
			const found =
				resolvePath(to.document, path) ??
				resolvePath(
					to.document,
					path?.filter(step => !/(^|:)a$/u.test(step.name))
				)

			nodes.set(src.node, found)
		}

		const node = nodes.get(src.node)

		// Not found again: the ref stays on its old epoch (refused as stale where it is read).
		return node === undefined ? src : { format: "odp", part: to.part, fragment: to.offset, node, epoch: to.epoch }
	}
}

// The element below `start` that `steps` lead to (each an element name and its position among same-named siblings).
function resolveBelow(document: XmlDocument, start: number, steps: readonly PathStep[]): number | undefined {
	let node = start

	for (const step of steps) {
		let found = -1
		let ordinal = 0

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.name(child) !== step.name) continue

			if (ordinal++ === step.ordinal) {
				found = child

				break
			}
		}

		if (found < 0) return undefined

		node = found
	}

	return node
}

// Where a node of styles.xml is in the saved styles.xml: the same index when the bytes are the same; else, below a
// master page, the element at its path under the master page of the same style:name; else the element at its path.
function stylesMover(before: Fragment | undefined, after: Fragment | undefined): (node: number) => number | undefined {
	if (before === undefined || after === undefined) return node => node

	const a = before.document.bytes
	const b = after.document.bytes

	if (a.length === b.length && a.every((byte, k) => byte === b[k])) return node => node

	let pages: Map<string, number> | undefined
	const pagesAfter = (): Map<string, number> => {
		if (pages !== undefined) return pages

		pages = new Map()

		for (let node = 1; node < after.document.count; node++) {
			if (after.document.kind(node) !== NodeKind.Element || after.name(node) !== "style:master-page") continue

			const name = after.attributes(node).get("style:name")

			if (name !== undefined && !pages.has(name)) pages.set(name, node)
		}

		return pages
	}

	return node => {
		const path = structuralPath(before.document, node)

		if (path === undefined) return undefined

		let depth = path.length - 1

		for (let at = node; at > 0 && before.document.kind(at) === NodeKind.Element; at = before.document.parent(at), depth--) {
			if (before.name(at) !== "style:master-page") continue

			const page = pagesAfter().get(before.attributes(at).get("style:name") ?? "")

			return page === undefined ? undefined : resolveBelow(after.document, page, path.slice(depth + 1))
		}

		return resolvePath(after.document, path)
	}
}
