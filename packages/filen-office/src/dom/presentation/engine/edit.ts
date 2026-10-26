import { encodeUtf8, escapeAttribute, parseXml, type XmlDocument } from "../../../core/xml/index"
import { parseRelationships, partKey, relationshipsPartName, Relationships } from "../../../core/opc/index"
import type { PptxParts } from "../../../core/pptx/package"
import { readSlidePart } from "../../../core/pptx/read/slide"
import { P_MAIN } from "../../../core/pptx/read/xml"
import { DeckTally } from "../../../core/presentation/budget"
import {
	applyOp,
	opTouches,
	type ApplyContext,
	type DeckChanges,
	type Dirt,
	type Inverse,
	type Touch
} from "../../../core/presentation/edit/apply"
import { isRefused } from "../../../core/presentation/edit/apply/shape"
import type { SlideSourceReading } from "../../../core/presentation/edit/apply/slide"
import { inheritedDeclarations } from "../../../core/presentation/edit/canonical"
import { deckChanges, deckFingerprints, findShape, fingerprintTouches, orderKey } from "../../../core/presentation/edit/changes"
import {
	DeckHistory,
	opBytesOf,
	type HistoryStep,
	touchKey,
	UNKNOWN_FINGERPRINT,
	type Fingerprint,
	type FingerprintOf,
	type TouchKey
} from "../../../core/presentation/edit/history"
import {
	jumpsTo,
	OWNED_KINDS,
	planDelete,
	type PartOf,
	type PartReference,
	type ReferenceFacts
} from "../../../core/presentation/edit/integrity"
import type { DeckOp, RawPart } from "../../../core/presentation/edit/ops"
import { isMovable, proveSlide, type EmitFunction, type ProofTally } from "../../../core/presentation/edit/proof"
import { nextShapeId } from "../../../core/presentation/ids"
import { sliceClock, type Slicing } from "../../../core/slicing"
import {
	PresentationError,
	refused,
	slideRef,
	type Deck,
	type Refused,
	type ShapeNode,
	type ShapeRef,
	type SlideNode,
	type SlideRef,
	type SourceRef
} from "../../../core/presentation/model"
import type { TextSeed } from "../../../core/presentation/output"
import type { CallContext, EditCapability, EngineSession } from "../engine"
import type { CommandResult } from "../protocol"
import { bindSaveHistory, deckTurn } from "../save"
import { pptxParts } from "./open/pptx"
import { textCapability } from "./text"

// The edit capability: commands, undo and redo over the session's model, with the deck history (edit/history.ts).
// Before an op applies, every node it touches is parsed and its slide proved once (proof gate 1); the history
// records each step with what it touched before and after, so dirtiness is recomputed (edit/changes.ts). Commands
// run one at a time per session; the save capability runs its snapshot through the same queue (sessionEdits), so a
// snapshot never interleaves with an op.
//
// Source markup an inverse holds is read back as the deck's reader reads it, into documents the session keeps
// under "raw:" names: a shape's or slide's `src` names one after a save's rebase made its old ref stale.

const RAW_PREFIX = "raw:"
// The shared parts a slide delete holds for its undo: at most this share of the history's byte budget.
const SHARED_SHARE = 4
// Refs the session allocates sit above every ref the reader hands out.
const SESSION_REFS = 0x4000_0000

interface RawDocument {
	readonly document: XmlDocument
	// The part these bytes were (a slide restored from an inverse), for the writer.
	readonly part?: RawPart
	// A restored slide's: every part its restore entry held (the slide first, then its owned parts and the shared
	// ones its delete removed), for the writer to add back.
	readonly parts?: readonly RawPart[]
	// The part name the restored node has (free in the package and the session).
	readonly nodePart?: string
}

export interface EditOptions {
	// The emitters proof gate 1 checks with (emitPptx by default).
	readonly emit?: EmitFunction
}

interface EpochCache {
	readonly epoch: number
	readonly bytes: Map<string, Uint8Array>
	readonly relationships: Map<string, Relationships>
	// A slide part's root declarations, for reading held markup back when its document is not held (dropped by a
	// rebase that rewrote the part).
	readonly scopes: Map<string, string>
	facts?: Map<string, PartReference[]>
}

interface EditState {
	readonly history: DeckHistory
	readonly fingerprint: FingerprintOf
	readonly raw: Map<string, RawDocument>
	// Slides proved (gate 1), with their tallies.
	readonly proved: Map<SlideRef, ProofTally>
	// Part bytes and relationships read for the current epoch (inverses and the reference graph).
	cache: EpochCache
	readonly allocatedParts: Set<string>
	// Each part's references, by its relationships part's zip entry (CRC-32 and size): a save's rebase copies the
	// entries it did not rewrite, so the graph is read again only where the save changed it.
	readonly references: Map<string, HeldReferences>
	nextRef: number
	nextRaw: number
}

interface HeldReferences {
	readonly crc32: number
	readonly size: number
	readonly references: PartReference[]
}

const states = new WeakMap<EngineSession, EditState>()

function partsOf(session: EngineSession): PptxParts {
	const parts = pptxParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", `editing ${session.deck.format}`)

	return parts
}

function stateOf(session: EngineSession): EditState {
	const held = states.get(session)

	if (held !== undefined) return held

	const raw = new Map<string, RawDocument>()
	const fingerprint = deckFingerprints(session.deck, src => sourceBytes(session, raw, src))
	const state: EditState = {
		history: new DeckHistory(fingerprint),
		fingerprint,
		raw,
		proved: new Map(),
		cache: { epoch: -1, bytes: new Map(), relationships: new Map(), scopes: new Map() },
		allocatedParts: new Set(),
		references: new Map(),
		nextRef: SESSION_REFS,
		nextRaw: 1
	}

	states.set(session, state)
	bindSaveHistory(session.deck, {
		get revision() {
			return state.history.revision
		},
		get dirty() {
			return state.history.dirty
		},
		changes: () => deckChanges(session.deck, state.history, fingerprint),
		savePoint: () => state.history.savePoint(),
		commit: point => {
			state.history.commit(point)
		},
		abandon: point => {
			state.history.abandon(point)
		},
		revert: parts => revert(session, state, parts, {})
	})
	session.onClose(() => {
		const parts = pptxParts(session.deck)

		for (const name of raw.keys()) parts?.forget(name)

		raw.clear()
		state.proved.clear()
		state.cache.bytes.clear()
		state.cache.relationships.clear()
		state.references.clear()
		state.history.clear()
	})

	return state
}

// An element's bytes with the namespace declarations of its ancestors below the root added to its start tag, so a
// copy reads on its own inside a part's root scope. Most elements need none (PresentationML declares at the root).
function withAncestorDeclarations(document: XmlDocument, node: number): Uint8Array {
	const raw = document.raw(node)
	const root = document.documentElement()

	if (node === root || document.parent(node) === root) return raw

	const atRoot = inheritedDeclarations(document, document.firstChildElement(root))
	const own = new Set(document.attributes(node).map(attribute => attribute.name))
	let extra = ""

	for (const [prefix, uri] of inheritedDeclarations(document, node)) {
		const name = prefix === "" ? "xmlns" : `xmlns:${prefix}`

		if (atRoot.get(prefix) === uri || own.has(name)) continue

		extra += ` ${name}="${escapeAttribute(uri)}"`
	}

	if (extra === "") return raw

	const nameEnd = 1 + encodeUtf8(document.name(node)).length
	const head = encodeUtf8(extra)
	const out = new Uint8Array(raw.length + head.length)

	out.set(raw.subarray(0, nameEnd), 0)
	out.set(head, nameEnd)
	out.set(raw.subarray(nameEnd), nameEnd + head.length)

	return out
}

function sourceBytes(session: EngineSession, raw: ReadonlyMap<string, RawDocument>, src: SourceRef): Uint8Array | Refused {
	if (src.format !== "pptx") return refused("notImplemented", `${src.format} source`)

	const held = raw.get(src.part)

	if (held !== undefined) return withAncestorDeclarations(held.document, src.node)

	const parts = pptxParts(session.deck)

	if (parts === undefined) return refused("notImplemented", "source")
	if (src.epoch !== parts.epoch) return refused("stale", src.part)

	const document = parts.document(src.part)

	if (document === undefined || src.node <= 0 || src.node >= document.count) return refused("notFound", src.part)

	return withAncestorDeclarations(document, src.node)
}

function cacheOf(state: EditState, parts: PptxParts): EpochCache {
	if (state.cache.epoch !== parts.epoch)
		state.cache = { epoch: parts.epoch, bytes: new Map(), relationships: new Map(), scopes: new Map() }

	return state.cache
}

async function relationshipsOf(state: EditState, parts: PptxParts, part: string): Promise<Relationships> {
	const cache = cacheOf(state, parts)
	const key = partKey(part)
	const held = cache.relationships.get(key)

	if (held !== undefined) return held

	const relationships = parts.opc.has(part) ? await parts.opc.relationships(part.slice(1)) : new Relationships([])

	cache.relationships.set(key, relationships)

	return relationships
}

async function readBytes(state: EditState, parts: PptxParts, part: string): Promise<void> {
	const cache = cacheOf(state, parts)
	const key = partKey(part)

	if (cache.bytes.has(key) || !parts.opc.has(part)) return

	cache.bytes.set(key, parts.document(part)?.bytes ?? (await parts.opc.read(part)))
}

// A part's root declarations when its parsed document is not held (read once per epoch from its bytes).
async function scopeOf(state: EditState, parts: PptxParts, part: string): Promise<void> {
	const cache = cacheOf(state, parts)
	const key = partKey(part)

	if (parts.document(part) !== undefined || cache.scopes.has(key) || !parts.opc.has(part)) return

	cache.scopes.set(key, rootScope(parseXml(await parts.opc.read(part))))
}

function kindOf(type: string): string {
	return type.slice(type.lastIndexOf("/") + 1)
}

function referencesOf(relationships: Relationships): PartReference[] {
	const out: PartReference[] = []

	for (const relationship of relationships.all) {
		if (relationship.external || relationship.partName === undefined) continue

		out.push({ kind: kindOf(relationship.type), part: `/${relationship.partName}` })
	}

	return out
}

const XML_PART = /\.xml$/iu

// A part's references: the ones held for its relationships entry when the entry is unchanged (same CRC-32 and size;
// an in-memory package's entries carry no CRC and are read), else read.
async function referencesFor(state: EditState, parts: PptxParts, part: string): Promise<PartReference[]> {
	const entry = parts.opc.entry(relationshipsPartName(parts.opc.entry(part)?.name ?? part.slice(1)))

	if (entry === undefined) return []

	const key = partKey(part)
	const held = state.references.get(key)

	if (held !== undefined && entry.crc32 !== 0 && held.crc32 === entry.crc32 && held.size === entry.uncompressedSize)
		return held.references

	const references = referencesOf(await relationshipsOf(state, parts, part))

	state.references.set(key, { crc32: entry.crc32, size: entry.uncompressedSize, references })

	return references
}

// Every XML part's references reachable from the presentation part, once per epoch (relationships parts a save left
// as they were are not read again), giving the host a turn whenever the slice is used up.
async function loadFacts(state: EditState, parts: PptxParts, slicing: Slicing | undefined): Promise<void> {
	const cache = cacheOf(state, parts)

	if (cache.facts !== undefined) return

	const clock = slicing === undefined ? undefined : sliceClock(slicing)
	const facts = new Map<string, PartReference[]>()
	const queue = [mainPart(parts)]
	const live = new Set<string>()

	while (queue.length > 0) {
		const part = queue.pop() as string

		if (facts.has(part) || !XML_PART.test(part)) continue
		if (clock?.due === true) await clock.pause()

		const references = await referencesFor(state, parts, part)

		facts.set(part, references)
		live.add(partKey(part))

		for (const reference of references) if (!facts.has(reference.part)) queue.push(reference.part)
	}

	// Parts gone from the package are forgotten.
	for (const key of state.references.keys()) if (!live.has(key)) state.references.delete(key)

	if (cacheOf(state, parts) === cache) cache.facts = facts
}

// The "raw:" name holding the part of a node restored from an inverse.
function rawNameOf(state: EditState, part: string): string | undefined {
	for (const [name, held] of state.raw) if ((held.nodePart ?? held.part?.name) === part) return name

	return undefined
}

function factsOf(state: EditState): ReferenceFacts {
	const facts = state.cache.facts ?? new Map<string, PartReference[]>()

	return {
		references: part => {
			const held = facts.get(part)

			if (held !== undefined) return held

			// A slide restored from an inverse refers to what its held relationships name.
			const raw = state.raw.get(rawNameOf(state, part) ?? "")?.part

			return raw?.rels === undefined ? undefined : referencesOf(parseRelationships(raw.rels, part.slice(1)))
		},
		parts: () => facts.keys()
	}
}

const MAIN_TYPE =
	/presentationml\.(?:presentation|slideshow|template)\.main\+xml$|powerpoint\.(?:presentation|slideshow|template)\.macroenabled\.main\+xml$/iu

function mainPart(parts: PptxParts): string {
	for (const entry of parts.opc.entries()) {
		const type = parts.contentTypes.typeOf(entry.name)

		if (type !== undefined && MAIN_TYPE.test(type)) return `/${entry.name}`
	}

	return "/ppt/presentation.xml"
}

// The parts a slide owns (edit/integrity.ts), depth first.
function ownedParts(facts: ReferenceFacts, part: string): string[] {
	const out: string[] = []
	const seen = new Set([part])
	const walk = (from: string, depth: number): void => {
		for (const reference of facts.references(from) ?? []) {
			if (seen.has(reference.part) || !OWNED_KINDS.has(reference.kind)) continue

			seen.add(reference.part)
			out.push(reference.part)
			if (depth < 8) walk(reference.part, depth + 1)
		}
	}

	walk(part, 0)

	return out
}

const PART_PREFIXES = { slide: "ppt/slides/slide", notesSlide: "ppt/notesSlides/notesSlide" } as const

function newPartName(state: EditState, deck: Deck, parts: PptxParts, kind: keyof typeof PART_PREFIXES): string {
	const prefix = PART_PREFIXES[kind]
	let highest = 0
	const see = (name: string): void => {
		const key = partKey(name)

		if (!key.startsWith(prefix.toLowerCase()) || !key.endsWith(".xml")) return

		const number = Number(key.slice(prefix.length, -4))

		if (Number.isInteger(number) && number > highest) highest = number
	}

	for (const entry of parts.opc.entries()) see(entry.name)
	for (const node of deck.nodes.values()) see(node.part)
	for (const name of state.allocatedParts) see(name)

	const name = `/${prefix}${String(highest + 1)}.xml`

	state.allocatedParts.add(name)

	return name
}

// The declarations of a part document's root (what a held element is read inside).
function rootScope(document: XmlDocument | undefined): string {
	if (document === undefined) return ""

	let out = ""

	for (const [prefix, uri] of inheritedDeclarations(document, document.firstChildElement(document.documentElement()))) {
		if (uri === "") continue

		out += prefix === "" ? ` xmlns="${escapeAttribute(uri)}"` : ` xmlns:${prefix}="${escapeAttribute(uri)}"`
	}

	return out
}

function join(...pieces: (string | Uint8Array)[]): Uint8Array {
	const chunks = pieces.map(piece => (typeof piece === "string" ? encodeUtf8(piece) : piece))
	const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

// A slide part (or the wrapper around a held shape) read as the pptx reader reads slides.
function readPart(parts: PptxParts, ref: SlideRef, name: string, document: XmlDocument, relationships: Relationships): SlideNode {
	return readSlidePart({
		ref,
		part: name,
		document,
		relationships,
		epoch: parts.epoch,
		// Re-read content is already in the deck's totals: a scratch tally holds it to the per-part budgets.
		tally: new DeckTally(parts.budgets),
		media: {
			contentType: part => parts.contentTypes.typeOf(part.slice(1)),
			size: part => parts.opc.entry(part)?.uncompressedSize
		},
		refOf: part => parts.refOf(part),
		themeOf: () => undefined,
		action: (reader, rels, node) => parts.action(reader, rels, node)
	}).node
}

// Held under a "raw:" name the package answers too, so the renderer and the emitters resolve its refs.
function holdRaw(state: EditState, parts: PptxParts, document: XmlDocument, held: Omit<RawDocument, "document"> = {}): string {
	const name = `${RAW_PREFIX}${String(state.nextRaw++)}`

	state.raw.set(name, { document, ...held })
	parts.adopt(name, document)

	return name
}

// A held part's name for its restored node when nothing in the package or the session has it, else a new one.
function freePartName(state: EditState, deck: Deck, parts: PptxParts, name: string, kind: keyof typeof PART_PREFIXES): string {
	const key = partKey(name)
	let taken = parts.opc.has(name) || state.allocatedParts.has(name)

	for (const node of deck.nodes.values()) if (!taken && partKey(node.part) === key) taken = true
	for (const held of state.raw.values()) if (!taken && held.nodePart !== undefined && partKey(held.nodePart) === key) taken = true

	if (taken) return newPartName(state, deck, parts, kind)

	state.allocatedParts.add(name)

	return name
}

// Relationship kinds a restored part may name outside what it held: the writer re-targets or drops slide jumps.
const RESTORE_UNCHECKED: ReadonlySet<string> = new Set(["slide"])

function rawDocumentOf(state: EditState, part: string): XmlDocument | undefined {
	const name = rawNameOf(state, part)

	return name === undefined ? undefined : state.raw.get(name)?.document
}

// The engine's half of the apply context: allocators, source bytes, and reading held markup back. Synchronous: what
// it reads was prepared (prepare()).
function contextFor(session: EngineSession, state: EditState): SlideSourceReading {
	const parts = partsOf(session)
	const deck = session.deck
	const facts = factsOf(state)
	const cache = cacheOf(state, parts)
	const readHeld = (part: RawPart, ref: SlideRef, name: string, all?: readonly RawPart[]): SlideNode | Refused => {
		let document: XmlDocument

		try {
			document = parseXml(part.bytes)
		} catch {
			return refused("malformed", part.name)
		}

		const relationships = part.rels === undefined ? new Relationships([]) : parseRelationships(part.rels, part.name.slice(1))
		const node = readPart(
			parts,
			ref,
			holdRaw(state, parts, document, { part, nodePart: name, ...(all === undefined ? {} : { parts: all }) }),
			document,
			relationships
		)

		// The node has a part of its own again (the writer adds it there); its sources are the held document.
		node.part = name

		return node
	}

	return {
		sourceBytes: src => sourceBytes(session, state.raw, src),
		newShapeId: slide => nextShapeId(deck.nodes.get(slide)?.shapes ?? []),
		newSlideRef: () => slideRef(state.nextRef++),
		movable: shape => isMovable(shape, part => parts.document(part) ?? state.raw.get(part)?.document),
		readShape(slide, raw) {
			const held = parts.document(slide.part) ?? rawDocumentOf(state, slide.part)
			const scope = held === undefined ? (cache.scopes.get(partKey(slide.part)) ?? "") : rootScope(held)
			const relationships = cache.relationships.get(partKey(slide.part)) ?? new Relationships([])
			let document: XmlDocument

			try {
				document = parseXml(
					join(
						`<w:sld xmlns:w="${P_MAIN}"${scope}><w:cSld><w:spTree><w:nvGrpSpPr><w:cNvPr id="0" name=""/><w:cNvGrpSpPr/><w:nvPr/></w:nvGrpSpPr><w:grpSpPr/>`,
						raw,
						"</w:spTree></w:cSld></w:sld>"
					)
				)
			} catch {
				return refused("malformed", "held shape markup")
			}

			const shape = readPart(parts, slide.ref, holdRaw(state, parts, document), document, relationships).shapes[0]

			return shape === undefined ? refused("malformed", "held shape markup") : shape
		},
		rawParts(slide, removed) {
			// A held list stands for the slide only while its held document is the node's live source: once a save wrote
			// the slide and the rebase moved its source into the package, the package's parts are the slide's.
			const held = slide.src?.format === "pptx" ? state.raw.get(slide.src.part) : undefined

			if (held?.part !== undefined) return held.parts ?? [held.part]
			if (!parts.opc.has(slide.part)) return []

			const out: RawPart[] = []
			const hold = (name: string): void => {
				const bytes = cache.bytes.get(partKey(name)) as Uint8Array
				const rels = cache.bytes.get(partKey(relationshipsPartName(name)))
				// Targets the package lacks already (a damaged source): restored as they were, never as new damage.
				const absent = (facts.references(name) ?? [])
					.filter(reference => !parts.opc.has(reference.part))
					.map(reference => reference.part)

				out.push({
					name,
					contentType: parts.contentTypes.typeOf(name.slice(1)) ?? "application/xml",
					bytes,
					...(rels === undefined ? {} : { rels }),
					...(absent.length === 0 ? {} : { absent })
				})
			}
			// An owned part the package does not have (the source's relationship already dangles) has nothing to hold.
			const own = [slide.part, ...ownedParts(facts, slide.part).filter(name => parts.opc.has(name))]

			for (const name of own) {
				if (!cache.bytes.has(partKey(name))) return refused("notFound", `part ${name} not read`)

				hold(name)
			}

			if (removed === undefined) return out

			// Shared parts the delete removes (read when they fit the budget): after its save they are gone.
			const named = new Set(own.map(partKey))

			for (const from of own) {
				for (const reference of facts.references(from) ?? []) {
					const key = partKey(reference.part)

					if (named.has(key) || !removed.has(reference.part) || !cache.bytes.has(key)) continue

					named.add(key)
					hold(reference.part)
				}
			}

			return out
		},
		readSlides(ref, held) {
			const slidePart = held[0]

			if (slidePart === undefined) return refused("malformed", "a restore without its slide part")

			// Every part a held one relates to is held or still in the package (a shared part too large to hold is
			// gone once the delete was saved): the slide comes back whole or not at all.
			const names = new Set(held.map(part => partKey(part.name)))
			const references = new Map<string, PartReference[]>()

			for (const part of held) {
				const list = part.rels === undefined ? [] : referencesOf(parseRelationships(part.rels, part.name.slice(1)))

				references.set(part.name, list)

				for (const reference of list) {
					if (
						RESTORE_UNCHECKED.has(reference.kind) ||
						names.has(partKey(reference.part)) ||
						parts.opc.has(reference.part) ||
						part.absent?.includes(reference.part) === true
					)
						continue

					return refused("stale", `${reference.part} of the deleted slide is no longer held`)
				}
			}

			const slide = readHeld(slidePart, ref, freePartName(state, deck, parts, slidePart.name, "slide"), held)

			if (isRefused(slide)) return slide

			const notesTarget = (references.get(slidePart.name) ?? []).find(reference => reference.kind === "notesSlide")
			const notesPart = notesTarget === undefined ? undefined : held.find(part => part.name === notesTarget.part)

			if (notesPart === undefined) return [slide]

			const notes = readHeld(notesPart, slideRef(state.nextRef++), freePartName(state, deck, parts, notesPart.name, "notesSlide"))

			if (isRefused(notes)) return notes

			slide.notes = notes.ref

			return [slide, notes]
		},
		newPart: kind => newPartName(state, deck, parts, kind),
		facts,
		partOf: partOf(deck, parts)
	}
}

function partOf(deck: Deck, parts: PptxParts): PartOf {
	return ref => parts.partOf(ref) ?? deck.nodes.get(ref)?.part
}

function slidesOf(touches: readonly Touch[]): Set<SlideRef> {
	const out = new Set<SlideRef>()

	for (const touch of touches) if (touch.kind === "shape" || touch.kind === "slide") out.add(touch.slide)

	return out
}

async function prove(session: EngineSession, state: EditState, node: SlideNode, options: EditOptions): Promise<void> {
	if (state.proved.has(node.ref) || node.kind !== "slide") return

	const parts = partsOf(session)
	const document = parts.document(node.part)

	if (document === undefined) return

	const lockedBefore = new Set<ShapeNode>()
	const collect = (shapes: readonly ShapeNode[]): void => {
		for (const shape of shapes) {
			if (shape.lock !== undefined) lockedBefore.add(shape)
			if (shape.children !== undefined) collect(shape.children)
		}
	}

	collect(node.shapes)
	state.proved.set(
		node.ref,
		proveSlide({
			deck: session.deck,
			slide: node,
			document,
			relationships: await relationshipsOf(state, parts, node.part),
			...(options.emit === undefined ? {} : { emit: options.emit })
		})
	)

	const notify = (shapes: readonly ShapeNode[]): void => {
		for (const shape of shapes) {
			if (shape.lock === "proofFailed" && !lockedBefore.has(shape)) {
				session.emit({ type: "notice", notice: { kind: "lock", shape: { slide: node.ref, id: shape.id }, reason: "proofFailed" } })
			}

			if (shape.children !== undefined) notify(shape.children)
		}
	}

	notify(node.shapes)
}

// Everything an op needs before it applies: its slides parsed and proved, their relationships, and for the
// structure ops the reference graph, the slides that jump to a deleted one, and the parts an inverse holds.
async function prepare(
	session: EngineSession,
	state: EditState,
	op: DeckOp,
	slicing: CallContext["slicing"] | undefined,
	options: EditOptions
): Promise<void> {
	const parts = partsOf(session)
	const deck = session.deck
	// Only a listed slide is read from the package (a deleted one's ref may still name its old part).
	const parse = async (ref: SlideRef): Promise<SlideNode | undefined> => {
		const held = deck.nodes.get(ref)

		if (held !== undefined) return held
		if (!deck.slides.includes(ref) || parts.partOf(ref) === undefined) return undefined

		return parts.slide(ref, slicing)
	}
	const slides = slidesOf(opTouches(op))

	if (op.family === "slide") {
		if (op.kind === "delete" || op.kind === "hide" || op.kind === "move") for (const ref of op.slides) slides.add(ref)
		if (op.kind === "duplicate" || op.kind === "setLayout" || op.kind === "reset") slides.add(op.slide)
	}

	for (const ref of slides) {
		const node = await parse(ref)

		if (node === undefined) continue

		await relationshipsOf(state, parts, node.part)
		await scopeOf(state, parts, node.part)
		await prove(session, state, node, options)
	}

	if (op.family !== "slide" || !(op.kind === "delete" || op.kind === "restore" || op.kind === "duplicate")) return

	await loadFacts(state, parts, slicing)

	const facts = factsOf(state)
	const graph = cacheOf(state, parts).facts ?? new Map<string, PartReference[]>()
	const read = async (part: string): Promise<void> => {
		await readBytes(state, parts, part)
		await readBytes(state, parts, relationshipsPartName(part))
	}

	if (op.kind === "restore") {
		for (const entry of op.slides) for (const part of entry.parts) await read(part.name)

		return
	}

	if (op.kind === "duplicate") return

	const named = op.slides.map(ref => deck.nodes.get(ref)?.part ?? parts.partOf(ref))

	for (const name of named) if (name !== undefined) for (const part of [name, ...ownedParts(facts, name)]) await read(part)

	// Slides jumping to a deleted one are parsed and proved, so their jumps are rewritten (or the delete refused
	// on a locked shape).
	const targets = new Set(named)
	const gone = new Set(op.slides)

	for (const ref of deck.slides) {
		const part = parts.partOf(ref)

		if (part === undefined || deck.nodes.has(ref) || gone.has(ref)) continue
		if ((graph.get(part) ?? []).some(reference => reference.kind === "slide" && targets.has(reference.part))) await parse(ref)
	}

	for (const { site } of jumpsTo(deck, gone)) {
		const node = deck.nodes.get(site.shape.slide)

		if (node === undefined) continue

		await relationshipsOf(state, parts, node.part)
		await scopeOf(state, parts, node.part)
		await prove(session, state, node, options)
	}

	// The shared parts the delete removes (a picture only these slides show) are held with it, within a budget: an
	// undo after the save that removed them puts them back. Past the budget the undo is refused once they are gone.
	const own = new Set<string>()

	for (const name of named) if (name !== undefined) for (const part of [name, ...ownedParts(facts, name)]) own.add(part)

	const shared = planDelete(deck, op.slides, facts, partOf(deck, parts)).remove.filter(part => !own.has(part))
	let size = 0

	for (const part of shared) size += parts.opc.entry(part)?.uncompressedSize ?? 0

	if (size <= state.history.limits.maxBytes / SHARED_SHARE) for (const part of shared) await read(part)
}

// Applies ops in order; on a refusal, what applied is undone in reverse and the refusal returned.
function applyAll(deck: Deck, ops: readonly DeckOp[], context: ApplyContext): { readonly inverses: Inverse[] } | Refused {
	const inverses: Inverse[] = []

	for (const op of ops) {
		const result = applyOp(deck, op, context)

		if (result.kind === "refused") {
			for (let index = inverses.length - 1; index >= 0; index--) {
				for (const back of (inverses[index] as Inverse).ops) applyOp(deck, back, context)
			}

			return result
		}

		inverses.push(result.inverse)
	}

	return { inverses }
}

function unique(touches: readonly Touch[]): Touch[] {
	return [...new Map(touches.map(touch => [touchKey(touch), touch])).values()]
}

// What an op will touch, as far as the model tells before it applies: its own touches and the shapes and notes
// its inverse will name (the children of a group, a deleted slide's notes, the placeholders a reset or a layout
// change rewrites).
function predictedTouches(deck: Deck, op: DeckOp): Touch[] {
	const out = [...opTouches(op)]

	if (op.family === "shape" && (op.kind === "ungroup" || op.kind === "group")) {
		const node = deck.nodes.get(op.slide)
		const ids =
			op.kind === "ungroup" ? (findShape(node?.shapes ?? [], op.group)?.shape.children ?? []).map(child => child.id) : op.shapes

		for (const id of ids) out.push({ kind: "shape", slide: op.slide, shape: id, dirt: { kind: "node" } })
	}

	// A content op on a shape backed by source is undone by replacing the shape (its node).
	if (op.family === "shape" && (op.kind === "setProps" || op.kind === "setStyle" || op.kind === "setAlt" || op.kind === "setAction")) {
		out.push({ kind: "shape", slide: op.target.slide, shape: op.target.id, dirt: { kind: "node" } })
	}

	if (op.family === "slide" && op.kind === "delete") {
		for (const ref of op.slides) {
			const notes = deck.nodes.get(ref)?.notes

			if (notes !== undefined) out.push({ kind: "slide", slide: notes, dirt: { kind: "node" } })
		}

		for (const { site } of jumpsTo(deck, new Set(op.slides))) {
			out.push({
				kind: "shape",
				slide: site.shape.slide,
				shape: site.shape.id,
				dirt: site.kind === "shape" || site.cell !== undefined ? { kind: "node" } : { kind: "text" }
			})
		}
	}

	if (op.family === "slide" && (op.kind === "reset" || op.kind === "setLayout")) {
		for (const shape of deck.nodes.get(op.slide)?.shapes ?? []) {
			if (shape.ph === undefined) continue

			const target = { kind: "shape", slide: op.slide, shape: shape.id } as const

			out.push({ ...target, dirt: { kind: "xfrm" } }, { ...target, dirt: { kind: "node" } })

			for (const group of ["geometry", "fill", "ln", "effects", "bodyPr"] as const)
				out.push({ ...target, dirt: { kind: "props", group } })
		}
	}

	return out
}

const ABSENT_BEFORE: Fingerprint = { digest: "", exists: false }

const SHAPE_DIRTS: readonly Dirt[] = [
	{ kind: "node" },
	{ kind: "xfrm" },
	{ kind: "text" },
	...(["geometry", "fill", "ln", "effects", "bodyPr", "style"] as const).map(group => ({ kind: "props", group }) as const)
]
const SLIDE_PART_DIRTS: readonly Dirt[] = (["background", "timing", "transition", "hf", "clrMapOvr", "attributes"] as const).map(
	part => ({ kind: "slidePart", part }) as const
)

// A whole node stands for every key under it (a shape's xfrm, groups and text; a slide's parts and every shape on
// it), so a step replacing or removing a node records what each of them was and became.
function expandTouches(deck: Deck, touches: readonly Touch[]): Touch[] {
	const out: Touch[] = [...touches]
	const shapeKeys = (slide: SlideRef, shapes: readonly ShapeNode[]): void => {
		for (const shape of shapes) {
			for (const dirt of SHAPE_DIRTS) out.push({ kind: "shape", slide, shape: shape.id, dirt })
			if (shape.children !== undefined) shapeKeys(slide, shape.children)
		}
	}

	for (const touch of touches) {
		if ((touch.kind !== "shape" && touch.kind !== "slide") || touch.dirt.kind !== "node") continue

		if (touch.kind === "shape") {
			for (const dirt of SHAPE_DIRTS) out.push({ kind: "shape", slide: touch.slide, shape: touch.shape, dirt })

			const children = findShape(deck.nodes.get(touch.slide)?.shapes ?? [], touch.shape)?.shape.children

			if (children !== undefined) shapeKeys(touch.slide, children)
		} else {
			for (const dirt of SLIDE_PART_DIRTS) out.push({ kind: "slide", slide: touch.slide, dirt })

			shapeKeys(touch.slide, deck.nodes.get(touch.slide)?.shapes ?? [])
		}
	}

	return unique(out)
}

// The sibling-order keys of every parent (the tree and each group) on the slides a whole node of `touches` is on.
function orderKeys(deck: Deck, touches: readonly Touch[]): TouchKey[] {
	const slides = new Set<SlideRef>()

	for (const touch of touches)
		if ((touch.kind === "shape" || touch.kind === "slide") && touch.dirt.kind === "node") slides.add(touch.slide)

	const out: TouchKey[] = []
	const groups = (slide: SlideRef, shapes: readonly ShapeNode[]): void => {
		for (const shape of shapes) {
			if (shape.kind !== "grpSp") continue

			out.push(orderKey(slide, shape.id))
			groups(slide, shape.children ?? [])
		}
	}

	for (const slide of slides) {
		const node = deck.nodes.get(slide)

		if (node === undefined) continue

		out.push(orderKey(slide, 0))
		groups(slide, node.shapes)
	}

	return out
}

// Whether a key lies under a node one of `touches` names.
function coveredBy(key: TouchKey, touches: readonly Touch[]): boolean {
	return touches.some(touch => {
		if (touch.kind === "shape" && touch.dirt.kind === "node") return key.startsWith(`s:${String(touch.slide)}:${String(touch.shape)}:`)
		if (touch.kind === "slide" && touch.dirt.kind === "node")
			return key.startsWith(`s:${String(touch.slide)}:`) || key.startsWith(`n:${String(touch.slide)}:`)

		return false
	})
}

// What an op made, once applied: the touches its applied form names that its request did not (an allocated shape
// id, a new slide ref) and a new slide's notes.
function madeTouches(deck: Deck, requested: DeckOp, applied: DeckOp): Touch[] {
	const asked = new Set(opTouches(requested).map(touchKey))
	const out = opTouches(applied).filter(touch => !asked.has(touchKey(touch)))

	if (applied.family === "slide" && (applied.kind === "add" || applied.kind === "duplicate") && applied.ref !== undefined) {
		const notes = deck.nodes.get(applied.ref)?.notes

		if (notes !== undefined) out.push({ kind: "slide", slide: notes, dirt: { kind: "node" } })
	}

	return out
}

function burstOf(op: DeckOp): string | undefined {
	if (op.family === "text" && op.kind === "setText" && op.burst !== undefined) {
		return `text:${String(op.target.slide)}:${String(op.target.id)}:${String(op.burst)}`
	}

	if (op.family === "table" && op.kind === "setCellText" && op.burst !== undefined) {
		return `cell:${String(op.target.slide)}:${String(op.target.id)}:${String(op.row)}:${String(op.col)}:${String(op.burst)}`
	}

	return undefined
}

function changed(session: EngineSession, state: EditState, touches: readonly Touch[]): void {
	const deck = session.deck
	const listChanged = touches.some(touch => touch.kind === "presentation" && touch.what === "slideList")

	session.emit({
		type: "changed",
		revision: state.history.revision,
		dirty: state.history.dirty,
		slides: [...slidesOf(touches)].filter(ref => deck.slides.includes(ref)),
		...(listChanged
			? {
					info: {
						slides: deck.slides.map(ref => ({
							ref,
							hidden: deck.nodes.get(ref)?.hidden ?? deck.hiddenSlides?.has(ref) ?? false
						})),
						sections: deck.sections
					}
				}
			: {})
	})
}

// A slide delete turned jumps to the deleted slides into "next slide": the page is told (its inverse holds them).
function reportJumps(session: EngineSession, op: DeckOp, inverse: Inverse): void {
	if (op.family !== "slide" || op.kind !== "delete") return

	const jumps = inverse.ops.flatMap(back =>
		back.family === "slide" && back.kind === "restore" ? back.slides.flatMap(entry => entry.jumps ?? []) : []
	)

	if (jumps.length === 0) return

	const shapes = new Map<string, ShapeRef>()

	for (const { site } of jumps) shapes.set(`${String(site.shape.slide)}:${String(site.shape.id)}`, site.shape)

	session.emit({ type: "notice", notice: { kind: "jumpsRewritten", count: jumps.length, shapes: [...shapes.values()] } })
}

// The open body laid out again when the step touched its shape; none while the text capability is not built.
async function seedFor(context: CallContext, open: ShapeRef | undefined, touches: readonly Touch[]): Promise<TextSeed | undefined> {
	if (open === undefined || !touches.some(touch => touch.kind === "shape" && touch.slide === open.slide && touch.shape === open.id))
		return undefined

	try {
		return await textCapability.textSeed(context, open)
	} catch (error) {
		if (error instanceof PresentationError && error.reason === "notImplemented") return undefined

		throw error
	}
}

// Runs in the deck's turn: commands, undo, redo and a save's snapshot never interleave.
function serial<T>(session: EngineSession, task: () => Promise<T>): Promise<T> {
	return deckTurn(session.deck, task)
}

function refusal(error: unknown): CommandResult {
	if (error instanceof PresentationError) return { ok: false, refusal: error.reason }

	throw error
}

// The history's accounting of a step: its op, its inverse's typed values and bytes, and the fingerprints it keeps.
function inverseWithBytes(inverse: Inverse): Inverse {
	let bytes = 0

	for (const op of inverse.ops) bytes += opBytesOf(op)

	return { ops: inverse.ops, bytes }
}

// Heap estimates (V8, measured on 60-step histories): a map entry with its fingerprint object, and a touch.
const FINGERPRINT_ENTRY = 400
const TOUCH_BYTES = 256

function fingerprintBytes(map: ReadonlyMap<TouchKey, Fingerprint>): number {
	let bytes = 0

	for (const [key, value] of map) bytes += FINGERPRINT_ENTRY + 2 * (key.length + value.digest.length) + 8 * (value.order?.length ?? 0)

	return bytes
}

async function command(context: CallContext, op: DeckOp, options: EditOptions): Promise<CommandResult> {
	const session = context.session
	const state = stateOf(session)

	return serial(session, async () => {
		if (session.deck.gate.length > 0) return { ok: false, refusal: "viewOnly" }

		return applyStep(session, state, op, context.slicing, options)
	})
}

// One op prepared, applied and pushed as a step (inside the deck's turn).
async function applyStep(
	session: EngineSession,
	state: EditState,
	op: DeckOp,
	slicing: CallContext["slicing"] | undefined,
	options: EditOptions
): Promise<CommandResult> {
	try {
		await prepare(session, state, op, slicing, options)
	} catch (error) {
		return refusal(error)
	}

	const deck = session.deck
	const predicted = expandTouches(deck, predictedTouches(deck, op))
	const before = fingerprintTouches(predicted, state.fingerprint)
	const ordersBefore = orderKeys(deck, predicted)

	for (const key of ordersBefore) before.set(key, state.fingerprint(key))

	const result = applyOp(deck, op, contextFor(session, state))

	if (result.kind === "refused") return { ok: false, refusal: result.reason }
	// Nothing to undo means nothing changed (aligning one shape to itself): no step.
	if (result.inverse.ops.length === 0) return { ok: true, revision: state.history.revision, dirty: state.history.dirty }

	const named = unique([
		...madeTouches(deck, op, result.op),
		...opTouches(result.op),
		...result.inverse.ops.flatMap(back => opTouches(back))
	])
	const touches = unique([...predicted, ...expandTouches(deck, named)])
	const full = new Map<TouchKey, Fingerprint>(before)
	// Keys first named once applied under a node the op names are what it made (absent before).
	const madeKeys = new Set(touches.map(touchKey).filter(key => !before.has(key) && coveredBy(key, named)))

	// What the op made (an allocated id or ref) was absent before; anything else it named only once applied is
	// unknown before, so it reads dirty until its step leaves the saved range.
	for (const touch of touches) {
		const key = touchKey(touch)

		if (!full.has(key)) full.set(key, madeKeys.has(key) ? ABSENT_BEFORE : UNKNOWN_FINGERPRINT)
	}

	// Sibling orders: every parent on the touched slides was read before; one first seen now is a new group.
	for (const key of orderKeys(deck, touches)) if (!full.has(key)) full.set(key, ABSENT_BEFORE)

	const after = new Map<TouchKey, Fingerprint>()

	for (const key of full.keys()) after.set(key, state.fingerprint(key))

	const inverse = inverseWithBytes(result.inverse)

	state.history.push({
		op: result.op,
		inverse,
		touches,
		before: full,
		after,
		bytes: inverse.bytes + opBytesOf(result.op) + fingerprintBytes(full) + fingerprintBytes(after) + touches.length * TOUCH_BYTES,
		burst: burstOf(result.op)
	})
	changed(session, state, touches)
	reportJumps(session, result.op, result.inverse)

	return { ok: true, revision: state.history.revision, dirty: state.history.dirty }
}

async function step(
	context: CallContext,
	direction: "undo" | "redo",
	open: ShapeRef | undefined,
	options: EditOptions
): Promise<CommandResult> {
	const session = context.session
	const state = stateOf(session)

	return serial(session, async () => {
		const history = state.history
		const entry = direction === "undo" ? history.peekUndo() : history.peekRedo()

		if (entry === undefined) return { ok: true, revision: history.revision, dirty: history.dirty }

		const ops = direction === "undo" ? entry.inverse.ops : [entry.op]

		try {
			for (const op of ops) await prepare(session, state, op, context.slicing, options)
		} catch (error) {
			return refusal(error)
		}

		const result = applyAll(session.deck, ops, contextFor(session, state))

		if (isRefused(result)) return { ok: false, refusal: result.reason }

		if (direction === "undo") {
			history.undone()
		} else {
			// A redo keeps the inverse it makes now (its bytes read from the base source as it is after any rebase).
			const fresh = result.inverses[0]

			if (fresh !== undefined) history.replaceInverse(entry, inverseWithBytes(fresh))

			history.redone()
		}

		changed(session, state, entry.touches)

		const seed = await seedFor(context, open, entry.touches)

		return { ok: true, revision: history.revision, dirty: history.dirty, ...(seed === undefined ? {} : { seed }) }
	})
}

// The parts a step changed (where each key it touched lives, before and after).
function stepParts(step: HistoryStep): Set<string> {
	const out = new Set<string>()

	for (const map of [step.before, step.after]) {
		for (const [key, value] of map) {
			if (value.part !== undefined) out.add(value.part)
			if (key.startsWith("p:")) out.add(key.slice(key.indexOf(":", 2) + 1))
		}
	}

	return out
}

// The steps whose net effect touches `parts` reverted (the writer refused them): steps are undone from the newest
// until none of those parts differs from the saved state, then the undone steps that touched none of them are
// applied again, oldest first (a new step each). The count of steps reverted. Runs inside the save's turn.
async function revert(session: EngineSession, state: EditState, parts: ReadonlySet<string>, options: EditOptions): Promise<number> {
	const history = state.history
	const touched = (): boolean => {
		for (const part of deckChanges(session.deck, history, state.fingerprint).parts.keys()) if (parts.has(part)) return true

		return false
	}
	const unrelated: DeckOp[] = []
	let count = 0

	while (touched()) {
		const entry = history.peekUndo()

		if (entry === undefined) break

		try {
			for (const op of entry.inverse.ops) await prepare(session, state, op, undefined, options)
		} catch {
			break
		}

		const result = applyAll(session.deck, entry.inverse.ops, contextFor(session, state))

		if (isRefused(result)) break

		history.undone()
		changed(session, state, entry.touches)

		const changedParts = stepParts(entry)

		if ([...changedParts].some(part => parts.has(part))) count++
		else unrelated.unshift(entry.op)
	}

	for (const op of unrelated) {
		const result = await applyStep(session, state, op, undefined, options)

		if (!result.ok) {
			count++

			continue
		}

		// A step that keeps a refused part changed after all goes again.
		if (touched()) {
			const entry = history.peekUndo()

			const back = entry === undefined ? undefined : applyAll(session.deck, entry.inverse.ops, contextFor(session, state))

			if (entry !== undefined && back !== undefined && !isRefused(back)) {
				history.undone()
				changed(session, state, entry.touches)
			}

			count++
		}
	}

	return count
}

// The edit capability, proving slides with `options.emit` (tests pass their own emitters).
export function createEditCapability(options: EditOptions = {}): EditCapability {
	return {
		command: (context, op) => command(context, op, options),
		undo: (context, open) => step(context, "undo", open, options),
		redo: (context, open) => step(context, "redo", open, options)
	}
}

export const editCapability: EditCapability = createEditCapability()

// What the save capability needs of a session's edits.
export interface SessionEdits {
	readonly history: DeckHistory
	// The changes against the saved state, now.
	changes(): DeckChanges
	// Runs `task` with commands queued until it ends (a save's snapshot).
	exclusive<T>(task: () => Promise<T>): Promise<T>
	// A document the session holds for re-read source markup ("raw:" names), and the part it was, for the writer.
	rawDocument(name: string): XmlDocument | undefined
	rawPart(name: string): RawPart | undefined
	// A restored slide's (its "raw:" name): every part its restore held, the slide first, for the writer to add back.
	rawParts(name: string): readonly RawPart[] | undefined
	// The proof tally of every slide proved so far.
	proofs(): ReadonlyMap<SlideRef, ProofTally>
}

export function sessionEdits(session: EngineSession): SessionEdits {
	const state = stateOf(session)

	return {
		history: state.history,
		changes: () => deckChanges(session.deck, state.history, state.fingerprint),
		exclusive: task => serial(session, task),
		rawDocument: name => state.raw.get(name)?.document,
		rawPart: name => state.raw.get(name)?.part,
		rawParts: name => state.raw.get(name)?.parts,
		proofs: () => state.proved
	}
}
