import { slideRef, type ShapeNode, type SlideRef } from "./model"

// Stable references and the identifiers a deck's markup needs unique:
//   SlideRef        one per slide, layout, master, notes and handout master of a session, never reused;
//   p:sldId/@id     ≥ 256 and < 2^31 (ECMA-376 Part 1 §19.2.1.34, ST_SlideId);
//   sldMasterId and sldLayoutId share one space ≥ 2^31, unique across every master and layout (§19.2.1.27,
//                   §19.3.1.41, ST_SlideMasterId / ST_SlideLayoutId);
//   cNvPr/@id       unique per slide (§19.3.1.12); real decks repeat them, so duplicates are reassigned on read
//                   and the written one kept in `sourceId`;
//   p14:creationId  a random 32-bit value per slide; modern-comment ids are GUIDs.

export const MIN_SLIDE_ID = 256
export const MAX_SLIDE_ID = 2_147_483_647
export const MIN_MASTER_LAYOUT_ID = 2_147_483_648
export const MAX_MASTER_LAYOUT_ID = 4_294_967_295

export class SlideRefs {
	private last = 0

	next(): SlideRef {
		return slideRef(++this.last)
	}
}

// The smallest free id above every used one in [min, max], else the smallest gap (a deck can use the top of the
// range); undefined when the range is full.
function freeId(used: Iterable<number>, min: number, max: number): number | undefined {
	const taken = new Set<number>()
	let highest = min - 1

	for (const id of used) {
		if (id < min || id > max) continue

		taken.add(id)
		if (id > highest) highest = id
	}

	if (highest < max) return highest + 1

	for (let id = min; id <= max; id++) if (!taken.has(id)) return id

	return undefined
}

export function nextSlideId(used: Iterable<number>): number | undefined {
	return freeId(used, MIN_SLIDE_ID, MAX_SLIDE_ID)
}

export function nextMasterLayoutId(used: Iterable<number>): number | undefined {
	return freeId(used, MIN_MASTER_LAYOUT_ID, MAX_MASTER_LAYOUT_ID)
}

function walk(shapes: readonly ShapeNode[], visit: (shape: ShapeNode) => void): void {
	for (const shape of shapes) {
		visit(shape)
		if (shape.children !== undefined) walk(shape.children, visit)
	}
}

// Makes every cNvPr id of a slide's tree (groups included) unique, in document order: the first use of an id
// keeps it, later ones get the next free id above all of them and keep the written one in `sourceId`. `reserved`
// holds ids the tree's root uses (the spTree's own nvGrpSpPr). Returns the number reassigned.
export function uniqueShapeIds(shapes: readonly ShapeNode[], reserved: readonly number[] = []): number {
	const seen = new Set<number>(reserved)
	let highest = 0

	for (const id of reserved) if (id > highest) highest = id

	walk(shapes, shape => {
		if (shape.id > highest) highest = shape.id
	})

	let reassigned = 0

	walk(shapes, shape => {
		if (shape.id > 0 && !seen.has(shape.id)) {
			seen.add(shape.id)

			return
		}

		shape.sourceId = shape.id
		shape.id = ++highest
		seen.add(shape.id)
		reassigned++
	})

	return reassigned
}

// The next cNvPr id for a new shape on a slide.
export function nextShapeId(shapes: readonly ShapeNode[]): number {
	let highest = 1

	walk(shapes, shape => {
		if (shape.id > highest) highest = shape.id
	})

	return highest + 1
}

// A source of random 32-bit words (the worker passes crypto.getRandomValues; tests a seeded one).
export type RandomWords = (count: number) => Uint32Array

export function creationId(random: RandomWords): number {
	return (random(1)[0] ?? 0) >>> 0
}

// A version 4 GUID in the braces PresentationML writes ({XXXXXXXX-XXXX-4XXX-YXXX-XXXXXXXXXXXX}).
export function newGuid(random: RandomWords): string {
	const words = random(4)
	const bytes = new Uint8Array(16)

	for (let index = 0; index < 4; index++) {
		const word = words[index] ?? 0

		bytes[index * 4] = word >>> 24
		bytes[index * 4 + 1] = (word >>> 16) & 0xff
		bytes[index * 4 + 2] = (word >>> 8) & 0xff
		bytes[index * 4 + 3] = word & 0xff
	}

	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

	const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase()

	return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`
}
