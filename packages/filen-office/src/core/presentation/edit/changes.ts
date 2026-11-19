import { slideRef, type Deck, type Refused, type ShapeNode, type SlideNode, type SlideRef, type SourceRef } from "../model"
import type { DeckChanges, Dirt, PartChanges, Touch } from "./apply"
import { UNKNOWN_FINGERPRINT, touchKey, type DeckHistory, type Fingerprint, type FingerprintOf, type TouchKey } from "./history"
import { commentsValue } from "../comments"
import { notesValue } from "../notes"

// What differs from the saved state, recomputed from the history's dirty keys: a key is dirty when the model's
// fingerprint of it now differs from the one it had in the saved state (history.ts). Fingerprints are digests of
// the model's typed values (source refs, revisions and locks left out, so a re-read of the same markup compares
// equal) and, for a whole node backed by source markup, of those bytes, so a node restored from an inverse's bytes
// is the node it was.

// The bytes a source ref names, or a refusal (stale epoch, part gone).
export type SourceBytes = (src: SourceRef) => Uint8Array | Refused

const LEFT_OUT: ReadonlySet<string> = new Set(["src", "revision", "lock"])
const INLINE_DIGEST = 96

// FNV-1a over UTF-16 code units, two lanes (64 bits).
function digestString(text: string): string {
	let a = 0x811c9dc5
	let b = 0x01000193 ^ 0x5bd1e995

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)

		a = Math.imul(a ^ code, 0x01000193)
		b = Math.imul(b ^ code, 0x5bd1e995)
		b ^= b >>> 15
	}

	return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}.${text.length.toString(36)}`
}

function digestBytes(bytes: Uint8Array): string {
	let a = 0x811c9dc5
	let b = 0x9e3779b9

	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i] ?? 0

		a = Math.imul(a ^ byte, 0x01000193)
		b = Math.imul(b ^ byte, 0x5bd1e995)
		b ^= b >>> 13
	}

	return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}.${bytes.length.toString(36)}`
}

function serialize(value: unknown, out: string[]): void {
	if (value === undefined) {
		out.push("u")

		return
	}

	if (value === null || typeof value !== "object") {
		out.push(JSON.stringify(value) ?? "u")

		return
	}

	if (ArrayBuffer.isView(value)) {
		out.push(`#${digestBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))}`)

		return
	}

	if (value instanceof Map || value instanceof Set) {
		out.push("[")

		for (const item of value) {
			serialize(item, out)
			out.push(",")
		}

		out.push("]")

		return
	}

	if (Array.isArray(value)) {
		out.push("[")

		for (const item of value) {
			serialize(item, out)
			out.push(",")
		}

		out.push("]")

		return
	}

	out.push("{")

	for (const key of Object.keys(value).sort()) {
		const field = (value as Record<string, unknown>)[key]

		if (field === undefined || LEFT_OUT.has(key)) continue

		out.push(key, ":")
		serialize(field, out)
		out.push(",")
	}

	out.push("}")
}

// A deep copy of a model value (plain objects, arrays, typed arrays): the core has no structuredClone.
export function cloneModel<T>(value: T): T {
	if (value === null || typeof value !== "object") return value
	if (ArrayBuffer.isView(value)) return (value as unknown as Uint8Array).slice() as unknown as T
	if (Array.isArray(value)) return value.map(item => cloneModel(item) as unknown) as unknown as T

	const out: Record<string, unknown> = {}

	for (const key of Object.keys(value)) out[key] = cloneModel((value as Record<string, unknown>)[key])

	return out as T
}

// A stable digest of a model value (source refs, revisions and locks left out).
export function digestOf(value: unknown): string {
	const out: string[] = []

	serialize(value, out)

	const text = out.join("")

	return text.length <= INLINE_DIGEST ? text : digestString(text)
}

function listLike(value: object): value is Iterable<unknown> {
	return Array.isArray(value) || value instanceof Map || value instanceof Set
}

function definedKeys(value: Record<string, unknown>): number {
	let count = 0

	for (const key in value) if (Object.hasOwn(value, key) && value[key] !== undefined && !LEFT_OUT.has(key)) count++

	return count
}

// Whether two model values have the same digest (digestOf(a) === digestOf(b), short of a collision), compared in
// place: no digest is built, and the first difference ends the walk.
export function sameDigest(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (a === undefined || b === undefined) return false

	const objectA = a !== null && typeof a === "object"
	const objectB = b !== null && typeof b === "object"

	if (!objectA || !objectB) return !objectA && !objectB && JSON.stringify(a) === JSON.stringify(b)

	if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
		if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.byteLength !== b.byteLength) return false

		const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
		const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

		for (let k = 0; k < left.length; k++) if (left[k] !== right[k]) return false

		return true
	}

	if (listLike(a) || listLike(b)) {
		if (!listLike(a) || !listLike(b)) return false

		const right = b[Symbol.iterator]()

		for (const item of a) {
			const other = right.next()

			if (other.done === true || !sameDigest(item, other.value)) return false
		}

		return right.next().done === true
	}

	const left = a as Record<string, unknown>
	const right = b as Record<string, unknown>
	let count = 0

	for (const key in left) {
		if (!Object.hasOwn(left, key) || left[key] === undefined || LEFT_OUT.has(key)) continue
		if (!sameDigest(left[key], right[key])) return false

		count++
	}

	return count === definedKeys(right)
}

export interface ShapeAt {
	readonly shape: ShapeNode
	// The group's id, or 0 at the top of the tree; the index among its siblings.
	readonly parent: number
	readonly index: number
}

// A shape of a slide by id, anywhere in its group tree.
export function findShape(shapes: readonly ShapeNode[], id: number, parent = 0): ShapeAt | undefined {
	for (let index = 0; index < shapes.length; index++) {
		const shape = shapes[index] as ShapeNode

		if (shape.id === id) return { shape, parent, index }

		if (shape.children !== undefined) {
			const found = findShape(shape.children, id, shape.id)

			if (found !== undefined) return found
		}
	}

	return undefined
}

function sourceDigest(src: SourceRef | undefined, sourceBytes: SourceBytes): string {
	if (src === undefined) return ""

	const bytes = sourceBytes(src)

	return bytes instanceof Uint8Array ? digestBytes(bytes) : `!${bytes.reason}`
}

const ABSENT = (part?: string): Fingerprint => ({ digest: "", exists: false, ...(part === undefined ? {} : { part }) })

export type ParsedKey =
	| { readonly kind: "shape"; readonly slide: SlideRef; readonly shape: number; readonly dirt: string }
	| { readonly kind: "slide"; readonly slide: SlideRef; readonly dirt: string }
	| { readonly kind: "presentation"; readonly what: string }
	| { readonly kind: "part"; readonly part: string; readonly change: string }
	| { readonly kind: "order"; readonly slide: SlideRef; readonly parent: number }

// The key of a sibling order: the shapes of a slide's tree (parent 0) or of one group, back to front.
export function orderKey(slide: SlideRef, parent: number): TouchKey {
	return `o:${String(slide)}:${String(parent)}`
}

export function parseTouchKey(key: TouchKey): ParsedKey {
	const [head, ...rest] = key.split(":")

	switch (head) {
		case "s":
			return { kind: "shape", slide: slideRef(Number(rest[0])), shape: Number(rest[1]), dirt: rest.slice(2).join(":") }
		case "n":
			return { kind: "slide", slide: slideRef(Number(rest[0])), dirt: rest.slice(1).join(":") }
		case "d":
			return { kind: "presentation", what: rest.join(":") }
		case "o":
			return { kind: "order", slide: slideRef(Number(rest[0])), parent: Number(rest[1]) }
		default:
			return { kind: "part", change: rest[0] ?? "changed", part: rest.slice(1).join(":") }
	}
}

function slidePartValue(deck: Deck, node: SlideNode, part: string): unknown {
	switch (part) {
		case "notes":
			return notesValue(deck, node)
		case "comments":
			return commentsValue(deck, node)
		case "background":
			return node.background
		case "timing":
			return node.timing
		case "transition":
			return node.transition
		case "hf":
			return node.hf
		case "clrMapOvr":
			return node.clrMapOvr
		default:
			return { hidden: node.hidden, name: node.name, showMasterShapes: node.showMasterShapes }
	}
}

function presentationValue(deck: Deck, what: string): unknown {
	switch (what) {
		case "slideList":
			return deck.slides
		case "sections":
			return deck.sections
		case "customShows":
			return deck.customShows
		case "size":
			return { size: deck.size, notesSize: deck.notesSize, firstSlideNumber: deck.firstSlideNumber }
		case "defaults":
			return deck.defaultTextStyle
		case "show":
			return deck.show
		case "authors":
			return deck.authors
		default:
			return undefined
	}
}

function shapeValue(at: ShapeAt, dirt: string): unknown {
	const { shape } = at

	switch (dirt) {
		case "x":
			return shape.xfrm
		case "t":
			return shape.text
		case "p.style":
			return shape.style
		case "p.geometry":
			return shape.props?.geometry
		case "p.fill":
			return shape.props?.fill
		case "p.ln":
			return shape.props?.ln
		case "p.effects":
			return shape.props?.effects
		case "p.bodyPr":
			return shape.props?.bodyPr
		default:
			return undefined
	}
}

// The model's fingerprint of each touch key, now.
export function deckFingerprints(deck: Deck, sourceBytes: SourceBytes): FingerprintOf {
	return key => {
		const parsed = parseTouchKey(key)

		switch (parsed.kind) {
			case "shape": {
				const node = deck.nodes.get(parsed.slide)

				if (node === undefined) return deck.slides.includes(parsed.slide) ? UNKNOWN_FINGERPRINT : ABSENT()

				const at = findShape(node.shapes, parsed.shape)

				if (at === undefined) return ABSENT(node.part)

				if (parsed.dirt === "n") {
					// The node's own fields and parent; its xfrm, property groups, style and text have keys of their own, and
					// its children and its place among its siblings are its group's and its parent's order keys.
					const { xfrm: _xfrm, props: _props, style: _style, text: _text, children: _children, ...own } = at.shape

					return {
						digest: digestOf({
							own,
							parent: at.parent,
							source: sourceDigest(at.shape.src, sourceBytes)
						}),
						exists: true,
						part: node.part
					}
				}

				return { digest: digestOf(shapeValue(at, parsed.dirt)), exists: true, part: node.part }
			}
			case "slide": {
				const node = deck.nodes.get(parsed.slide)

				if (node === undefined) {
					const listed =
						deck.slides.includes(parsed.slide) || deck.layouts.includes(parsed.slide) || deck.masters.includes(parsed.slide)

					return listed ? UNKNOWN_FINGERPRINT : ABSENT()
				}

				// The node itself (a master's text styles with it): its parts and shapes have keys of their own.
				if (parsed.dirt === "n") {
					return {
						digest: digestOf({
							kind: node.kind,
							part: node.part,
							parent: node.parent,
							notes: node.notes !== undefined,
							txStyles: node.txStyles,
							source: sourceDigest(node.src, sourceBytes)
						}),
						exists: true,
						part: node.part
					}
				}

				return { digest: digestOf(slidePartValue(deck, node, parsed.dirt.slice(3))), exists: true, part: node.part }
			}
			case "presentation":
				return { digest: digestOf(presentationValue(deck, parsed.what)), exists: true }
			case "part":
				return UNKNOWN_FINGERPRINT
			case "order": {
				const node = deck.nodes.get(parsed.slide)

				if (node === undefined) return ABSENT()

				const siblings = parsed.parent === 0 ? node.shapes : findShape(node.shapes, parsed.parent)?.shape.children

				if (siblings === undefined) return ABSENT(node.part)

				const order = siblings.map(shape => shape.id)

				return { digest: order.join(","), exists: true, part: node.part, order }
			}
		}
	}
}

// The shapes of `now` that moved relative to the others since `saved`: those outside a longest common subsequence.
// Sibling ids are unique, so that is a longest increasing run of `now` projected onto positions in `saved`
// (patience sorting, O(n log n) time and O(n) memory), after the common prefix and suffix are set aside.
export function movedShapes(saved: readonly number[], now: readonly number[]): number[] {
	const present = new Set(now)
	const position = new Map<number, number>()

	for (const id of saved) {
		if (present.has(id) && !position.has(id)) position.set(id, position.size)
	}

	const ids: number[] = []
	const at: number[] = []

	for (const id of now) {
		const index = position.get(id)

		if (index === undefined) continue

		ids.push(id)
		at.push(index)
	}

	let low = 0
	let high = at.length

	while (low < high && at[low] === low) low++

	while (high > low && at[high - 1] === position.size - (at.length - high) - 1) high--

	// Middle positions outside (low - 1, first suffix position) cannot join the prefix and suffix.
	const floor = low
	const ceiling = position.size - (at.length - high)
	// tails[k]: the index in `at` ending the smallest-ending increasing run of length k + 1; previous links each run.
	const tails: number[] = []
	const previous = new Int32Array(at.length).fill(-1)

	for (let i = low; i < high; i++) {
		const value = at[i] as number

		if (value < floor || value >= ceiling) continue

		let left = 0
		let right = tails.length

		while (left < right) {
			const middle = (left + right) >>> 1

			if ((at[tails[middle] as number] as number) < value) left = middle + 1
			else right = middle
		}

		if (left > 0) previous[i] = tails[left - 1] as number

		tails[left] = i
	}

	const common = new Set<number>()

	for (let i = 0; i < low; i++) common.add(ids[i] as number)

	for (let i = high; i < ids.length; i++) common.add(ids[i] as number)

	for (let i = tails.length === 0 ? -1 : (tails[tails.length - 1] as number); i !== -1; i = previous[i] as number) {
		common.add(ids[i] as number)
	}

	return ids.filter(id => !common.has(id))
}

// The fingerprints of what `touches` names, now (a step's before or after state).
export function fingerprintTouches(touches: readonly Touch[], fingerprint: FingerprintOf): Map<TouchKey, Fingerprint> {
	const out = new Map<TouchKey, Fingerprint>()

	for (const touch of touches) {
		const key = touchKey(touch)

		if (!out.has(key)) out.set(key, fingerprint(key))
	}

	return out
}

function dirtOf(code: string): Dirt {
	if (code === "x") return { kind: "xfrm" }
	if (code === "t") return { kind: "text" }
	if (code === "n") return { kind: "node" }
	if (code.startsWith("p.")) return { kind: "props", group: code.slice(2) as Extract<Dirt, { kind: "props" }>["group"] }

	return { kind: "slidePart", part: code.slice(3) as Extract<Dirt, { kind: "slidePart" }>["part"] }
}

function sameDirt(a: Dirt, b: Dirt): boolean {
	return sameDigest(a, b)
}

// Two different dirts on one element: the whole element is rewritten (one dirt never covers another kind's markup).
function mergeDirt(a: Dirt | undefined, b: Dirt): Dirt {
	return a === undefined || sameDirt(a, b) ? b : { kind: "node" }
}

interface MutablePart {
	change: PartChanges["change"]
	readonly shapes: Map<number, Dirt>
	slide?: Dirt
}

const NO_CHANGES: DeckChanges = { empty: true, parts: new Map(), presentation: new Set() }

// The deck's changes against the saved state.
export function deckChanges(deck: Deck, history: DeckHistory, fingerprint: FingerprintOf): DeckChanges {
	const keys = history.dirtyTouchKeys()

	if (keys.size === 0) return NO_CHANGES

	const parts = new Map<string, MutablePart>()
	const presentation = new Set<Extract<Touch, { kind: "presentation" }>["what"]>()
	const partOf = (key: TouchKey, slide: SlideRef): string | undefined =>
		deck.nodes.get(slide)?.part ?? fingerprint(key).part ?? history.savedFingerprint(key)?.part
	const entry = (part: string): MutablePart => {
		let held = parts.get(part)

		if (held === undefined) {
			held = { change: "changed", shapes: new Map() }
			parts.set(part, held)
		}

		return held
	}

	for (const key of keys) {
		const parsed = parseTouchKey(key)

		switch (parsed.kind) {
			case "shape": {
				const part = partOf(key, parsed.slide)

				if (part === undefined) break

				const held = entry(part)

				held.shapes.set(parsed.shape, mergeDirt(held.shapes.get(parsed.shape), dirtOf(parsed.dirt)))
				break
			}
			case "slide": {
				const part = partOf(key, parsed.slide)

				if (part === undefined) break

				const held = entry(part)

				if (parsed.dirt === "n") {
					const now = fingerprint(key)
					const saved = history.savedFingerprint(key)

					if (!now.exists && saved?.exists !== false) held.change = "removed"
					else if (now.exists && saved?.exists === false) held.change = "added"
				}

				held.slide = mergeDirt(held.slide, dirtOf(parsed.dirt))
				break
			}
			case "presentation":
				presentation.add(parsed.what as Extract<Touch, { kind: "presentation" }>["what"])
				break
			case "part": {
				const held = entry(parsed.part)

				if (parsed.change === "added" || parsed.change === "removed") held.change = parsed.change
				break
			}
			case "order": {
				// A reorder rewrites the shapes that moved (each as a whole node, at its new place).
				const now = fingerprint(key)
				const saved = history.savedFingerprint(key)
				const part = now.part ?? saved?.part

				if (part === undefined) break

				const moved = now.order === undefined ? [] : saved?.order === undefined ? now.order : movedShapes(saved.order, now.order)

				if (moved.length === 0) break

				const held = entry(part)

				for (const id of moved) held.shapes.set(id, mergeDirt(held.shapes.get(id), { kind: "node" }))
				break
			}
		}
	}

	return { empty: parts.size === 0 && presentation.size === 0, parts, presentation }
}
