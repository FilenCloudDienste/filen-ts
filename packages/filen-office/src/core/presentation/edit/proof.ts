import type { Relationships } from "../../opc/index"
import { emitFamilyOf, emitPptx } from "../../pptx/write/emit"
import type { EmitRequest, EmitResult, PartsApi, PptxEmitContext } from "../../pptx/write/types"
import { encodeUtf8, NodeKind, XmlError, type XmlDocument } from "../../xml/index"
import { PresentationError, type Deck, type LockReason, type ShapeNode, type SlideNode } from "../model"
import type { DeckOpFamily } from "./ops"
import { canonicalXml, inheritedDeclarations, parseInScope } from "./canonical"

// Proof gate 1: before the first edit on a slide, every source shape of it is written by the emitters as if it
// were dirty and the markup compared with its source at XML-meaning level (canonical.ts). A shape that does not
// come out as it went in is locked (`proofFailed`): it stays selectable and keeps its bytes, and it moves only when
// its xfrm is provable on its own (an a:xfrm of a:off/a:ext alone, rewritten by attributes). The same contract as
// the docx editor's BlockProof, over shapes; the docx helpers are typed to its story schema and are not used.

export type EmitFunction = (family: DeckOpFamily, request: EmitRequest, context: PptxEmitContext) => EmitResult

export interface ProofInput {
	readonly deck: Deck
	readonly slide: SlideNode
	// The slide part's parsed source.
	readonly document: XmlDocument
	readonly relationships: Relationships
	// The emitters (emitPptx by default; tests pass their own).
	readonly emit?: EmitFunction
}

export interface ShapeProof {
	// Undefined when `shape` round-trips; otherwise why it is locked.
	check(input: ProofInput, shape: ShapeNode): LockReason | undefined
}

export interface ProofTally {
	readonly shapes: number
	readonly locked: Partial<Record<LockReason, number>>
	// Locked shapes that still move (their xfrm proves).
	readonly movable: number
	// Why emits refused or differed, by detail (diagnostics, never shown to a user).
	readonly failures: Readonly<Record<string, number>>
}

const movable = new WeakSet<ShapeNode>()

// A shape whose content proof failed but whose xfrm proves: setXfrm is allowed. `documentOf` resolves the source
// of a copy of a proved shape (a duplicated slide's, a re-read one's): the same check on its own markup.
export function isMovable(shape: ShapeNode, documentOf?: (part: string) => XmlDocument | undefined): boolean {
	if (movable.has(shape)) return true
	if (shape.lock !== "proofFailed" || shape.src?.format !== "pptx" || documentOf === undefined) return false

	const document = documentOf(shape.src.part)

	if (document === undefined || shape.src.node <= 0 || shape.src.node >= document.count || !xfrmProves(document, shape.src.node))
		return false

	movable.add(shape)

	return true
}

class ProofParts implements PartsApi {
	readonly owner: string
	private readonly relationships: Relationships

	constructor(owner: string, relationships: Relationships) {
		this.owner = owner
		this.relationships = relationships
	}

	addPart(): never {
		throw new PresentationError("proofFailed", "an unedited shape added a part")
	}

	relate(target: string, type: string, external?: boolean): string {
		for (const relationship of this.relationships.all) {
			const name = relationship.partName === undefined ? relationship.target : `/${relationship.partName}`

			if (relationship.type === type && name === target && relationship.external === (external ?? false)) return relationship.id
		}

		throw new PresentationError("proofFailed", "an unedited shape related a new target")
	}

	target(rId: string): string | undefined {
		const relationship = this.relationships.byId(rId)

		if (relationship === undefined) return undefined

		return relationship.external || relationship.partName === undefined ? relationship.target : `/${relationship.partName}`
	}

	removePart(): never {
		throw new PresentationError("proofFailed", "an unedited shape removed a part")
	}

	editor(): never {
		throw new PresentationError("proofFailed", "an unedited shape opened an editor")
	}
}

// The emitted markup as bytes, holes copied from the source document.
export function markupBytes(result: Extract<EmitResult, { kind: "markup" }>, document: XmlDocument | undefined): Uint8Array {
	const chunks: Uint8Array[] = []
	let length = 0

	for (const piece of result.pieces) {
		let chunk: Uint8Array

		if (typeof piece === "string") chunk = encodeUtf8(piece)
		else if (piece instanceof Uint8Array) chunk = piece
		else if (document === undefined) throw new PresentationError("proofFailed", "a hole without a source")
		else chunk = document.raw(piece.hole)

		chunks.push(chunk)
		length += chunk.length
	}

	const out = new Uint8Array(length)
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

function childElements(document: XmlDocument, node: number): number[] {
	const out: number[] = []

	for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
		if (document.kind(child) === NodeKind.Element) out.push(child)
	}

	return out
}

function childNamed(document: XmlDocument, node: number, local: string): number {
	for (const child of childElements(document, node)) if (document.localName(child) === local) return child

	return -1
}

const XFRM_CHILDREN: ReadonlySet<string> = new Set(["off", "ext", "chOff", "chExt"])

// Whether the shape's own a:xfrm (or p:xfrm of a graphic frame) is one an attribute rewrite reproduces: only
// off/ext (chOff/chExt on a group), or none at all (an inherited box gets one inserted).
export function xfrmProves(document: XmlDocument, element: number): boolean {
	let xfrm = -1

	switch (document.localName(element)) {
		case "sp":
		case "cxnSp":
		case "pic":
			xfrm = childNamed(document, childNamed(document, element, "spPr"), "xfrm")
			break
		case "grpSp":
			xfrm = childNamed(document, childNamed(document, element, "grpSpPr"), "xfrm")
			break
		case "graphicFrame":
		case "contentPart":
			xfrm = childNamed(document, element, "xfrm")
			break
		default:
			return false
	}

	if (xfrm < 0) return true

	return childElements(document, xfrm).every(child => XFRM_CHILDREN.has(document.localName(child)))
}

// The emitters' proof: an unedited shape written whole compares equal to its source by meaning.
export const emitterProof: ShapeProof = {
	check(input, shape) {
		const src = shape.src

		if (src?.format !== "pptx" || src.part !== input.slide.part) return undefined

		const request: EmitRequest = {
			slide: input.slide,
			shape,
			touch: { kind: "shape", slide: input.slide.ref, shape: shape.id, dirt: { kind: "node" } }
		}
		const context: PptxEmitContext = {
			deck: input.deck,
			document: input.document,
			parts: new ProofParts(input.slide.part, input.relationships)
		}
		let result: EmitResult

		try {
			result = (input.emit ?? emitPptx)(emitFamilyOf(request), request, context)
		} catch (error) {
			if (error instanceof PresentationError) {
				failure(error.message)

				return "proofFailed"
			}

			throw error
		}

		if (result.kind === "unchanged") return undefined
		if (result.kind === "refused") {
			failure(`refused ${result.reason}${result.detail === undefined ? "" : ` ${result.detail}`}`)

			return "proofFailed"
		}

		try {
			const parsed = parseInScope(markupBytes(result, input.document), inheritedDeclarations(input.document, src.node))

			if (parsed.node >= 0 && canonicalXml(parsed.document, parsed.node) === canonicalXml(input.document, src.node)) return undefined

			failure(`differs ${input.document.localName(src.node)}`)
		} catch (error) {
			if (!(error instanceof XmlError) && !(error instanceof PresentationError)) throw error

			failure("not well formed")
		}

		return "proofFailed"
	}
}

let failures: Record<string, number> | undefined

function failure(detail: string): void {
	if (failures !== undefined) failures[detail] = (failures[detail] ?? 0) + 1
}

function walk(shapes: readonly ShapeNode[], visit: (shape: ShapeNode) => void): void {
	for (const shape of shapes) {
		visit(shape)
		if (shape.children !== undefined) walk(shape.children, visit)
	}
}

// Proves every shape of a slide once, locking the ones that fail. Shapes the reader locked already
// (alternateContent, unknownFrame) keep their lock and count under it; a proved group's children are proved by it.
export function proveSlide(input: ProofInput, proof: ShapeProof = emitterProof): ProofTally {
	const locked: Partial<Record<LockReason, number>> = {}
	const seen: Record<string, number> = {}
	let shapes = 0
	let moves = 0

	failures = seen

	try {
		const visit = (list: readonly ShapeNode[], insideProved: boolean): void => {
			for (const shape of list) {
				shapes++

				if (shape.lock !== undefined) {
					locked[shape.lock] = (locked[shape.lock] ?? 0) + 1
					if (shape.children !== undefined) walk(shape.children, () => shapes++)

					continue
				}

				const reason = insideProved ? undefined : proof.check(input, shape)

				if (reason !== undefined) {
					shape.lock = reason
					locked[reason] = (locked[reason] ?? 0) + 1

					const src = shape.src

					if (src?.format === "pptx" && src.part === input.slide.part && xfrmProves(input.document, src.node)) {
						movable.add(shape)
						moves++
					}

					// The group's own markup failed: each child is proved on its own (one that fails is locked too).
					if (shape.children !== undefined) visit(shape.children, false)

					continue
				}

				if (shape.children !== undefined) visit(shape.children, true)
			}
		}

		visit(input.slide.shapes, false)
	} finally {
		failures = undefined
	}

	return { shapes, locked, movable: moves, failures: seen }
}
