import { appendAll } from "../../arrays"
import {
	addRelationships,
	editContentTypes,
	joinBytes,
	parseRelationships,
	partKey,
	relationshipsPartName,
	relativeTarget,
	sliceClock,
	RELATIONSHIPS_NAMESPACE,
	crc32,
	BytePieces,
	type SliceClock,
	CONTENT_TYPES_PART,
	deflatesWell,
	type ByteSink,
	type ByteSource,
	type NewRelationship,
	type Relationship,
	type PartBytes,
	type PartChange,
	Relationships,
	type Slicing,
	type WriteZipOptions,
	type ZipPlan,
	OpcError,
	ZipError
} from "../../opc/index"
import { XmlError, decodeUtf8, encodeUtf8, escapeAttribute, type XmlDocument } from "../../xml/index"
import type { Node } from "prosemirror-model"
import type { DocxEditContext, NewStory } from "../edit/context"
import type { NewList } from "../edit/formats"
import type { DocxEditorSession } from "../edit/session"
import { writtenLinkTarget } from "../edit/commands/insert"
import type { StoryPart } from "../model/index"
import type { DocxPackage } from "../package"
import { DocxSaveError, DocxVerifyError } from "./failure"
import { planNested } from "./nested"
import {
	NEW_STORY_PARTS,
	WRITTEN_REFERENCES,
	COPIED_RELATIONSHIP,
	clonedRevisions,
	copiedPartName,
	ownedByCopy,
	isInsertionPoint,
	referenceKey,
	type NewStoryContainer
} from "./newStory"
import { NUMBERING_CONTENT_TYPE, planNumbering } from "./numbering"
import { orphanedRelationships } from "./orphans"
import { noteCopySource, noteCopyTarget, orphanedNotes, readNoteReferences, relationshipIdsOf, relationshipUses } from "./parts/notes"
import { Out } from "./markup"
import { PART_CONTRIBUTORS, type PartContributor, type RootDeclarations, type SaveParts } from "./parts/index"
import { DocxWriteError, StoryWriter, type StoryDraft, type StoryOutput, type WriteEnvironment } from "./story"
import { STYLES_CONTENT_TYPE, stylesWithDefinitions } from "./styles"
import { verifyDocxParts } from "./verify"
import { changedCrcs, planChanges, zipDocxSave, type DocxPartChanges } from "./zip"

const RELATIONSHIP_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const RELATIONSHIPS_CONTENT_TYPE = "application/vnd.openxmlformats-package.relationships+xml"

// Items of a document whose one-pass reads are short enough to run without slices.
const SMALL_ITEMS = 200_000

export interface DocxSaveInput {
	readonly pkg: DocxPackage
	readonly context: DocxEditContext
	// One session per story (the body, headers, notes...). Read-only sessions are not written.
	readonly sessions: readonly DocxEditorSession[]
	// What to write for a session instead of its current document (an IME composition's text marked tracked
	// while the composition goes on).
	readonly docs?: ReadonlyMap<DocxEditorSession, Node>
	// What writes the parts beyond story content (default: every feature's, see parts/index.ts).
	readonly parts?: readonly PartContributor[]
}

export interface DocxSaveTimings {
	readonly serializeMs: number
	readonly verifyPartsMs: number
	readonly zipMs: number
	readonly verifyZipMs: number
}

// A story whose container was rewritten. `output.bytes` holds the very pieces of the part's new content.
export interface StoryChange {
	readonly session: DocxEditorSession
	// The session's document as written (read once as the save started).
	readonly doc: Node
	readonly part: StoryPart
	readonly output: StoryOutput
	// A story the source does not have: the bytes of its part's source its container took the place of
	// (none, where it was inserted; a created part's root). Else the story's own container was replaced.
	readonly range?: { readonly from: number; readonly to: number }
}

// What a save writes: the parts the edits changed (story parts, numbering, styles, relationships, content
// types), each built from the original part's bytes, plus parts that did not exist.
export interface DocxChanges extends DocxPartChanges {
	readonly numIds: ReadonlyMap<number, number>
	readonly stories: readonly StoryChange[]
	// Source story containers taken out of their part (a deleted comment): their bytes.
	readonly removed: readonly { readonly part: StoryPart; readonly from: number; readonly to: number }[]
	// A story part's root start tag as written, where it declares namespaces the source's does not.
	readonly roots: ReadonlyMap<StoryPart, string>
}

export interface DocxPrepareOptions {
	// Write and check in slices (this thread stays responsive); a pause that rejects abandons the save with
	// that error. Without it the save runs in one go.
	readonly slicing?: Slicing
	// Compute each changed part's CRC-32 here, from the bytes the part checks read (PartChange.crc32), so the
	// zip half checks the archive against them wherever it runs (default true; a trial that zips nothing
	// can skip it).
	readonly checksums?: boolean
}

// Bytes checksummed between checks of the clock: a few ms on a phone.
const CRC_STEP = 1024 * 1024

// The CRC-32 of a part's new content, in steps.
async function checksum(bytes: PartBytes, clock: SliceClock | undefined): Promise<number> {
	if (bytes instanceof Uint8Array) {
		let crc = 0

		for (let from = 0; from < bytes.length; from += CRC_STEP) {
			crc = crc32(bytes.subarray(from, Math.min(bytes.length, from + CRC_STEP)), crc)

			if (clock?.due === true) await clock.pause()
		}

		return crc
	}

	if (!(bytes instanceof BytePieces)) {
		let crc = 0

		for await (const chunk of bytes.chunks()) crc = crc32(chunk, crc)

		return crc
	}

	let crc = 0

	for (let from = 0; from < bytes.length; from += CRC_STEP) {
		bytes.visit(from, Math.min(CRC_STEP, bytes.length - from), (piece, pieceFrom, count) => {
			crc = crc32(piece.subarray(pieceFrom, pieceFrom + count), crc)

			return true
		})

		if (clock?.due === true) await clock.pause()
	}

	return crc
}

// Relationships of one source part with new ones planned, ids allocated as addRelationships gives them.
class RelationshipPlan {
	private readonly taken = new Set<string>()
	private highest = 0
	readonly additions: NewRelationship[] = []
	readonly ids: string[] = []
	// Existing relationships the part no longer uses, to take out.
	readonly removals = new Set<string>()

	constructor(existing: readonly string[]) {
		for (const id of existing) {
			this.taken.add(id)

			const numbered = /^rId(\d+)$/.exec(id)

			if (numbered !== null) this.highest = Math.max(this.highest, Number(numbered[1]))
		}
	}

	add(relationship: NewRelationship): string {
		let id = `rId${++this.highest}`

		while (this.taken.has(id)) id = `rId${++this.highest}`

		this.taken.add(id)
		this.additions.push(relationship)
		this.ids.push(id)

		return id
	}
}

// A relationships part holding `relationships` (their ids) for part `source`: internal targets relative to it.
function relationshipsBytes(source: string, relationships: Relationships): Uint8Array {
	let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">`

	for (const relationship of relationships.all) {
		const target =
			relationship.external || relationship.partName === undefined
				? relationship.target
				: relativeTarget(source, relationship.partName)

		xml +=
			`<Relationship Id="${escapeAttribute(relationship.id)}" Type="${escapeAttribute(relationship.type)}" ` +
			`Target="${escapeAttribute(target)}"${relationship.external ? ' TargetMode="External"' : ""}/>`
	}

	return encodeUtf8(`${xml}</Relationships>`)
}

async function optionalXml(pkg: DocxPackage, name: string | undefined, slicing: Slicing | undefined): Promise<XmlDocument | undefined> {
	return name === undefined || !pkg.has(name) ? undefined : pkg.xml(name, slicing)
}

// `name`, or the first with a number before its extension, that neither the package nor `taken` (part keys)
// has.
function freeName(pkg: DocxPackage, taken: ReadonlySet<string>, name: string): string {
	const free = (candidate: string): boolean => !pkg.has(candidate) && !taken.has(partKey(candidate))

	if (free(name)) return name

	const dot = name.lastIndexOf(".")
	const extension = dot > name.lastIndexOf("/") ? dot : name.length

	for (let n = 1; ; n++) {
		const candidate = `${name.slice(0, extension)}${n}${name.slice(extension)}`

		if (free(candidate)) return candidate
	}
}

interface DraftedStory {
	readonly session: DocxEditorSession
	readonly doc: Node
	// The source bytes the story replaces: its container, or what a new story's container takes the place of.
	readonly from: number
	readonly to: number
	readonly added: boolean
	readonly draft: StoryDraft
}

// The part a story is written into: its own, or for a copied note the notes part it goes into.
function writtenPart(part: StoryPart): StoryPart {
	return noteCopyTarget(part) ?? part
}

// Package parts left with no relationship pointing at them once `dropped` (part keys, targets of relationships
// the save removes) lose theirs: each with its relationships part, and what only those pointed at. Word drops
// such parts on save. A part the save writes stays, unless it is one of `discardable` (story parts and parts the
// save adds: a header edited and then removed, a picture added to it): then its writes go too (`discarded`,
// part keys).
async function unreferencedParts(
	pkg: DocxPackage,
	dropped: ReadonlySet<string>,
	changes: readonly PartChange[],
	discardable: ReadonlySet<string>
): Promise<{ remove: string[]; discarded: Set<string> }> {
	const discarded = new Set<string>()

	if (dropped.size === 0) return { remove: [], discarded }

	const changed = new Map(changes.map(change => [partKey(change.name), change]))
	// Part key -> keys of the parts relating to it (the package: "").
	const sources = new Map<string, Set<string>>()
	const owned = new Map<string, Relationships>()
	const names = new Set(pkg.opc.zip.entries.map(entry => entry.name))

	for (const change of changes) names.add(change.name)

	for (const name of names) {
		const match = /^(.*?)_rels\/([^/]*)\.rels$/.exec(name)

		if (match === null) continue

		const source = `${match[1] ?? ""}${match[2] ?? ""}`
		const change = changed.get(partKey(name))
		const relationships =
			change === undefined ? await pkg.relationships(source) : parseRelationships(await joinBytes(change.bytes), source)

		owned.set(partKey(source), relationships)

		for (const relationship of relationships.all) {
			if (relationship.external || relationship.partName === undefined) continue

			const key = partKey(relationship.partName)
			const set = sources.get(key)

			if (set === undefined) sources.set(key, new Set([partKey(source)]))
			else set.add(partKey(source))
		}
	}

	const removed = new Set<string>()
	const out: string[] = []
	let queue = [...dropped]

	while (queue.length > 0) {
		const next: string[] = []

		for (const key of queue) {
			const entry = pkg.opc.entry(key)
			const change = changed.get(key)
			const keep = !discardable.has(key)

			if (removed.has(key) || key === partKey(CONTENT_TYPES_PART) || (change !== undefined && keep)) continue

			const name = entry?.name ?? change?.name

			if (name === undefined) continue
			if ([...(sources.get(key) ?? [])].some(source => !removed.has(source))) continue

			const rels = partKey(relationshipsPartName(name))

			if (changed.has(rels) && keep) continue

			removed.add(key)

			if (entry !== undefined) out.push(entry.name)
			if (change !== undefined) discarded.add(key)
			if (changed.has(rels)) discarded.add(rels)

			const relsEntry = pkg.opc.entry(rels)

			if (relsEntry !== undefined) out.push(relsEntry.name)

			for (const relationship of owned.get(key)?.all ?? [])
				if (!relationship.external && relationship.partName !== undefined) next.push(partKey(relationship.partName))
		}

		queue = next
	}

	return { remove: out, discarded }
}

// Pieces gathered between looks at the clock.
const GATHER_STEP = 16_384

// A source range a part is written without (a removed container), or its root start tag written anew.
interface Replaced {
	readonly from: number
	readonly to: number
	readonly bytes: Uint8Array
}

// A story part's new content: the source with each rewritten container replaced by its story as written,
// each removed container left out and the root start tag as declared (`open`), as pieces (views of the
// source and the new markup), never joined: a one-word edit in a long document costs the edit, not a copy of
// the part. Each story's output is a window of it.
async function assemble(
	part: StoryPart,
	drafted: readonly DraftedStory[],
	cuts: readonly { readonly from: number; readonly to: number }[],
	open: string | undefined,
	clock: SliceClock | undefined
): Promise<{ bytes: BytePieces; stories: StoryChange[] }> {
	const document = part.document
	const source = document.bytes
	const root = document.documentElement()
	const replaced: Replaced[] = cuts.map(cut => ({ ...cut, bytes: new Uint8Array() }))

	if (open !== undefined) replaced.push({ from: document.start(root), to: document.openEnd(root), bytes: encodeUtf8(open) })

	// A new container goes before a container replaced at the same place.
	const ordered = [...drafted, ...replaced].sort((a, b) => a.from - b.from || a.to - b.to)
	const pieces: Uint8Array[] = []
	const windows = new Map<DraftedStory, { readonly at: number; readonly size: number }>()
	const due = (): boolean => clock?.due === true
	let from = 0
	let at = 0

	for (const entry of ordered) {
		if (entry.from < from) throw new DocxWriteError("unsupported", `Rewritten stories of ${part.name} overlap`)

		pieces.push(source.subarray(from, entry.from))
		at += entry.from - from

		if ("draft" in entry) {
			const views = entry.draft.out.views()

			// One at a time: a story rewritten throughout has more pieces than a call takes arguments.
			for (let index = 0; index < views.length; index++) {
				pieces.push(views[index] as Uint8Array)

				if (clock !== undefined && index % GATHER_STEP === GATHER_STEP - 1 && due()) await clock.pause()
			}

			windows.set(entry, { at, size: entry.draft.out.size })
			at += entry.draft.out.size
		} else {
			pieces.push(entry.bytes)
			at += entry.bytes.length
		}

		from = entry.to
	}

	pieces.push(source.subarray(from))

	const bytes = clock === undefined ? BytePieces.of(pieces) : await BytePieces.build(pieces, due, clock.pause)
	const stories = ordered.flatMap((entry): StoryChange[] => {
		if (!("draft" in entry)) return []

		const { session, doc, draft, from: start, to: end, added } = entry
		const window = windows.get(entry) ?? { at: 0, size: 0 }
		const output = {
			bytes: bytes.window(window.at, window.size),
			trusted: draft.out.trusted,
			paragraphs: draft.paragraphs,
			containers: draft.containers
		}

		return [added ? { session, doc, part, output, range: { from: start, to: end } } : { session, doc, part, output }]
	})

	return { bytes, stories }
}

// Attributes of a story's doc node the writer itself writes; the others are features' (PartContributor).
const STORY_ATTRIBUTES: ReadonlySet<string> = new Set(["story", "sectPr", "end"])

export async function serializeDocx(input: DocxSaveInput, options: DocxPrepareOptions = {}): Promise<DocxChanges> {
	const { pkg, context } = input
	const contributors = input.parts ?? PART_CONTRIBUTORS
	const slicing = options.slicing
	const clock = slicing === undefined ? undefined : sliceClock(slicing)
	const writable = input.sessions.filter(session => !session.readOnly)
	// What the save writes is the documents as they are now, whatever happens between slices.
	const current = writable.map(session => input.docs?.get(session) ?? session.state.doc)
	const added = context.newStories
	const sessions = writable
	const docs = current
	const claimed = new Set(contributors.flatMap(contributor => contributor.attributes ?? []))

	for (const doc of docs) {
		for (const name of Object.keys(doc.attrs)) {
			if (!STORY_ATTRIBUTES.has(name) && (doc.attrs[name] ?? null) !== null && !claimed.has(name))
				throw new DocxWriteError("missingSource", `A document ${name} change`)
		}
	}

	const model = context.model
	// Above the ids copies of stories took (stories/clone.ts).
	let revision = Math.max(model.maxIds.revision, clonedRevisions(context))
	const relationships = new Map<string, RelationshipPlan>()
	// `seed`: the relationships a part the save creates starts with (a copy of another part keeps its ids).
	const relationshipsOf = async (part: string, seed?: Relationships): Promise<RelationshipPlan> => {
		const key = partKey(part)
		let plan = relationships.get(key)

		if (plan === undefined) {
			plan = new RelationshipPlan((seed ?? (await pkg.relationships(part))).all.map(relationship => relationship.id))
			relationships.set(key, plan)
		}

		return plan
	}
	const lists = new Map<number, NewList>()

	for (const session of sessions) for (const [id, list] of session.newLists) lists.set(id, list)

	const numberingPart = pkg.part("numbering")
	const numbering = planNumbering(await optionalXml(pkg, numberingPart, clock), context.numbering, lists)

	// Relationship plans exist for every story part up front, so hyperlinks get their ids in order.
	for (const session of sessions) {
		const part = session.story.part

		await relationshipsOf(part.name, pkg.has(part.name) ? undefined : part.relationships)
	}

	const replace: PartChange[] = []
	const add: PartChange[] = []
	const overrides: { partName: string; contentType: string }[] = []
	const defaults: { extension: string; contentType: string }[] = []
	// Parts added by contributors, typed once the package's content types are read.
	const typed: { name: string; contentType: string }[] = []
	// Part keys of the parts this save writes, and of those it adds.
	const written = new Set<string>()
	const taken = new Set<string>()
	// Story parts the stories of this save are written into.
	const storyParts = new Set<string>()
	const states = new Map<object, unknown>()
	const put = (list: PartChange[], change: PartChange): void => {
		const key = partKey(change.name)

		if (written.has(key)) throw new DocxWriteError("unsupported", `${change.name} is written twice`)

		written.add(key)
		list.push(change)
	}
	const own = (name: string): boolean => partKey(name) === partKey(CONTENT_TYPES_PART) || partKey(name).endsWith(".rels")
	// The relationships of a copy of a story part, those to parts it owns pointing at their copies.
	const copiedRelationships = new Map<string, Relationships>()
	// Parts the save creates for stories the editor added, by part key, and the main part's relationship
	// to each.
	const created = new Map<string, { readonly part: StoryPart; readonly story: NewStory; readonly relationship: string }>()
	// Checks where an added story goes; the first story of a part the save creates relates it to the main part.
	const place = async (session: DocxEditorSession, story: NewStory): Promise<void> => {
		const part = writtenPart(session.story.part)
		const key = partKey(story.target)

		if (partKey(part.name) !== key) throw new DocxWriteError("unsupported", `A new ${story.kind} story is not on ${story.target}`)

		if (pkg.has(story.target)) {
			// A copied note is a story of its own part, written into the notes part as a new one.
			if (!model.parts.includes(part) || (session.story.story.item >= 0 && part === session.story.part))
				throw new DocxWriteError("unsupported", `A new ${story.kind} story is not on ${story.target} as the package has it`)

			return
		}

		const other = created.get(key)

		if (other !== undefined) {
			if (other.part !== part) throw new DocxWriteError("unsupported", `New stories of ${story.target} are on parts of their own`)

			return
		}

		const relationship = (await relationshipsOf(pkg.mainPart)).add({
			type: NEW_STORY_PARTS[story.kind].relationship,
			target: relativeTarget(pkg.mainPart, story.target)
		})

		created.set(key, { part, story, relationship })
		taken.add(key)
	}

	// A copy of each part `relationships` point at that a copy of their part owns (Word copies a header's chart
	// or embedded object with it), with the relationships pointing at the copies. `copies`: the parts copied for
	// one copy of a story part, by the source's part key (each copy owns its own).
	const retargeted = async (relationships: Relationships, copies: Map<string, string> = new Map()): Promise<Relationships> => {
		const all: Relationship[] = []

		for (const relationship of relationships.all) {
			const source = relationship.partName

			if (source === undefined || !ownedByCopy(relationship, pkg)) {
				all.push(relationship)

				continue
			}

			const copy = await copyPart(source, copies)

			all.push({ ...relationship, partName: copy, target: copy })
		}

		return new Relationships(all)
	}
	const copyPart = async (source: string, copies: Map<string, string>): Promise<string> => {
		const known = copies.get(partKey(source))

		if (known !== undefined) return known

		const name = copiedPartName(source, candidate => !pkg.has(candidate) && !taken.has(partKey(candidate)))
		const contentType = (await pkg.opc.contentTypes()).typeOf(source)

		if (contentType === undefined) throw new DocxWriteError("unsupported", `${source} has no content type to copy`)

		copies.set(partKey(source), name)
		parts.add(name, await pkg.opc.read(source), contentType, { compress: pkg.opc.entry(source)?.method !== 0 })

		const relsName = relationshipsPartName(source)

		if (pkg.has(relsName)) {
			const relationships = await retargeted(await pkg.relationships(source), copies)
			const copyRels = relationshipsPartName(name)

			put(add, { name: copyRels, bytes: relationshipsBytes(name, relationships) })
			taken.add(partKey(copyRels))
			typed.push({ name: copyRels, contentType: RELATIONSHIPS_CONTENT_TYPE })
		}

		return name
	}

	// Parts of the original a copied note owns a copy of that this save gave the copy instead (nothing else uses
	// them any more), by part key.
	const reused = new Set<string>()
	// What relationships the source of a notes part uses, read once.
	const sourceUses = new Map<StoryPart, Map<string, number[]>>()
	// Whether a relationship of `into` of ids `ids` is still used by what the save writes of it outside the copy:
	// the stories drafted so far (every story of the source's own goes first), the source bytes no story replaces
	// and no note leaves.
	// Notes that lost every reference (read once), and what each drafted story uses (read once per draft).
	let orphans: ReadonlyMap<StoryPart, readonly number[]> | undefined
	const draftUses = new WeakMap<StoryDraft, Map<string, number[]>>()
	const usesOf = (part: StoryPart): Map<string, number[]> => {
		let uses = sourceUses.get(part)

		if (uses === undefined) {
			const document = part.document
			const root = document.documentElement()

			uses = relationshipUses(part, document.bytes.subarray(document.contentStart(root), document.contentEnd(root)))
			sourceUses.set(part, uses)
		}

		return uses
	}
	const stillUsed = (into: StoryPart, ids: ReadonlySet<string>): boolean => {
		const replaced: number[] = []

		orphans ??= orphanedNotes(context, sessions, docs)

		const gone = new Set(orphans.get(into) ?? [])

		for (const entry of drafted.get(into) ?? []) {
			replaced.push(entry.from, entry.to)

			// A note that lost every reference goes with what it uses.
			if (gone.has(entry.session.story.story.item)) continue

			let uses = draftUses.get(entry.draft)

			if (uses === undefined) {
				uses = relationshipUses(into, entry.draft.out.finish())
				draftUses.set(entry.draft, uses)
			}

			for (const id of uses.keys()) if (ids.has(id)) return true
		}

		const document = into.document
		const base = document.contentStart(document.documentElement())

		for (const item of gone) replaced.push(document.start(into.node(item)), document.end(into.node(item)))

		const uses = usesOf(into)

		for (const [id, spans] of uses) {
			if (!ids.has(id)) continue

			for (let k = 0; k < spans.length; k += 2) {
				const at = (spans[k] ?? 0) + base
				let kept = true

				for (let r = 0; r < replaced.length; r += 2) if (at >= (replaced[r] ?? 0) && at < (replaced[r + 1] ?? 0)) kept = false

				if (kept) return true
			}
		}

		return false
	}
	// The relationship of notes part `into` a copied note (copied from part `origin`) names in place of
	// `relationship` (a placeholder, write/newStory.ts COPIED_RELATIONSHIP): to a part the copy owns, one to a copy
	// of it, or to the part itself where nothing else uses it any more; to any other target, one to the same
	// target (the part's own where it has one).
	const copiedRelationship = async (
		relationship: Relationship,
		origin: StoryPart,
		into: StoryPart,
		copies: Map<string, string>
	): Promise<string> => {
		const source = relationship.partName
		const plan = await relationshipsOf(into.name)
		const same = (candidate: Relationship): boolean =>
			!candidate.id.startsWith(COPIED_RELATIONSHIP) &&
			candidate.type === relationship.type &&
			candidate.external === relationship.external &&
			(relationship.external || source === undefined ? candidate.target === relationship.target : candidate.partName === source)
		const existing = (): string | undefined => into.relationships.all.find(same)?.id
		const related = (): string =>
			existing() ??
			plan.add({
				type: relationship.type,
				target: relationship.external || source === undefined ? relationship.target : relativeTarget(into.name, source),
				...(relationship.external ? { external: true } : {})
			})

		if (source === undefined || relationship.external || !ownedByCopy(relationship, pkg)) return related()

		const originals = origin.relationships.all.filter(
			candidate => !candidate.external && candidate.partName === source && !candidate.id.startsWith(COPIED_RELATIONSHIP)
		)

		if (originals.length > 0 && !reused.has(partKey(source)) && !stillUsed(origin, new Set(originals.map(r => r.id)))) {
			reused.add(partKey(source))

			return related()
		}

		const copy = await copyPart(source, copies)

		return plan.add({ type: relationship.type, target: relativeTarget(into.name, copy) })
	}
	// The notes part a copied note was first copied from (a copy of a copy names its copy's part).
	const rootSource = (part: StoryPart): StoryPart | undefined => {
		let source = noteCopySource(part)

		for (let next = source === undefined ? undefined : noteCopySource(source); next !== undefined; next = noteCopySource(next))
			source = next

		return source
	}
	// Relationships of notes part `part` its source used and its writing (`written`, the part as assembled) no
	// longer does: a note that went, its picture or object moved with a note converted (hyperlinks apart:
	// orphanedRelationships).
	const unusedNoteRelationships = async (part: StoryPart, written: BytePieces): Promise<string[]> => {
		const local = part.document.localName(part.document.documentElement())

		if (local !== "footnotes" && local !== "endnotes") return []

		const before = usesOf(part)

		if (before.size === 0) return []

		const after = relationshipIdsOf(await joinBytes(written))
		const out: string[] = []

		for (const id of before.keys()) {
			const relationship = part.relationships.byId(id)

			if (relationship !== undefined && !relationship.type.endsWith("/hyperlink") && !after.has(id)) out.push(id)
		}

		return out
	}
	// A copied note's draft (write/parts/notes.ts noteCopyTarget) with the parts it owns: each relationship id it
	// names one by (COPIED_RELATIONSHIP, in the relationships namespace only) becomes that of a relationship of
	// the notes part `into` to a copy of the part, or to the part itself where nothing else uses it any more.
	const withCopiedParts = async (draft: StoryDraft, from: StoryPart, into: StoryPart): Promise<StoryDraft> => {
		const placeholders = new Map(from.relationships.all.filter(r => r.id.startsWith(COPIED_RELATIONSHIP)).map(r => [r.id, r]))

		if (placeholders.size === 0) return draft
		if (draft.out.trusted.length > 0) throw new DocxWriteError("unsupported", `A copied note of ${into.name} copies source nodes`)

		const bytes = draft.out.finish()
		const edits: { from: number; to: number; text: string }[] = []
		const copies = new Map<string, string>()
		const ids = new Map<string, string>()

		for (const [placeholder, spans] of relationshipUses(from, bytes)) {
			const relationship = placeholders.get(placeholder)

			if (relationship === undefined) continue

			let id = ids.get(placeholder)

			if (id === undefined) {
				id = await copiedRelationship(relationship, rootSource(from) ?? into, into, copies)
				ids.set(placeholder, id)
			}

			for (let k = 0; k < spans.length; k += 2) edits.push({ from: spans[k] ?? 0, to: spans[k + 1] ?? 0, text: id })
		}

		if (edits.length === 0) return draft

		edits.sort((a, b) => a.from - b.from)

		const out = new Out()
		const shifts: { at: number; by: number }[] = []
		let at = 0
		let shift = 0

		for (const edit of edits) {
			out.bytes(bytes, at, edit.from)
			out.text(edit.text)
			shift += edit.text.length - (edit.to - edit.from)
			shifts.push({ at: edit.to, by: shift })
			at = edit.to
		}

		out.bytes(bytes, at, bytes.length)

		const moved = (pos: number): number => {
			let by = 0

			for (const entry of shifts) if (entry.at <= pos) by = entry.by

			return pos + by
		}

		return {
			out,
			paragraphs: draft.paragraphs.map(paragraph => ({ ...paragraph, from: moved(paragraph.from), to: moved(paragraph.to) })),
			containers: draft.containers.map(container => ({ ...container, from: moved(container.from), to: moved(container.to) }))
		}
	}

	const parts: SaveParts = {
		pkg,
		context,
		clock,
		state<T>(key: object, create: () => T): T {
			if (!states.has(key)) states.set(key, create())

			return states.get(key) as T
		},
		relationship(part, relationship) {
			const plan = relationships.get(partKey(part))

			if (plan === undefined) throw new DocxWriteError("unsupported", `No relationships for ${part}`)

			return plan.add(relationship)
		},
		async loadRelationships(part) {
			await relationshipsOf(part)
		},
		storyRelationship(target) {
			const key = partKey(target)
			const made = created.get(key)

			if (made !== undefined) return made.relationship

			// A section of a story written before the header or footer it refers to: the part is placed now.
			const session = sessions.find(candidate => {
				const story = added.get(candidate.story.story)

				return story !== undefined && (story.kind === "header" || story.kind === "footer") && partKey(story.target) === key
			})
			const story = session === undefined ? undefined : added.get(session.story.story)
			const plan = relationships.get(partKey(pkg.mainPart))

			if (session === undefined || story === undefined || plan === undefined || pkg.has(story.target)) return undefined
			if (partKey(session.story.part.name) !== key) return undefined

			const relationship = plan.add({
				type: NEW_STORY_PARTS[story.kind].relationship,
				target: relativeTarget(pkg.mainPart, story.target)
			})

			created.set(key, { part: session.story.part, story, relationship })
			taken.add(key)

			return relationship
		},
		freeName: name => freeName(pkg, taken, name),
		changed: () => written.size > 0,
		xml: name => optionalXml(pkg, name, clock),
		replace(name, bytes) {
			if (own(name)) throw new DocxWriteError("unsupported", `${name} is the save's own to write`)
			if (!pkg.has(name)) throw new DocxWriteError("unsupported", `${name} is not in the package`)
			if (storyParts.has(partKey(name)))
				throw new DocxWriteError("unsupported", `${name} holds stories this save writes and cannot be replaced whole`)

			put(replace, { name: pkg.opc.entry(name)?.name ?? name, bytes })
		},
		add(name, bytes, contentType, options = {}) {
			if (own(name)) throw new DocxWriteError("unsupported", `${name} is the save's own to write`)
			if (pkg.has(name) || taken.has(partKey(name))) throw new DocxWriteError("unsupported", `${name} is already in the package`)

			put(add, { name, bytes, compress: options.compress ?? deflatesWell(contentType) })
			taken.add(partKey(name))
			typed.push({ name, contentType })
		},
		addDefault(extension, contentType) {
			defaults.push({ extension, contentType })
		}
	}
	// Revision ids are this save's own (nextRevisionId below), so a text box's fallback copy takes them from the
	// same count; the other ids are the editor's.
	const nested = planNested(
		sessions.map(session => session.story),
		{ next: space => (space === "revision" ? ++revision : context.ids.next(space)) }
	)
	const env: WriteEnvironment = {
		context,
		nextRevisionId: () => ++revision,
		numId(id) {
			const numId = numbering.numIds.get(id)

			if (numId === undefined) throw new DocxWriteError("missingSource", `Unknown new list ${id}`)

			return numId
		},
		hyperlink(part, target) {
			const plan = relationships.get(partKey(part))

			if (plan === undefined) throw new DocxWriteError("unsupported", `No relationships for ${part}`)

			// A Target is an xsd:anyURI (ECMA-376 Part 2 §9.3): a target link.set did not make (a copy of a file's
			// link that is not one) is written as link.set writes it.
			return plan.add({ type: `${RELATIONSHIP_BASE}/hyperlink`, target: writtenLinkTarget(target), external: true })
		},
		parts,
		...(nested === undefined ? {} : { nested: nested.nested })
	}
	// Where a story the source does not have goes: the contributor that knows it says; a header or footer
	// in a part the save creates is that part's root.
	const containerOf = (session: DocxEditorSession, doc: Node): NewStoryContainer => {
		const story = added.get(session.story.story)

		if (story === undefined) throw new DocxWriteError("unsupported", `A ${session.story.story.kind} story without a container`)

		const target = writtenPart(session.story.part)
		const document = target.document
		const root = document.documentElement()
		const fresh = !pkg.has(target.name)
		const wholeRoot = (at: number, to: number): boolean => fresh && at === document.start(root) && to === document.end(root)

		for (const contributor of contributors) {
			const container = contributor.container?.(session.story, doc)

			if (container === undefined) continue

			const to = container.to ?? container.at

			if (to === container.at ? !isInsertionPoint(document, container.at) : !wholeRoot(container.at, to))
				throw new DocxWriteError("unsupported", `A new story of ${target.name} goes inside another element`)

			return container
		}

		if (fresh && (story.kind === "header" || story.kind === "footer") && !document.isSelfClosing(root)) {
			const bytes = document.bytes

			return {
				open: decodeUtf8(bytes, document.start(root), document.openEnd(root)),
				close: decodeUtf8(bytes, document.contentEnd(root), document.end(root)),
				at: document.start(root),
				to: document.end(root)
			}
		}

		throw new DocxWriteError("missingSource", `A new ${story.kind} story`)
	}

	// Story containers per part, replaced in the part's own bytes; a story written exactly as its source is
	// left out (compared without joining it: its copies are views of the source).
	const drafted = new Map<StoryPart, DraftedStory[]>()
	// Root start tags with namespaces a part's stories now need, asked once per part before its stories are
	// written (with every session the save writes).
	const declared = new Map<StoryPart, RootDeclarations | undefined>()
	const declarationsOf = (part: StoryPart): RootDeclarations | undefined => {
		if (declared.has(part)) return declared.get(part)

		let found: RootDeclarations | undefined

		for (const contributor of contributors) {
			const answer = contributor.declarations?.(part, { sessions, docs, stories: [] })

			if (answer === undefined) continue
			if (found !== undefined && found.open !== answer.open)
				throw new DocxWriteError("unsupported", `Two features declare the root of ${part.name} differently`)

			found = answer
		}

		declared.set(part, found)

		return found
	}

	// Sessions written, and their documents.
	const kept: DocxEditorSession[] = []
	const keptDocs: Node[] = []
	const write = async (index: number): Promise<void> => {
		const session = sessions[index]

		if (session === undefined) return

		const story = session.story
		const made = added.get(story.story)

		if (made !== undefined) await place(session, made)

		const part = writtenPart(story.part)
		const document = part.document
		const doc = docs[index] ?? session.state.doc
		// A new story, or a copied note (a story of a part of its own) going into its notes part.
		const container = story.story.item < 0 || part !== story.part ? containerOf(session, doc) : undefined
		const prefixes = declarationsOf(part)?.prefixes
		const writer = new StoryWriter(env, story, {
			...(container === undefined ? {} : { container }),
			...(prefixes === undefined ? {} : { prefixes })
		})
		const written = clock === undefined ? writer.draftStorySync(doc) : await writer.draftStory(doc, clock)
		const draft = part === story.part ? written : await withCopiedParts(written, story.part, part)

		kept.push(session)
		keptDocs.push(doc)

		if (nested?.inner(index) === true) {
			nested.record(index, draft)

			return
		}

		const node = container === undefined ? part.node(story.story.item) : -1
		const from = container === undefined ? document.start(node) : container.at
		const to = container === undefined ? document.end(node) : (container.to ?? container.at)

		// A part the save creates is written however its stories came out.
		if (!created.has(partKey(part.name)) && draft.out.equals(document.bytes, from, to)) return

		const entry: DraftedStory = { session, doc, from, to, added: container !== undefined || made !== undefined, draft }
		const list = drafted.get(part)

		if (list === undefined) drafted.set(part, [entry])
		else list.push(entry)
	}
	const order = nested?.order ?? [...sessions.keys()]
	const isAdded = (index: number): boolean =>
		sessions[index] !== undefined && added.has((sessions[index] as DocxEditorSession).story.story)

	for (const index of order) if (!isAdded(index)) await write(index)

	// A story the editor added is written once what is written refers to it (a reference the writer wrote,
	// or one a contributor knows of), and what it refers to after it; the rest is left out of the save: no
	// part, relationship or content type.
	const references = parts.state(WRITTEN_REFERENCES, () => new Set<string>())
	let waiting = order.filter(isAdded)

	while (waiting.length > 0) {
		const due = waiting.filter(index => {
			const story = added.get((sessions[index] as DocxEditorSession).story.story) as NewStory

			return (
				(story.id !== undefined && references.has(referenceKey(story.kind, story.id))) ||
				contributors.some(contributor => contributor.references?.(story, keptDocs) === true)
			)
		})

		if (due.length === 0) break

		waiting = waiting.filter(index => !due.includes(index))

		for (const index of due) await write(index)
	}

	// Source containers taken out of their part: a story of theirs is not written.
	const cuts = new Map<StoryPart, { from: number; to: number }[]>()
	const removed: { part: StoryPart; from: number; to: number }[] = []

	// What the stories hold of note references, read in slices before notes that lost every reference go (a
	// small document reads them at once, where they are needed: slicing would only add to it).
	if (clock !== undefined && context.model.parts.reduce((sum, part) => sum + (part?.count ?? 0), 0) > SMALL_ITEMS)
		await readNoteReferences(context, kept, keptDocs, clock)

	for (const contributor of contributors) {
		for (const [part, items] of contributor.removed?.(parts, { sessions: kept, docs: keptDocs }) ?? []) {
			const document = part.document
			const root = document.documentElement()

			for (const item of items) {
				const node = part.node(item)

				if (document.parent(node) !== root)
					throw new DocxWriteError("unsupported", `A removed story of ${part.name} is not a child of its root`)

				const cut = { from: document.start(node), to: document.end(node) }
				const list = cuts.get(part)
				const stories = drafted.get(part)

				if (list?.some(other => other.from === cut.from) === true) continue
				if (list === undefined) cuts.set(part, [cut])
				else list.push(cut)

				removed.push({ part, ...cut })

				if (stories !== undefined) {
					drafted.set(
						part,
						stories.filter(entry => entry.session.story.story.item !== item)
					)
				}
			}
		}
	}

	const stories: StoryChange[] = []
	const roots = new Map<StoryPart, string>()

	for (const part of new Set([...drafted.keys(), ...cuts.keys()])) {
		const list = drafted.get(part) ?? []
		const open = list.length === 0 ? undefined : declared.get(part)?.open
		const result = await assemble(part, list, cuts.get(part) ?? [], open, clock)
		const made = created.get(partKey(part.name))

		if (open !== undefined) roots.set(part, open)

		storyParts.add(partKey(part.name))

		if (made === undefined) {
			put(replace, { name: part.name, bytes: result.bytes })

			const plan = await relationshipsOf(part.name)

			for (const id of await orphanedRelationships(pkg, part, result.bytes, clock)) plan.removals.add(id)
			for (const id of await unusedNoteRelationships(part, result.bytes)) plan.removals.add(id)
		} else {
			put(add, { name: part.name, bytes: result.bytes })
			overrides.push({ partName: part.name, contentType: NEW_STORY_PARTS[made.story.kind].contentType })

			if (part.relationships.all.some(relationship => ownedByCopy(relationship, pkg)))
				copiedRelationships.set(partKey(part.name), await retargeted(part.relationships))
		}

		appendAll(stories, result.stories)

		if (clock?.due === true) await clock.pause()
	}

	const numberingBytes = numbering.bytes()

	if (numberingBytes !== null) {
		if (numberingPart !== undefined) {
			put(replace, { name: numberingPart, bytes: numberingBytes })
		} else {
			const name = freeName(pkg, taken, "word/numbering.xml")

			taken.add(partKey(name))
			put(add, { name, bytes: numberingBytes })
			overrides.push({ partName: name, contentType: NUMBERING_CONTENT_TYPE })
			;(await relationshipsOf(pkg.mainPart)).add({
				type: `${RELATIONSHIP_BASE}/numbering`,
				target: relativeTarget(pkg.mainPart, name)
			})
		}
	}

	// Styles the written stories use (an added story the save leaves out asks for none).
	const missingStyles = new Map<string, string>()

	for (const session of kept) for (const [id, name] of session.missingStyles) missingStyles.set(id, name)

	const stylesPart = pkg.part("styles")
	const stylesBytes = stylesWithDefinitions(
		await optionalXml(pkg, stylesPart, clock),
		context.styles,
		missingStyles,
		context.newStyleWidths
	)

	if (stylesBytes !== null) {
		if (stylesPart !== undefined) {
			put(replace, { name: stylesPart, bytes: stylesBytes })
		} else {
			const name = freeName(pkg, taken, "word/styles.xml")

			taken.add(partKey(name))
			put(add, { name, bytes: stylesBytes })
			overrides.push({ partName: name, contentType: STYLES_CONTENT_TYPE })
			;(await relationshipsOf(pkg.mainPart)).add({ type: `${RELATIONSHIP_BASE}/styles`, target: relativeTarget(pkg.mainPart, name) })
		}
	}

	for (const contributor of contributors) {
		if (contributor.contribute === undefined) continue

		await contributor.contribute(parts, { sessions: kept, docs: keptDocs, stories })

		if (clock?.due === true) await clock.pause()
	}

	const types = await pkg.opc.contentTypes()

	if (clock?.due === true) await clock.pause()

	// A Default never retypes what the package types otherwise.
	const newDefaults = new Map<string, string>()

	for (const { extension, contentType } of defaults) {
		const key = partKey(extension)
		const existing = newDefaults.get(key) ?? types.defaults.get(key)

		if (existing !== undefined && existing !== contentType)
			throw new DocxWriteError("unsupported", `Files .${extension} are typed ${existing}, not ${contentType}`)

		newDefaults.set(key, contentType)
	}

	for (const { name, contentType } of typed) {
		const dot = name.lastIndexOf(".")
		const extension = dot > name.lastIndexOf("/") ? partKey(name.slice(dot + 1)) : undefined
		const type = (extension === undefined ? undefined : newDefaults.get(extension)) ?? types.typeOf(name)

		if (type !== contentType) overrides.push({ partName: name, contentType })
	}

	// Parts relationships the save removes pointed at.
	const dropped = new Set<string>()

	for (const [key, plan] of relationships) {
		// A part the save creates as a copy of another has that part's relationships (stories/clone.ts).
		const made = created.get(key)
		const kept =
			made !== undefined && made.part.relationships.all.length > 0
				? (copiedRelationships.get(key) ?? made.part.relationships)
				: undefined

		if (plan.additions.length === 0 && plan.removals.size === 0 && kept === undefined) continue

		const source = pkg.opc.entry(key)?.name ?? key
		const relsName = relationshipsPartName(source)
		const inPackage = pkg.has(relsName)
		const existing = inPackage ? await pkg.opc.read(relsName) : kept === undefined ? null : relationshipsBytes(source, kept)
		const result = addRelationships(existing, plan.additions, plan.removals)

		if (inPackage && plan.removals.size > 0) {
			const before = await pkg.relationships(source)

			for (const id of plan.removals) {
				const target = before.byId(id)

				if (target !== undefined && !target.external && target.partName !== undefined) dropped.add(partKey(target.partName))
			}
		}

		if (result.ids.join() !== plan.ids.join())
			throw new DocxWriteError("unsupported", `Relationship ids of ${source} did not come out as planned`)

		if (!inPackage) {
			put(add, { name: relsName, bytes: result.bytes })

			// A package with no relationships part typed by extension (malformed but readable) types the new one.
			if (types.typeOf(relsName) === undefined) overrides.push({ partName: relsName, contentType: RELATIONSHIPS_CONTENT_TYPE })
		} else {
			put(replace, { name: pkg.opc.entry(relsName)?.name ?? relsName, bytes: result.bytes })
		}
	}

	// What only those relationships pointed at goes with them, as Word saves it.
	const discardable = new Set([...storyParts, ...add.map(change => partKey(change.name))])
	const { remove, discarded } = await unreferencedParts(pkg, dropped, [...replace, ...add], discardable)
	const removeOverrides = remove.filter(name => types.overrides.has(partKey(name)))
	const stays = (name: string): boolean => !discarded.has(partKey(name))
	const keptOverrides = discarded.size === 0 ? overrides : overrides.filter(override => stays(override.partName))
	const keptReplace = discarded.size === 0 ? replace : replace.filter(change => stays(change.name))
	const keptAdd = discarded.size === 0 ? add : add.filter(change => stays(change.name))

	if (keptOverrides.length > 0 || defaults.length > 0 || removeOverrides.length > 0) {
		keptReplace.push({
			name: CONTENT_TYPES_PART,
			bytes: editContentTypes(await pkg.opc.read(CONTENT_TYPES_PART), { overrides: keptOverrides, defaults, removeOverrides })
		})
	}

	return {
		replace: keptReplace,
		add: keptAdd,
		remove,
		numIds: numbering.numIds,
		stories: discarded.size === 0 ? stories : stories.filter(story => stays(story.part.name)),
		removed: discarded.size === 0 ? removed : removed.filter(cut => stays(cut.part.name)),
		roots: discarded.size === 0 ? roots : new Map([...roots].filter(([part]) => stays(part.name)))
	}
}

// The parts a save writes, checked by the part-level half of gate 2, with the time each step took (ms, slices
// and the turns between them included).
export interface DocxPreparedSave extends DocxPartChanges {
	readonly changedParts: readonly string[]
	readonly serializeMs: number
	readonly verifyPartsMs: number
}

// Gate 0 (the document may be edited at all), the lossless writer, then the part-level half of gate 2: what
// needs the editor and the model. The zip half (zipDocxSave) needs only the original archive and these parts.
export async function prepareDocxSave(input: DocxSaveInput, options: DocxPrepareOptions = {}): Promise<DocxPreparedSave> {
	const { pkg, context } = input

	if (context.gate.length > 0) throw new DocxSaveError("readOnly", `The document is view-only (${context.gate.join(", ")})`)

	// One clock for every step, so each continues the slice the one before started.
	const clock = options.slicing === undefined ? undefined : sliceClock(options.slicing)
	const sliced = clock === undefined ? {} : { slicing: clock }
	let started = Date.now()
	let changes: DocxChanges

	try {
		changes = await serializeDocx(input, sliced)
	} catch (error) {
		if (error instanceof DocxWriteError || error instanceof XmlError || error instanceof OpcError || error instanceof ZipError)
			throw new DocxSaveError("write", error.message)

		throw error
	}

	const serializeMs = Date.now() - started

	started = Date.now()

	try {
		await verifyDocxParts({ original: pkg, context, changes }, clock)
	} catch (error) {
		if (error instanceof DocxVerifyError) throw new DocxSaveError(error.reason, error.message)

		throw error
	}

	const withCrc = async (change: PartChange): Promise<PartChange> =>
		options.checksums === false ? change : { ...change, crc32: await checksum(change.bytes, clock) }
	const replace: PartChange[] = []
	const add: PartChange[] = []

	for (const change of changes.replace) replace.push(await withCrc(change))
	for (const change of changes.add) add.push(await withCrc(change))

	return {
		replace,
		add,
		...(changes.remove === undefined || changes.remove.length === 0 ? {} : { remove: changes.remove }),
		changedParts: [...changes.replace, ...changes.add].map(change => change.name),
		serializeMs,
		verifyPartsMs: Date.now() - started
	}
}

// A save ready to be written: the zip plan (untouched entries copied raw), the parts it rewrites with the
// CRC each must have in the archive, and the timings so far. Gate 2 has checked the parts.
export interface DocxSavePlan {
	readonly plan: ZipPlan
	readonly changedParts: readonly string[]
	// partKey -> CRC-32 of the part's new bytes.
	readonly crcs: ReadonlyMap<string, number>
	readonly serializeMs: number
	readonly verifyPartsMs: number
}

// prepareDocxSave as a zip plan. Mobile can execute the plan outside the WebView (writeZip next to the file)
// and check the result there with verifyDocxZip.
export async function planDocxSave(input: DocxSaveInput, options: DocxPrepareOptions = {}): Promise<DocxSavePlan> {
	const prepared = await prepareDocxSave(input, options)

	return {
		plan: await planChanges(input.pkg.opc, prepared),
		changedParts: prepared.changedParts,
		crcs: await changedCrcs(prepared),
		serializeMs: prepared.serializeMs,
		verifyPartsMs: prepared.verifyPartsMs
	}
}

export interface DocxSaveOptions extends DocxPrepareOptions {
	readonly zip?: WriteZipOptions
	// Where the file goes (default: memory, returned as `bytes`).
	readonly sink?: ByteSink
	// Random access to what `sink` received, for the zip half of gate 2; required with a sink.
	readonly readBack?: () => Promise<ByteSource>
}

export interface DocxSaveResult {
	// The file, when no sink was given.
	readonly bytes: Uint8Array | undefined
	// Parts rewritten or added; every other entry was copied as it was, compressed bytes included.
	readonly changedParts: readonly string[]
	readonly timings: DocxSaveTimings
}

// Writes the edited document on this thread: prepareDocxSave, then the zip with every untouched entry copied
// raw and the zip half of gate 2 on the result (zipDocxSave). Any failure refuses the save with a reason; the
// editor stays dirty.
export async function saveDocx(input: DocxSaveInput, options: DocxSaveOptions = {}): Promise<DocxSaveResult> {
	const prepared = await prepareDocxSave(input, options)
	const zipped = await zipDocxSave(input.pkg.opc, prepared, {
		...(options.zip === undefined ? {} : { zip: options.zip }),
		...(options.sink === undefined ? {} : { sink: options.sink }),
		...(options.readBack === undefined ? {} : { readBack: options.readBack })
	})

	return {
		bytes: zipped.bytes,
		changedParts: zipped.changedParts,
		timings: {
			serializeMs: prepared.serializeMs,
			verifyPartsMs: prepared.verifyPartsMs,
			zipMs: zipped.zipMs,
			verifyZipMs: zipped.verifyZipMs
		}
	}
}
