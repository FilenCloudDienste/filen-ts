import { OpcPackage, bytesSource } from "../../opc/index"
import { NodeKind, parseXml, parseXmlSliced, type XmlDocument } from "../../xml/index"
import type { Checkpoint } from "../checkpoint"
import type { RtfContainer, SourceRange } from "../document"
import { readRtf, readSpan, type RtfPreserved, type RtfReadResult } from "../reader"
import type { Block, SourceBlock, SourceParagraph, SourceRow, SourceTable } from "../story"
import { RtfTokenizer, Token } from "../tokenizer"
import { RtfAborted, jobOf, turn, type RtfJob as Job, type RtfTurns } from "../turns"
import {
	BODY_PART,
	SPAN_REACH,
	bodyWindows,
	containerElement,
	hasSection,
	indexBody,
	startingPoint,
	type BodyIndex,
	type BodyWindows
} from "./bodyWindows"
import { commonHead, commonTail, endsBookmark, equalBytes, includes, namesRelationship } from "./bytes"
import { blockDigest, blockDigests, blockDigestsExcept, canonical, digestedBlocks, type DigestContext } from "./digest"
import { encodeText } from "./encode"
import { carriedWords, openGroups, openGroupsSteps, replaceable } from "./groups"
import {
	charWords,
	paraWords,
	sectionWords,
	toDttm,
	writeParagraph,
	writeRow,
	type NoteKind,
	type RowWriter,
	type SourceTableWords
} from "./emit"
import { RtfOut, RtfWriteRefusal, joinChunks, latin1Bytes } from "./out"
import { Plan, key } from "./plan"
import { writeNewPicture } from "./picture"
import { childNamed, idOfName, sameNames, styleChain, styleDefinition, styleElement, styleNames } from "./styles"
import { descendant } from "./wml"

// The lossless RTF writer. The document was edited as the WordprocessingML package the reader translated it to;
// the docx writer wrote the edited parts (unchanged blocks byte for byte). Blocks whose WordprocessingML is
// unchanged keep their source bytes; changed and new ones are written from their WordprocessingML (emit.ts),
// each spelled out in full; table entries they need are added to the source's tables, never renumbering one.
// The result is read again and every block compared with what the edit made (digest.ts): a block copied as it
// was that reads differently (state from a written block before it leaking into it) is written out in turn,
// until the file reads as the edit; a written block that reads differently refuses the save.

// The source document as it opened: its bytes, what the reader made of them and the translation.
export interface RtfSource {
	readonly bytes: Uint8Array
	readonly read: RtfReadResult
	readonly translation: OpcPackage
	// The translation's body element by element, found the first time it is parsed (see bodyWindows).
	body?: BodyIndex | undefined
}

export async function openRtfSource(bytes: Uint8Array, turns?: RtfTurns): Promise<RtfSource | undefined> {
	const job = jobOf(turns)
	const read = await readRtf(bytes, job === undefined ? {} : { turns: job })

	await turn(job)

	if (!read.ok) return undefined

	return { bytes, read, translation: await OpcPackage.open(bytesSource(read.docx)) }
}

// The parts the docx writer wrote: replaced and added parts by name, and those it removed.
export interface RtfEdits {
	readonly parts: ReadonlyMap<string, Uint8Array>
	readonly removed?: readonly string[]
}

export interface RtfWritten {
	readonly bytes: Uint8Array
	// Blocks written from their WordprocessingML, and how many reads the proof took.
	readonly written: number
	readonly rounds: number
	// Written and proved where the edit changed the body ("span"), or as the whole document.
	readonly path: "span" | "whole"
}

const BOOKMARK = Array.from("<w:bookmark", character => character.charCodeAt(0))
const COMMENT_MARK = Array.from("<w:comment", character => character.charCodeAt(0))
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const STORY_PART = /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/u
const MEDIA_PART = /^word\/media\/[^/]+$/u
const RELS_PART = /^word\/_rels\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml\.rels$/u
// Parts an edit may change that the RTF does not hold (the translation's own metadata).
const COMMENTS_PART = "word/comments.xml"
// What the docx writer adds with a new comment: each comment's last paragraph, the one it replies to, whether it is
// resolved (MS-DOCX 2.5.3.1). An RTF annotation (RTF 1.9.1, "Comments (Annotations)") holds none of it: a reply or a
// resolved comment is refused (commentStates).
const COMMENTS_EXTENDED_PART = "word/commentsExtended.xml"
const IGNORED_PARTS = new Set(["[Content_Types].xml", "docProps/core.xml", "docProps/app.xml", "word/fontTable.xml"])
const MAX_ROUNDS = 8
// Blocks Gate 1 plans between looks at its slice clock.
const PLAN_RUN = 256
const GROUP_MISSES = 16

function blocksOf(document: XmlDocument, container: number): { blocks: number[]; section: number } {
	const blocks: number[] = []
	let section = -1

	for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "p" || local === "tbl") blocks.push(child)
		else if (local === "sectPr") section = child
		else if (local !== "bookmarkStart" && local !== "bookmarkEnd" && local !== "proofErr")
			throw new RtfWriteRefusal("content", `${local} between blocks`)
	}

	return { blocks, section }
}

function sameBytes(a: XmlDocument, aNode: number, b: XmlDocument, bNode: number): boolean {
	const x = a.raw(aNode)
	const y = b.raw(bNode)

	if (x.length !== y.length) return false

	for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false

	return true
}

// `count` blocks of `a` from `aFrom` and of `b` from `bFrom`, byte for byte (and what lies between them).
function sameSpan(
	a: XmlDocument,
	aBlocks: readonly number[],
	aFrom: number,
	b: XmlDocument,
	bBlocks: readonly number[],
	bFrom: number,
	count: number
): boolean {
	if (count === 0) return true

	const aFirst = aBlocks[aFrom] ?? -1
	const aLast = aBlocks[aFrom + count - 1] ?? -1
	const bFirst = bBlocks[bFrom] ?? -1
	const bLast = bBlocks[bFrom + count - 1] ?? -1

	if (aFirst < 0 || aLast < 0 || bFirst < 0 || bLast < 0) return false

	const aRoot = a.documentElement()
	const bRoot = b.documentElement()
	const x = a.raw(aRoot).subarray(a.start(aFirst) - a.start(aRoot), a.end(aLast) - a.start(aRoot))
	const y = b.raw(bRoot).subarray(b.start(bFirst) - b.start(bRoot), b.end(bLast) - b.start(bRoot))

	return equalBytes(x, y)
}

// A span's paragraphs as a document of their own (undefined for anything else).
function spanDocument(blocks: readonly Block[]): XmlDocument | undefined {
	const head = latin1Bytes(`<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>`)
	const foot = latin1Bytes("</w:body></w:document>")
	let size = head.length + foot.length

	for (const block of blocks) {
		if (block.kind !== "p" || block.marked) return undefined

		size += block.size
	}

	const out = new Uint8Array(size)
	let at = 0

	out.set(head, at)
	at += head.length

	for (const block of blocks) {
		if (block.kind !== "p") return undefined

		for (const view of block.store.read(block.at, block.size)) {
			out.set(view, at)
			at += view.length
		}
	}

	out.set(foot, at)

	return parseXml(out)
}

// {\\*\\name text}: a destination holding text (\\uc1 where the text needs \\uN).
function destination(out: RtfOut, name: string, text: string, codepage: number): void {
	const encoded = encodeText(text, codepage)

	out.rtf("{\\*").word(name)
	if (encoded.unicode) out.word("uc", 1)
	out.bytes(latin1Bytes(encoded.rtf)).rtf("}")
}

// commentsExtended as the edit wrote it: refused where an entry threads a reply or resolves its comment.
function commentStates(document: XmlDocument): void {
	const root = document.documentElement()

	for (let entry = document.firstChildElement(root); entry >= 0; entry = document.nextSiblingElement(entry)) {
		for (const { name, value } of document.attributes(entry)) {
			const local = name.slice(name.indexOf(":") + 1)

			if (local === "paraIdParent")
				throw new RtfWriteRefusal("comment", "a reply to a comment (an RTF annotation has no thread to answer in)")
			if (local === "done" && value !== "0" && value !== "false")
				throw new RtfWriteRefusal("comment", "a resolved comment (an RTF annotation has no resolved state)")
		}
	}
}

// The text of the {\\*\\atnref ...} in a source annotation group: what its range's \\atrfstart and \\atrfend hold.
function annotationTag(bytes: Uint8Array, group: SourceRange): string {
	const word = latin1Bytes("\\atnref")

	for (let at = bytes.indexOf(0x5c, group.start); at >= 0 && at < group.end; at = bytes.indexOf(0x5c, at + 1)) {
		let k = 0

		while (k < word.length && bytes[at + k] === word[k]) k++

		if (k < word.length) continue

		let from = at + k
		const next = bytes[from] ?? 0

		if ((next | 0x20) >= 0x61 && (next | 0x20) <= 0x7a) continue
		if (next === 0x20) from++

		let text = ""

		for (let end = from; end < group.end && bytes[end] !== 0x7d; end++) {
			const byte = bytes[end] ?? 0

			if (byte === 0x5c || byte === 0x7b) return ""
			if (byte !== 0x0d && byte !== 0x0a) text += String.fromCharCode(byte)
		}

		return text.trim()
	}

	return ""
}

// What ends a source paragraph: the name of the word in [term, end) ("" at the end of a story).
function termOf(bytes: Uint8Array, paragraph: SourceParagraph): string {
	if (paragraph.term < 0 || paragraph.term >= paragraph.end) return ""

	const tokens = new RtfTokenizer(bytes.subarray(0, paragraph.end), paragraph.term)
	const kind = tokens.next()

	if (kind === Token.Word) return tokens.name
	if (kind === Token.Symbol && tokens.symbol === 0x0a) return "par"

	return "?"
}

type ParagraphTerm = string | Uint8Array | ((out: RtfOut) => void)

interface Skeleton {
	readonly closes: number
	readonly opens: number
}

// A diff of two lists by an equality: the pairs kept, in order (the longest common subsequence where it is
// small enough to find, else what the common head and tail give).
function commonPairs(n: number, m: number, same: (i: number, j: number) => boolean): [number, number][] {
	let head = 0

	while (head < n && head < m && same(head, head)) head++

	let tail = 0

	while (tail < n - head && tail < m - head && same(n - 1 - tail, m - 1 - tail)) tail++

	const pairs: [number, number][] = []

	for (let k = 0; k < head; k++) pairs.push([k, k])

	const a = n - head - tail
	const b = m - head - tail

	if (a > 0 && b > 0 && a * b <= 4_000_000) {
		const table = new Uint32Array((a + 1) * (b + 1))
		const at = (i: number, j: number): number => i * (b + 1) + j

		for (let i = a - 1; i >= 0; i--)
			for (let j = b - 1; j >= 0; j--)
				table[at(i, j)] = same(head + i, head + j)
					? (table[at(i + 1, j + 1)] ?? 0) + 1
					: Math.max(table[at(i + 1, j)] ?? 0, table[at(i, j + 1)] ?? 0)

		let i = 0
		let j = 0

		while (i < a && j < b) {
			if (same(head + i, head + j)) {
				pairs.push([head + i, head + j])
				i++
				j++
			} else if ((table[at(i + 1, j)] ?? 0) >= (table[at(i, j + 1)] ?? 0)) i++
			else j++
		}
	}

	for (let k = tail; k > 0; k--) pairs.push([n - k, m - k])

	return pairs
}

// What a block of the edited container is written as.
type Op = { readonly kind: "keep"; readonly source: SourceBlock } | { readonly kind: "write"; readonly source: SourceBlock | undefined }

interface ContainerState {
	readonly container: RtfContainer
	readonly original: XmlDocument
	readonly edited: XmlDocument
	readonly originalBlocks: number[]
	readonly editedBlocks: number[]
	// The body's last section properties as edited, where they changed (-1 when they did not).
	readonly lastSection: number
	readonly editedSection: number
	// Per edited block: kept or written (filled by each run).
	ops: Op[]
}

// The proof's verdict per container: the blocks (indices into the container's blocks) that did not read back.
export interface RtfProofResult {
	readonly locked: readonly { readonly part: string; readonly offset: number; readonly reason: string }[]
	readonly written: number
}

class RtfWriter {
	private readonly states = new Map<string, ContainerState>()
	private readonly forced = new Map<string, Set<number>>()
	private readonly failed = new Map<string, Map<number, string>>()
	private readonly preserved: readonly RtfPreserved[]
	private notes = new Map<string, RtfContainer>()
	// The source's comments by key(part, id), the ids of those the edit added, and each comment's range text.
	private readonly comments = new Map<string, RtfContainer>()
	private readonly newComments = new Set<string>()
	private readonly tags = new Map<string, string>()
	private nextTag = -1
	private numbering: XmlDocument | undefined
	private originalNumbering: XmlDocument | undefined
	// The style sheet as edited (the translation's when the edit left it) and the styles it added.
	private styles: XmlDocument | undefined
	private edits: RtfEdits | undefined
	private newStyles = new Map<string, number>()
	// Each story part's relationships as edited: id → target.
	private readonly relationships = new Map<string, Map<string, { target: string; external: boolean }>>()
	private readonly drawingKeys = new Map<string, Map<string, string>>()
	// The source's pictures by relationship id: the first container's with each (picture).
	private sourcePictures: Map<string, { readonly part: string; readonly range: SourceRange }> | undefined
	// The pictures the edit inserted as written (newPicture), by document and drawing: every pass writes them alike.
	private readonly newPictures = new Map<XmlDocument, Map<number, Uint8Array>>()
	private get originalStyles(): XmlDocument | undefined {
		return this.originals.get("word/styles.xml")
	}

	// The groups open at each paragraph's and row's start (openGroups): all at once for the proof, else as written
	// blocks ask (one scan to each), all at once past a few.
	private groups = new Map<number, readonly boolean[]>()
	private groupPositions: number[] = []
	private groupMisses = 0

	private readonly source: RtfSource
	private readonly parts: ReadonlyMap<string, XmlDocument>
	private readonly originals: ReadonlyMap<string, XmlDocument>
	private readonly prove: boolean

	// The track-changes switch as edited (word/settings.xml w:trackRevisions), where it changed.
	private readonly tracking: boolean | undefined

	constructor(
		source: RtfSource,
		parts: ReadonlyMap<string, XmlDocument>,
		originals: ReadonlyMap<string, XmlDocument>,
		prove: boolean,
		tracking?: boolean
	) {
		this.tracking = tracking
		this.source = source
		this.parts = parts
		this.originals = originals
		this.prove = prove
		this.preserved = source.read.preserved
	}

	async prepare(edits: RtfEdits, job?: Job): Promise<void> {
		this.edits = edits

		for (const container of this.source.read.containers) {
			const id = key(container.part, container.id)

			if (job?.clock.due === true) await turn(job)

			if (container.kind === "footnote" || container.kind === "endnote") this.notes.set(id, container)
			else if (container.kind === "comment") this.comments.set(id, container)

			const original = this.originals.get(container.part)
			const edited = this.parts.get(container.part) ?? original

			if (original === undefined || edited === undefined) continue

			const originalElement = containerElement(original, container)
			const editedElement = containerElement(edited, container)

			if (originalElement < 0) throw new RtfWriteRefusal("map", `no ${id} in the translation`)
			if (editedElement < 0) {
				// A note or comment the edit took out with its reference (written with the paragraph that held it).
				if (container.kind === "body" || container.kind === "header" || container.kind === "footer")
					throw new RtfWriteRefusal("story", `${id} removed`)

				continue
			}

			const originalBlocks = blocksOf(original, originalElement)

			if (job?.clock.due === true) await turn(job)

			const editedBlocks = blocksOf(edited, editedElement)

			if (originalBlocks.blocks.length !== container.blocks.length)
				throw new RtfWriteRefusal("map", `${id}: ${originalBlocks.blocks.length} blocks, ${container.blocks.length} mapped`)

			if (originalBlocks.section < 0 !== editedBlocks.section < 0) throw new RtfWriteRefusal("section", "the body's last section")

			const lastSection =
				originalBlocks.section >= 0 && canonical(original, originalBlocks.section) !== canonical(edited, editedBlocks.section)
					? editedBlocks.section
					: -1

			this.states.set(id, {
				container,
				original,
				edited,
				originalBlocks: originalBlocks.blocks,
				editedBlocks: editedBlocks.blocks,
				lastSection,
				editedSection: editedBlocks.section,
				ops: []
			})
		}

		// Containers the edit added: a new comment is written where its reference is (commentReference); a new note or
		// header has no place in the RTF yet.
		for (const [part, document] of this.parts) {
			const root = document.documentElement()

			if (part === COMMENTS_EXTENDED_PART) continue

			if (part === "word/footnotes.xml" || part === "word/endnotes.xml" || part === COMMENTS_PART) {
				for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
					const id = document.attribute(child, "w:id") ?? ""
					const type = document.attribute(child, "w:type")

					if (type === "separator" || type === "continuationSeparator" || type === "continuationNotice") continue
					if (!this.states.has(key(part, id)) && !this.source.read.containers.some(c => key(c.part, c.id) === key(part, id))) {
						if (part !== COMMENTS_PART) throw new RtfWriteRefusal("story", `a new ${document.localName(child)}`)

						this.newComments.add(id)
					}
				}
			} else if (!this.source.read.containers.some(container => container.part === part)) {
				throw new RtfWriteRefusal("story", `a new part ${part}`)
			}
		}

		this.numbering = await this.editedPart(edits, "word/numbering.xml")
		this.originalNumbering = this.originals.get("word/numbering.xml")
		this.styles = await this.editedPart(edits, "word/styles.xml")

		if (edits.parts.has("word/styles.xml") && this.styles !== undefined) this.newStyles = this.addedStyles(this.styles)

		for (const part of new Set(this.source.read.containers.map(container => container.part))) {
			const slash = part.lastIndexOf("/")
			const rels = await this.editedPart(edits, `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`)
			const map = new Map<string, { target: string; external: boolean }>()

			if (rels !== undefined) {
				const root = rels.documentElement()

				for (let child = rels.firstChildElement(root); child >= 0; child = rels.nextSiblingElement(child))
					map.set(rels.attribute(child, "Id") ?? "", {
						target: rels.attribute(child, "Target") ?? "",
						external: rels.attribute(child, "TargetMode") === "External"
					})
			}

			this.relationships.set(part, map)
		}

		const positions: number[] = []
		const walk = (blocks: readonly SourceBlock[]): void => {
			for (const block of blocks) {
				if (block.kind === "p") {
					if (block.from >= 0) positions.push(block.start)
				} else {
					for (const row of block.rows) {
						positions.push(row.from)
						for (const cell of row.cells) walk(cell)
					}
				}
			}
		}

		for (const state of this.states.values()) walk(state.container.blocks)

		if (!this.prove) this.groupPositions = positions
		else if (job === undefined) this.groups = openGroups(this.source.bytes, positions)
		else {
			const steps = openGroupsSteps(this.source.bytes, positions, undefined, job.due)
			let step = steps.next()

			while (step.done !== true) {
				await turn(job)
				step = steps.next()
			}

			this.groups = step.value
		}
	}

	private async editedPart(edits: RtfEdits, name: string): Promise<XmlDocument | undefined> {
		const bytes = edits.parts.get(name)

		if (bytes !== undefined) return parseXml(bytes)

		return this.source.translation.has(name) ? await this.source.translation.xml(name) : undefined
	}

	// One run: the splices of every block not kept, the file.
	run(): { bytes: Uint8Array; written: number } {
		const steps = this.runSteps(undefined)
		let step = steps.next()

		while (step.done !== true) step = steps.next()

		return step.value
	}

	// run() in the job's slices.
	async runIn(job: Job | undefined): Promise<{ bytes: Uint8Array; written: number }> {
		if (job === undefined) return this.run()

		const steps = this.runSteps(job.due)
		let step = steps.next()

		while (step.done !== true) {
			await turn(job)
			step = steps.next()
		}

		return step.value
	}

	private *runSteps(due: (() => boolean) | undefined): Generator<void, { bytes: Uint8Array; written: number }> {
		const plan = new Plan(
			this.source,
			this.notes,
			(document, drawing) => this.picture(document, drawing),
			this.newStyles,
			(id, out) => this.styleEntry(id, plan, out),
			this.newLists(),
			(out, listId, ls) => {
				out.rtf("{").word("listoverride").word("listid", listId).word("listoverridecount", 0).word("ls", ls).rtf("}")
			},
			(document, id) => this.link(document, id),
			{ reference: (id, target, out) => this.commentReference(id, target, out), tag: id => this.commentTag(id) }
		)

		this.planForTables = plan
		this.lastPlan = plan

		for (const [id, state] of this.states) {
			yield* this.planOnce(id, state, plan, due)

			if (due?.() === true) yield
		}

		if (this.tracking !== undefined) plan.trackRevisions(this.tracking)

		const bytes = yield* plan.finish(due)

		return { bytes, written: plan.written }
	}

	// ---- per container

	// Steps at `due`.
	private *planOnce(id: string, state: ContainerState, plan: Plan, due: (() => boolean) | undefined): Generator<void, void> {
		const { original, edited, originalBlocks, editedBlocks, container } = state
		const forced = this.forced.get(id)
		const bytes = this.source.bytes
		const blocks = container.blocks
		const last = editedBlocks.length - 1
		// The role a paragraph at edited index j needs, against the source's.
		const fits = (source: SourceBlock, j: number): boolean => {
			if (source.kind !== "p") return true
			if (source.from < 0) return true

			const term = termOf(bytes, source)
			const section = hasSection(edited, editedBlocks[j] ?? -1)

			if (section) return term === "sect"

			// Ended by nothing (the story's last) or a word another place has: kept, its end written anew.
			return term === "par" || term === ""
		}
		// A kept paragraph whose end must change (the story's last no longer last): \\par in place of what ended it.
		const reterm = (source: SourceBlock, j: number): void => {
			if (source.kind !== "p" || source.from < 0 || j === last) return
			if (termOf(bytes, source) === "") plan.splice(source.end, source.end, out => out.word("par"))
		}
		const pairs = this.prove
			? []
			: commonPairs(originalBlocks.length, editedBlocks.length, (i, j) => {
					const source = blocks[i]

					return (
						source !== undefined &&
						forced?.has(j) !== true &&
						sameBytes(original, originalBlocks[i] ?? -1, edited, editedBlocks[j] ?? -1) &&
						fits(source, j)
					)
				})
		const ops: Op[] = []
		let i = 0
		let j = 0
		// Where the next written block goes: after the last block handled (or before the container's first).
		let at = firstFrom(blocks) ?? container.end

		const handle = (until: number, untilEdited: number): void => {
			// Source blocks [i, until) without a partner, edited blocks [j, untilEdited) to write: paired in order.
			while (i < until || j < untilEdited) {
				let source = i < until ? blocks[i] : undefined
				let node = j < untilEdited ? editedBlocks[j] : undefined

				// A paragraph and a table are not one block edited: the source's goes first, the edit's then comes
				// in after it (a table is never taken out for a paragraph put in its place).
				if (source !== undefined && node !== undefined && (source.kind === "p") !== (edited.localName(node) === "p")) {
					if (source.kind === "p") node = undefined
					else source = undefined
				}

				if (source !== undefined && node !== undefined) {
					const mark = plan.splices.length

					try {
						this.replace(id, state, plan, source, i, node, j)
					} catch (error) {
						// Gate 1: the block is locked and kept as it was.
						if (!this.prove || !(error instanceof RtfWriteRefusal)) throw error

						plan.splices.length = mark
						this.fail(id, j, error.reason)
					}

					ops.push({ kind: "write", source })
					at = endOf(source, at)
					i++
					j++
				} else if (source !== undefined) {
					this.remove(plan, source)
					at = endOf(source, at)
					i++
				} else if (node !== undefined) {
					const index = j

					this.insert(id, state, plan, at, node, index)
					ops.push({ kind: "write", source: undefined })
					j++
				}
			}
		}

		for (const [pi, pj] of pairs) {
			handle(pi, pj)

			const source = blocks[pi]

			if (source !== undefined) {
				ops.push({ kind: "keep", source })
				reterm(source, pj)
				at = endOf(source, at)
			}

			i = pi + 1
			j = pj + 1

			if (due?.() === true) yield
		}

		// Gate 1 pairs each block with itself (the same document on both sides): handled in runs, in slices.
		if (due !== undefined && this.prove && originalBlocks.length === editedBlocks.length)
			while (i < originalBlocks.length) {
				handle(Math.min(i + PLAN_RUN, originalBlocks.length), Math.min(j + PLAN_RUN, editedBlocks.length))

				if (due()) yield
			}

		handle(originalBlocks.length, editedBlocks.length)
		state.ops = ops

		// The last section's words changed: again, in full, at the end of the body (where the reader reads them).
		if (state.lastSection >= 0)
			plan.splice(container.end, container.end, out => this.writeSection(plan, edited, state.lastSection, out))
	}

	// Source block `index` of the container replaced by edited block `node` (index j).
	private replace(id: string, state: ContainerState, plan: Plan, source: SourceBlock, index: number, node: number, j: number): void {
		const edited = state.edited
		const local = edited.localName(node)

		if (source.kind === "p" && source.from < 0) {
			// The translation's own closing paragraph: there is nothing in the source to replace.
			if (!this.prove) this.insert(id, state, plan, endOfStory(state), node, j)

			return
		}

		if (source.kind === "p" && local === "p") {
			let term: ParagraphTerm
			let skeleton: Skeleton

			try {
				skeleton = this.checkContent(source)
				term = this.termFor(state, source, index, node, j, plan)
			} catch (error) {
				if (!this.prove || !(error instanceof RtfWriteRefusal)) throw error

				this.fail(id, j, error.reason)

				return
			}

			plan.splice(source.start, source.end, out => {
				this.paragraph(id, j, plan, edited, node, 0, term, out, source, skeleton)
			})

			return
		}

		if (source.kind === "tbl" && local === "tbl") {
			this.table(id, state, plan, source, index, node, j)

			return
		}

		// A paragraph became a table or the other way: the old one goes, the new one is written in its place.
		this.remove(plan, source)
		this.insert(id, state, plan, endOf(source, source.from), node, j)
	}

	private insert(id: string, state: ContainerState, plan: Plan, at: number, node: number, j: number): void {
		const edited = state.edited

		if (edited.localName(node) === "p") {
			const term = hasSection(edited, node) ? this.newSectionTerm(state, plan, node, j) : "par"

			plan.splice(at, at, out => this.paragraph(id, j, plan, edited, node, 0, term, out))
		} else {
			plan.splice(at, at, out => this.newTable(plan, edited, node, out))
		}
	}

	// The source of a block the edit removed: its content goes, what came before it (properties, destinations)
	// stays for what follows.
	private remove(plan: Plan, source: SourceBlock): void {
		if (source.kind === "p") {
			if (source.from < 0) return

			// What the reader kept in the source only goes with the block the user removed; only a kept range that
			// runs on past it stays a refusal.
			this.checkPreserved(source.start, source.end, true)

			const skeleton = this.skeleton(source.start, source.end)

			plan.splice(source.start, source.end, out => {
				out.rtf("}".repeat(skeleton.closes))
				this.reopen(source, skeleton, out)
			})

			return
		}

		const first = firstParagraph(source)
		const keepTo = first === undefined ? source.from : first.start

		this.drop(plan, keepTo, source.end)
	}

	// Removes source [from, to) (a table's, a row's), closing and opening the groups it did around what follows.
	private drop(plan: Plan, from: number, to: number): void {
		if (to <= from) return

		this.checkPreserved(from, to, true)

		const skeleton = this.skeleton(from, to)

		plan.splice(from, to, out => out.rtf("}".repeat(skeleton.closes) + "{".repeat(skeleton.opens)))
	}

	// The state the source paragraph's content leaves in force, for what follows it (carriedWords).
	private carry(source: SourceParagraph, out: RtfOut): void {
		for (const word of carriedWords(this.source.bytes, source.start, source.end).at(-1) ?? []) out.bytes(word)
	}

	// The groups the source paragraph left open opened again, each level's state words (carriedWords) where they
	// were: a word set before a group the paragraph opened stays outside it.
	private reopen(source: SourceParagraph, skeleton: Skeleton, out: RtfOut): void {
		const levels = carriedWords(this.source.bytes, source.start, source.end)

		if (levels.length !== skeleton.opens + 1) {
			out.rtf("{".repeat(skeleton.opens))
			this.carry(source, out)

			return
		}

		levels.forEach((words, k) => {
			if (k > 0) out.rtf("{")

			for (const word of words) out.bytes(word)
		})
	}

	// `removed`: the range goes whole, so what lies wholly inside it goes with it.
	private checkPreserved(start: number, end: number, removed = false): void {
		for (const kept of this.preserved) {
			if (removed && kept.start >= start && kept.end <= end) continue
			if (kept.end > start && kept.start < end) throw new RtfWriteRefusal("preserved", `${kept.kind} ${kept.name} in an edited block`)
		}
	}

	// The last checkpoint after a paragraph at or before `position` (none: read from the start).
	private checkpointBefore(position: number): Checkpoint | undefined {
		const list = this.source.read.checkpoints?.list ?? []
		let low = 0
		let high = list.length

		while (low < high) {
			const middle = (low + high) >> 1

			if ((list[middle] as Checkpoint).offset <= position) low = middle + 1
			else high = middle
		}

		for (let k = low - 1; k >= 0; k--) {
			const checkpoint = list[k] as Checkpoint

			if (checkpoint.paragraphEnd >= 0 && !checkpoint.end) return checkpoint
		}

		return undefined
	}

	private skeleton(start: number, end: number): Skeleton {
		let around = this.groups.get(start)

		if (around === undefined && ++this.groupMisses > GROUP_MISSES && this.groupPositions.length > 0) {
			for (const [position, groups] of openGroups(this.source.bytes, this.groupPositions)) this.groups.set(position, groups)

			this.groupPositions = []
			around = this.groups.get(start)
		}

		if (around === undefined) {
			around = openGroups(this.source.bytes, [start], this.checkpointBefore(start)).get(start) ?? []
			this.groups.set(start, around)
		}

		const result = replaceable(this.source.bytes, start, end, around)

		if (typeof result === "string") throw new RtfWriteRefusal("groups", result)

		return result
	}

	// Content a written paragraph would lose (what the reader kept in the source only: shapes, objects...), and
	// how its groups sit in those around it.
	private checkContent(source: SourceParagraph): Skeleton {
		this.checkPreserved(source.start, source.end)

		return this.skeleton(source.start, source.end)
	}

	private termFor(state: ContainerState, source: SourceParagraph, index: number, node: number, j: number, plan: Plan): ParagraphTerm {
		const term = termOf(this.source.bytes, source)

		if (!hasSection(state.edited, node)) return "par"

		if (term === "sect") {
			const original = state.originalBlocks[index] ?? -1

			// The same break: its \sect as it was (the section's words are before it in the source).
			if (sectionOf(state.original, original) === sectionOf(state.edited, node))
				return this.source.bytes.subarray(source.term, source.end)

			// Changed: written as a new break would be (the section that follows may take what it does not set from it).
		}

		return this.newSectionTerm(state, plan, node, j)
	}

	// A break the source has not, or one whose section changed: the section's words and \sect, then the words of the
	// section that goes on after it in full (the rest of a section it split, defined where that one starts; or one that
	// takes from the section before what it does not set itself).
	private newSectionTerm(state: ContainerState, plan: Plan, node: number, j: number): ParagraphTerm {
		const edited = state.edited
		let next = state.editedSection

		for (let k = j + 1; k < state.editedBlocks.length; k++) {
			const block = state.editedBlocks[k] ?? -1

			if (edited.localName(block) === "p" && hasSection(edited, block)) {
				next = childNamed(edited, childNamed(edited, block, "pPr"), "sectPr")
				break
			}
		}

		if (next < 0) throw new RtfWriteRefusal("section", "no section after a new break")

		const following = next

		return out => {
			this.writeSection(plan, edited, childNamed(edited, childNamed(edited, node, "pPr"), "sectPr"), out)
			out.word("sect")
			this.writeSection(plan, edited, following, out)
		}
	}

	// \sectd, a section's words and a copy of each header and footer it names (\sectd leaves a section none).
	private writeSection(plan: Plan, document: XmlDocument, sectPr: number, out: RtfOut): void {
		if (sectPr < 0) throw new RtfWriteRefusal("section", "no section properties")

		for (const reference of sectionWords(document, sectPr, plan, out)) {
			const target = this.relationships.get("word/document.xml")?.get(reference.id)
			const container =
				target === undefined ? undefined : this.source.read.containers.find(entry => entry.part === `word/${target.target}`)
			const group = container?.group

			if (group === undefined) throw new RtfWriteRefusal("section", `a new ${reference.footer ? "footer" : "header"}`)

			// The story's group after its destination word, under the word for this reference's type.
			const tokens = new RtfTokenizer(this.source.bytes.subarray(0, group.end), group.start + 1)

			tokens.next()
			out.rtf("{").word(
				`${reference.footer ? "footer" : "header"}${reference.type === "first" ? "f" : reference.type === "even" ? "l" : ""}`
			)
			plan.copy(tokens.end, group.end, out)
		}
	}

	// `skeleton`: the groups the source content it replaces closed and left open. `source`: under Gate 1, what
	// is written instead of a paragraph that cannot be (its source, kept).
	private paragraph(
		id: string,
		j: number,
		plan: Plan,
		document: XmlDocument,
		node: number,
		depth: number,
		term: ParagraphTerm,
		out: RtfOut,
		source?: SourceParagraph,
		skeleton: Skeleton = { closes: 0, opens: 0 }
	): void {
		plan.written++

		const sub = this.prove ? new RtfOut() : out

		try {
			sub.rtf("}".repeat(skeleton.closes))
			writeParagraph(document, node, { depth, term }, plan, sub)
			if (source === undefined) sub.rtf("{".repeat(skeleton.opens))
			else this.reopen(source, skeleton, sub)
		} catch (error) {
			if (!this.prove || !(error instanceof RtfWriteRefusal) || source === undefined) throw error

			this.fail(id, j, error.reason)
			plan.copy(source.start, source.end, out)

			return
		}

		if (sub !== out) for (const chunk of sub.finish()) out.bytes(chunk)
	}

	private fail(id: string, j: number, reason: string): void {
		let failed = this.failed.get(id)

		if (failed === undefined) {
			failed = new Map()
			this.failed.set(id, failed)
		}

		if (!failed.has(j)) failed.set(j, reason)
	}

	// A changed table: rows compared, kept rows copied, rows with the same definitions edited cell by cell, other
	// rows written whole.
	private table(id: string, state: ContainerState, plan: Plan, source: SourceTable, index: number, node: number, j: number): void {
		const originalTable = state.originalBlocks[index] ?? -1

		this.tableRows(id, j, plan, source, state.original, originalTable, state.edited, node, 1)
	}

	// The rows of a changed table at nesting `depth` (1: the top level), as table() says. A nested table's rows
	// (\\itapN paragraphs, \\nestcell, and their definitions in {\\*\\nesttableprops ... \\nestrow}: RTF 1.9.1,
	// "Tables") are kept, edited and written alike; their source ranges reach past the destination ending them.
	private tableRows(
		id: string,
		j: number,
		plan: Plan,
		source: SourceTable,
		original: XmlDocument,
		originalTable: number,
		edited: XmlDocument,
		node: number,
		depth: number
	): void {
		const originalRows = rowsOf(original, originalTable)
		const editedRows = rowsOf(edited, node)
		const tblPr = childNamed(edited, node, "tblPr")

		if (
			canonicalChild(original, originalTable, "tblPr") !== canonicalChild(edited, node, "tblPr") ||
			canonicalChild(original, originalTable, "tblGrid") !== canonicalChild(edited, node, "tblGrid")
		) {
			// The table's own properties are every row's in RTF: all rows are written.
			for (const row of source.rows) this.removeRow(plan, row, depth)

			const base = this.baseOf(source, original, originalTable, depth)
			const words = sourceTableWords(source)

			plan.splice(source.end, source.end, out => this.newTable(plan, edited, node, out, base, depth, words))

			return
		}

		if (originalRows.length !== source.rows.length) throw new RtfWriteRefusal("map", "table rows")

		const forcedTable = this.forced.get(id)?.has(j) === true
		const base = this.baseOf(source, original, originalTable, depth)
		// Gate 1 and a table written in full keep no row: no pair to look for.
		const pairs =
			this.prove || forcedTable
				? []
				: commonPairs(
						originalRows.length,
						editedRows.length,
						(a, b) => source.rows[a] !== undefined && sameBytes(original, originalRows[a] ?? -1, edited, editedRows[b] ?? -1)
					)
		let a = 0
		let b = 0
		let at = source.rows[0]?.from ?? source.from
		const handle = (untilA: number, untilB: number): void => {
			while (a < untilA || b < untilB) {
				const row = a < untilA ? source.rows[a] : undefined
				const editedRow = b < untilB ? editedRows[b] : undefined
				const originalRow = originalRows[a] ?? -1

				if (this.prove && row !== undefined && row.unread !== "") {
					this.fail(id, j, `word ${row.unread}`)
					at = row.end
					a++
					b++
				} else if (this.prove && row !== undefined && (row.merged || !row.closed)) {
					this.fail(id, j, "table")
					at = row.end
					a++
					b++
				} else if (
					row !== undefined &&
					editedRow !== undefined &&
					sameDefinitions(original, originalRow, edited, editedRow) &&
					!row.merged &&
					row.closed
				) {
					this.cells(id, j, plan, row, original, originalRow, edited, editedRow, depth)
					at = row.end
					a++
					b++
				} else if (row !== undefined) {
					this.removeRow(plan, row, depth)
					at = row.end
					a++
				} else if (editedRow !== undefined) {
					const position = at

					plan.splice(position, position, out =>
						this.newRow(plan, edited, tblPr, editedRow, out, base, depth, sourceTableWords(source))
					)
					b++
				}
			}
		}

		for (const [pa, pb] of pairs) {
			handle(pa, pb)
			at = source.rows[pa]?.end ?? at
			a = pa + 1
			b = pb + 1
		}

		handle(originalRows.length, editedRows.length)
	}

	// The left edge new rows of a source table are written from (tableLeft); a nested table's \\trleftN are inside its
	// destinations, so without an indent its rows are laid from the translation's grid alone.
	private baseOf(source: SourceTable, original: XmlDocument, originalTable: number, depth: number): number | undefined {
		if (depth <= 1 || childNamed(original, childNamed(original, originalTable, "tblPr"), "tblInd") >= 0)
			return this.tableLeft(source, original, originalTable)

		return undefined
	}

	private removeRow(plan: Plan, row: SourceRow, depth: number): void {
		if (!row.closed) throw new RtfWriteRefusal("table", "a row without its \\row")
		// Its definition holds words the translation does not: written again, the row would lose them.
		if (row.unread !== "") throw new RtfWriteRefusal("word", `a table row's ${row.unread}`)

		const first = firstParagraphOfRow(row)

		// A nested row goes with the paragraph properties before it (its \\itapN): left alone, they would put the
		// paragraph after them in a nested table no \\nestrow ends (LibreOffice 7.5 then drops that paragraph).
		this.drop(plan, first === undefined || depth >= 2 ? row.from : first.start, row.end)
	}

	// A row whose definitions stayed: its cells' paragraphs compared and written like a container's.
	private cells(
		id: string,
		j: number,
		plan: Plan,
		row: SourceRow,
		original: XmlDocument,
		originalRow: number,
		edited: XmlDocument,
		editedRow: number,
		depth: number
	): void {
		const originalCells = cellsOf(original, originalRow)
		const editedCells = cellsOf(edited, editedRow)

		if (originalCells.length !== editedCells.length || originalCells.length !== row.cells.length)
			throw new RtfWriteRefusal("table", "cells changed")

		const forcedTable = this.forced.get(id)?.has(j) === true

		row.cells.forEach((sources, c) => {
			const originalBlocks = blocksIn(original, originalCells[c] ?? -1)
			const editedBlocks = blocksIn(edited, editedCells[c] ?? -1)

			if (originalBlocks.length !== sources.length) throw new RtfWriteRefusal("map", "cell blocks")

			const last = editedBlocks.length - 1
			const fits = (source: SourceBlock, k: number): boolean => {
				if (source.kind !== "p" || source.from < 0) return true

				const term = termOf(this.source.bytes, source)

				if (k !== last) return term === "par"

				return depth >= 2 ? term === "nestcell" : term === "cell" || term === "row"
			}
			const pairs =
				this.prove || forcedTable
					? []
					: commonPairs(originalBlocks.length, editedBlocks.length, (x, y) => {
							const source = sources[x]

							return (
								source !== undefined &&
								sameBytes(original, originalBlocks[x] ?? -1, edited, editedBlocks[y] ?? -1) &&
								fits(source, y)
							)
						})
			let x = 0
			let y = 0
			// Inside the row (after its definitions): where the cell's first paragraph's content starts.
			let at = firstStart(sources) ?? row.from
			const handle = (untilX: number, untilY: number): void => {
				while (x < untilX || y < untilY) {
					const source = x < untilX ? sources[x] : undefined
					const node = y < untilY ? editedBlocks[y] : undefined
					const term = y === last ? (depth >= 2 ? "nestcell" : "cell") : "par"

					// A nested table that changed: its rows compared like the table's own.
					if (source?.kind === "tbl" && node !== undefined && edited.localName(node) === "tbl") {
						this.tableRows(id, j, plan, source, original, originalBlocks[x] ?? -1, edited, node, depth + 1)
						at = endOf(source, at)
						x++
						y++

						continue
					}

					// A nested table in place of a paragraph, or the other way round: one goes, the other is written.
					if ((node !== undefined && edited.localName(node) !== "p") || (source !== undefined && source.kind !== "p")) {
						const unread = source?.kind === "tbl" ? tableUnread(source) : ""

						if (this.prove) {
							if (unread !== "") this.fail(id, j, `word ${unread}`)

							x++
							y++

							continue
						}

						if (unread !== "") throw new RtfWriteRefusal("word", `a nested table row's ${unread}`)

						if (source !== undefined) {
							this.remove(plan, source)
							at = endOf(source, at)
							x++
						} else if (node !== undefined) {
							const position = at
							plan.splice(position, position, out => this.newTable(plan, edited, node, out, undefined, depth + 1))
							y++
						}

						continue
					}

					if (source !== undefined && node !== undefined && source.from >= 0) {
						let skeleton: Skeleton

						try {
							skeleton = this.checkContent(source)
						} catch (error) {
							if (!this.prove || !(error instanceof RtfWriteRefusal)) throw error

							this.fail(id, j, error.reason)
							at = source.end
							x++
							y++

							continue
						}

						plan.splice(source.start, source.end, out => {
							this.paragraph(id, j, plan, edited, node, depth, term, out, source, skeleton)
						})
						at = source.end
						x++
						y++
					} else if (source !== undefined && node !== undefined) {
						if (!this.prove) plan.splice(at, at, out => this.paragraph(id, j, plan, edited, node, depth, term, out))
						x++
						y++
					} else if (source !== undefined) {
						if (source.from >= 0) {
							const skeleton = this.checkContent(source)

							plan.splice(source.start, source.end, out => {
								out.rtf("}".repeat(skeleton.closes))
								this.reopen(source, skeleton, out)
							})
							at = source.end
						}
						x++
					} else if (node !== undefined) {
						plan.splice(at, at, out => this.paragraph(id, j, plan, edited, node, depth, term, out))
						y++
					}
				}
			}

			for (const [px, py] of pairs) {
				handle(px, py)

				const source = sources[px]

				if (source !== undefined && source.from >= 0) at = source.end

				x = px + 1
				y = py + 1
			}

			handle(originalBlocks.length, editedBlocks.length)
		})
	}

	// A top-level table in a group of its own: \\row leaves its row's definition in force, and a reader may keep a
	// following paragraph that sets no \\pard in the table (LibreOffice 7.5 does); the group ends the definition.
	private newTable(
		plan: Plan,
		document: XmlDocument,
		table: number,
		out: RtfOut,
		base?: number,
		depth = 1,
		words?: SourceTableWords
	): void {
		const tblPr = childNamed(document, table, "tblPr")

		if (depth <= 1) out.rtf("{")

		for (const row of rowsOf(document, table)) this.newRow(plan, document, tblPr, row, out, base, depth, words)

		if (depth <= 1) out.rtf("}")
	}

	private newRow(
		plan: Plan,
		document: XmlDocument,
		tblPr: number,
		row: number,
		out: RtfOut,
		base?: number,
		depth = 1,
		words?: SourceTableWords
	): void {
		plan.written++
		writeRow(document, tblPr, row, plan, out, this.cellWriter(plan, document), depth, base, words)
	}

	// A new cell's blocks: paragraphs, the last ending the cell, and tables nested one deeper.
	private cellWriter(plan: Plan, document: XmlDocument): RowWriter {
		return {
			cell: (tc, depth, out) => {
				const blocks = blocksIn(document, tc)

				blocks.forEach((block, k) => {
					const last = k === blocks.length - 1

					if (document.localName(block) === "tbl") {
						if (last) throw new RtfWriteRefusal("table", "a cell ending in a table")

						this.newTable(plan, document, block, out, undefined, depth + 1)
					} else {
						writeParagraph(document, block, { depth, term: last ? (depth >= 2 ? "nestcell" : "cell") : "par" }, plan, out)
					}
				})
			}
		}
	}

	// The left edge of a source table's grid, from its translation: the first row's left edge (the indent less the
	// leading margin, as the reader wrote them) less the grid columns before its first cell. Where the table is aligned
	// (no indent written), the least \\trleftN of its own rows (not of tables nested in it).
	private tableLeft(table: SourceTable, document: XmlDocument, node: number): number {
		const tblPr = childNamed(document, node, "tblPr")
		const indent = childNamed(document, tblPr, "tblInd")

		if (indent >= 0) {
			const margins = childNamed(document, tblPr, "tblCellMar")
			const leading = childNamed(document, margins, "left")
			const grid = childNamed(document, node, "tblGrid")
			const columns: number[] = []

			for (let column = grid < 0 ? -1 : document.firstChildElement(grid); column >= 0; column = document.nextSiblingElement(column))
				columns.push(Number(document.attribute(column, "w:w") ?? 0))

			const first = rowsOf(document, node)[0] ?? -1
			const before = childNamed(document, childNamed(document, first, "trPr"), "gridBefore")
			const skipped = before < 0 ? 0 : Number(document.attribute(before, "w:val") ?? 0)
			let left = Number(document.attribute(indent, "w:w") ?? 0) - (leading < 0 ? 0 : Number(document.attribute(leading, "w:w") ?? 0))

			for (let k = 0; k < skipped; k++) left -= columns[k] ?? 0

			return left
		}

		const tokens = new RtfTokenizer(this.source.bytes.subarray(0, table.end), Math.max(0, table.from))
		const nested: boolean[] = []
		let pending = false
		let left: number | undefined

		for (let kind = tokens.next(); kind !== Token.End; kind = tokens.next()) {
			if (pending) {
				pending = false

				if (kind === Token.Symbol && tokens.symbol === 0x2a) {
					pending = true

					continue
				}

				nested.push(kind === Token.Word && tokens.name === "nesttableprops")
			}

			if (kind === Token.GroupStart) pending = true
			else if (kind === Token.GroupEnd) nested.pop()
			else if (kind === Token.Word && tokens.name === "trleft" && !nested.includes(true))
				left = left === undefined ? tokens.param : Math.min(left, tokens.param)
		}

		return left ?? 0
	}

	// ---- pictures and lists

	// Comment `id` where its reference is (RTF 1.9.1, "Comments (Annotations)"): its initials (\\atnid) and author
	// (\\atnauthor), \\chatn, then the source's \\annotation group (its edits applied) or, for a comment the edit added,
	// one written from its w:comment: \\atnref (the text its range has), \\atndate and its paragraphs.
	private commentReference(id: string, plan: Plan, out: RtfOut): void {
		const document = this.parts.get(COMMENTS_PART) ?? this.originals.get(COMMENTS_PART)
		const element = document === undefined ? -1 : containerElement(document, { part: COMMENTS_PART, id })

		if (document === undefined || element < 0) throw new RtfWriteRefusal("comment", `a reference to no comment (${id})`)

		for (const { name } of document.attributes(element))
			if (!name.startsWith("xmlns") && name !== "w:id" && name !== "w:author" && name !== "w:date" && name !== "w:initials")
				throw new RtfWriteRefusal("comment", `w:comment/@${name}`)

		const initials = document.attribute(element, "w:initials") ?? ""
		const group = this.comments.get(key(COMMENTS_PART, id))?.group

		if (initials !== "") destination(out, "atnid", initials, plan.codepage)
		destination(out, "atnauthor", document.attribute(element, "w:author") ?? "", plan.codepage)
		out.word("chatn")

		if (group !== undefined) {
			plan.copy(group.start, group.end, out)

			return
		}

		if (!this.newComments.has(id)) throw new RtfWriteRefusal("comment", `comment ${id} has no annotation`)

		out.rtf("{\\*").word("annotation")
		destination(out, "atnref", this.commentTag(id), plan.codepage)

		const date = toDttm(document.attribute(element, "w:date"))

		if (date !== 0) destination(out, "atndate", String(date), plan.codepage)

		for (let child = document.firstChildElement(element); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "p") writeParagraph(document, child, { depth: 0, term: "par" }, plan, out)
			else throw new RtfWriteRefusal("comment", `a ${local} in a comment`)
		}

		out.rtf("}")
	}

	// The text of comment `id`'s \\atnref, which its \\atrfstart and \\atrfend hold: the source's; for a comment the edit
	// added, a number past every source comment's.
	private commentTag(id: string): string {
		const known = this.tags.get(id)

		if (known !== undefined) return known

		const group = this.comments.get(key(COMMENTS_PART, id))?.group
		let tag: string

		if (group !== undefined) {
			tag = annotationTag(this.source.bytes, group)

			if (tag === "") throw new RtfWriteRefusal("comment", "a range for a comment with no \\atnref")
		} else if (this.newComments.has(id)) {
			if (this.nextTag < 0) {
				this.nextTag = 1

				for (const container of this.comments.values()) {
					const number = container.group === undefined ? NaN : Number(annotationTag(this.source.bytes, container.group))

					if (Number.isSafeInteger(number) && number >= this.nextTag) this.nextTag = number + 1
				}
			}

			tag = String(this.nextTag++)
		} else {
			throw new RtfWriteRefusal("comment", `a range for no comment (${id})`)
		}

		this.tags.set(id, tag)

		return tag
	}

	private picture(document: XmlDocument, drawing: number): Uint8Array {
		const blip = descendant(document, drawing, "blip")
		const rId = blip < 0 ? undefined : document.attribute(blip, "r:embed")

		if (rId === undefined) throw new RtfWriteRefusal("drawing", "a drawing without a picture")

		if (this.sourcePictures === undefined) {
			this.sourcePictures = new Map()

			for (const container of this.source.read.containers)
				for (const [id, range] of container.pictures)
					if (!this.sourcePictures.has(id)) this.sourcePictures.set(id, { part: container.part, range })
		}

		const known = this.sourcePictures.get(rId)

		if (known !== undefined) {
			const original = this.originals.get(known.part)

			if (original !== undefined && this.drawingKey(known.part, original, rId) !== drawingKey(document, drawing))
				throw new RtfWriteRefusal("drawing", "an edited picture")

			return this.source.bytes.subarray(known.range.start, known.range.end)
		}

		let written = this.newPictures.get(document)

		if (written === undefined) {
			written = new Map()
			this.newPictures.set(document, written)
		}

		let bytes = written.get(drawing)

		if (bytes === undefined) {
			bytes = this.newPicture(document, drawing, rId)
			written.set(drawing, bytes)
		}

		// A view of the bytes written once: never changed.
		return bytes
	}

	// A picture the edit inserted: inline, its bytes a part the edit added.
	private newPicture(document: XmlDocument, drawing: number, rId: string): Uint8Array {
		const inline = childNamed(document, drawing, "inline")

		if (inline < 0) throw new RtfWriteRefusal("drawing", "a new floating picture")

		const extent = childNamed(document, inline, "extent")
		const docPr = childNamed(document, inline, "docPr")
		const graphicData = descendant(document, inline, "graphicData")

		if (graphicData < 0 || document.attribute(graphicData, "uri") !== "http://schemas.openxmlformats.org/drawingml/2006/picture")
			throw new RtfWriteRefusal("drawing", "a new drawing that is not a picture")
		if (descendant(document, drawing, "srcRect") >= 0) throw new RtfWriteRefusal("drawing", "a new picture cropped")
		if (descendant(document, drawing, "extLst") >= 0) throw new RtfWriteRefusal("drawing", "a new picture with extensions (an SVG)")

		const xfrm = descendant(document, graphicData, "xfrm")

		if (xfrm >= 0 && ["rot", "flipH", "flipV"].some(name => (document.attribute(xfrm, name) ?? "0") !== "0"))
			throw new RtfWriteRefusal("drawing", "a new picture rotated or flipped")

		let part: string | undefined

		for (const [name, candidate] of this.parts) if (candidate === document) part = name

		const target = part === undefined ? undefined : this.relationships.get(part)?.get(rId)
		const bytes = target === undefined || target.external ? undefined : this.edits?.parts.get(`word/${target.target}`)

		if (bytes === undefined) throw new RtfWriteRefusal("drawing", "a new picture without its bytes")

		const out = new RtfOut()

		writeNewPicture(
			{
				bytes,
				cx: Number(document.attribute(extent, "cx") ?? 0),
				cy: Number(document.attribute(extent, "cy") ?? 0),
				description: docPr < 0 ? "" : (document.attribute(docPr, "descr") ?? "")
			},
			this.source.read.facts.codepage,
			out
		)

		return joinChunks(out.finish())
	}

	private drawingKey(part: string, document: XmlDocument, rId: string): string | undefined {
		let keys = this.drawingKeys.get(part)

		if (keys === undefined) {
			keys = new Map()

			const walk = (node: number): void => {
				for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
					if (document.localName(child) === "drawing") {
						const blip = descendant(document, child, "blip")
						const id = blip < 0 ? undefined : document.attribute(blip, "r:embed")

						if (id !== undefined && !keys?.has(id)) keys?.set(id, drawingKey(document, child))
					} else {
						walk(child)
					}
				}
			}

			walk(document.documentElement())
			this.drawingKeys.set(part, keys)
		}

		return keys.get(rId)
	}

	// The external target of hyperlink relationship `id` of the part `document` is (as edited).
	private link(document: XmlDocument, id: string): string {
		let part: string | undefined

		for (const [name, candidate] of this.parts) if (candidate === document) part = name
		for (const [name, candidate] of this.originals) if (candidate === document) part ??= name

		const target = part === undefined ? undefined : this.relationships.get(part)?.get(id)

		if (target === undefined || !target.external) throw new RtfWriteRefusal("hyperlink", `relationship ${id}`)

		return target.target
	}

	// Styles the edit added (ids the translation's style sheet has not); a style it changed, or new defaults, refuse.
	private addedStyles(styles: XmlDocument): Map<string, number> {
		const originalStyles = this.originalStyles
		const out = new Map<string, number>()

		if (originalStyles === undefined) throw new RtfWriteRefusal("style", "the translation has no style sheet")

		const before = new Map<string, string>()
		const root = originalStyles.documentElement()

		for (let child = originalStyles.firstChildElement(root); child >= 0; child = originalStyles.nextSiblingElement(child)) {
			const local = originalStyles.localName(child)

			before.set(
				local === "style" ? (originalStyles.attribute(child, "w:styleId") ?? "") : `#${local}`,
				canonical(originalStyles, child)
			)
		}

		let next = 0

		for (const style of this.source.read.facts.styles.values()) if (style.number > next) next = style.number

		next++
		const editedRoot = styles.documentElement()

		for (let child = styles.firstChildElement(editedRoot); child >= 0; child = styles.nextSiblingElement(child)) {
			const local = styles.localName(child)
			const id = local === "style" ? (styles.attribute(child, "w:styleId") ?? "") : `#${local}`
			const known = before.get(id)

			if (known !== undefined) {
				if (known !== canonical(styles, child)) throw new RtfWriteRefusal("style", `the edit changed ${id}`)

				continue
			}

			if (local !== "style") throw new RtfWriteRefusal("style", `the edit added ${local}`)

			const type = styles.attribute(child, "w:type")

			if (type !== "paragraph" && type !== "character") throw new RtfWriteRefusal("style", `a new ${type} style`)

			out.set(id, next++)
		}

		return out
	}

	// A style table entry for style `id` the edit added.
	private styleEntry(id: string, plan: Plan, out: RtfOut): void {
		const styles = this.styles
		const number = this.newStyles.get(id)

		if (styles === undefined || number === undefined) return

		const node = styleElement(styles, id)

		if (node < 0) throw new RtfWriteRefusal("style", id)

		const paragraph = styles.attribute(node, "w:type") === "paragraph"
		let name = id

		out.rtf("{")
		if (paragraph) out.word("s", number)
		else out.rtf("\\*").word("cs", number).word("additive")

		// RTF states a style whole (\\sbasedonN only names its base): what the chain gives it first, its own after.
		for (const base of styleChain(styles, node).slice(0, -1)) {
			const pPr = childNamed(styles, base, "pPr")
			const rPr = childNamed(styles, base, "rPr")

			if (paragraph && pPr >= 0) paraWords(styles, pPr, plan, out)
			if (rPr >= 0) charWords(styles, rPr, plan, out)
		}

		for (let child = styles.firstChildElement(node); child >= 0; child = styles.nextSiblingElement(child)) {
			const local = styles.localName(child)
			const value = styles.attribute(child, "w:val") ?? ""

			switch (local) {
				case "name":
					name = value
					break
				case "basedOn":
					out.word("sbasedon", plan.style(value, paragraph ? "paragraph" : "character"))
					break
				case "next":
					if (paragraph) out.word("snext", plan.style(value, "paragraph"))
					break
				case "pPr":
					if (paragraph) paraWords(styles, child, plan, out)
					else throw new RtfWriteRefusal("style", "paragraph properties of a character style")
					break
				case "rPr":
					charWords(styles, child, plan, out)
					break
				case "uiPriority":
				case "qFormat":
				case "unhideWhenUsed":
				case "semiHidden":
				case "rsid":
				case "link":
				case "locked":
				case "aliases":
					break
				default:
					throw new RtfWriteRefusal("style", `${id}: ${local}`)
			}
		}

		const encoded = encodeText(name, this.source.read.facts.codepage)

		if (encoded.unicode) out.word("uc", 1)
		out.bytes(latin1Bytes(`${encoded.rtf};`)).rtf("}")
	}

	// Lists the edit added (w:num ids the source's numbering does not have), each written as a list table entry.
	private newLists(): Map<number, (out: RtfOut, listId: number) => void> {
		const out = new Map<number, (out: RtfOut, listId: number) => void>()
		const numbering = this.numbering

		if (numbering === undefined) return out

		const original = new Set<string>()
		const originalNumbering = this.originalNumbering

		if (originalNumbering !== undefined) {
			const root = originalNumbering.documentElement()

			for (let child = originalNumbering.firstChildElement(root); child >= 0; child = originalNumbering.nextSiblingElement(child)) {
				if (originalNumbering.localName(child) === "num") original.add(originalNumbering.attribute(child, "w:numId") ?? "")
			}
		}

		const root = numbering.documentElement()
		const abstracts = new Map<string, number>()

		for (let child = numbering.firstChildElement(root); child >= 0; child = numbering.nextSiblingElement(child)) {
			if (numbering.localName(child) === "abstractNum") abstracts.set(numbering.attribute(child, "w:abstractNumId") ?? "", child)
		}

		for (let child = numbering.firstChildElement(root); child >= 0; child = numbering.nextSiblingElement(child)) {
			if (numbering.localName(child) !== "num") continue

			const numId = numbering.attribute(child, "w:numId") ?? ""

			if (original.has(numId)) continue

			const abstractId = childNamed(numbering, child, "abstractNumId")
			const abstract = abstracts.get(abstractId < 0 ? "" : (numbering.attribute(abstractId, "w:val") ?? ""))

			if (abstract === undefined) continue

			for (let inner = numbering.firstChildElement(child); inner >= 0; inner = numbering.nextSiblingElement(inner)) {
				if (numbering.localName(inner) !== "abstractNumId")
					throw new RtfWriteRefusal("numbering", `a list's ${numbering.localName(inner)}`)
			}

			out.set(Number(numId), (target, listId) => this.listEntry(numbering, abstract, listId, target))
		}

		return out
	}

	private listEntry(numbering: XmlDocument, abstract: number, listId: number, out: RtfOut): void {
		out.rtf("{")
			.word("list")
			.word("listtemplateid", -listId - 1)

		for (let child = numbering.firstChildElement(abstract); child >= 0; child = numbering.nextSiblingElement(child)) {
			const local = numbering.localName(child)

			if (local === "lvl") this.levelEntry(numbering, child, out)
			else if (local !== "nsid" && local !== "multiLevelType" && local !== "tmpl" && local !== "name")
				throw new RtfWriteRefusal("numbering", `abstractNum/${local}`)
		}

		out.rtf("{").word("listname").rtf(" ;}").word("listid", listId).rtf("}")
	}

	private levelEntry(numbering: XmlDocument, level: number, out: RtfOut): void {
		out.rtf("{").word("listlevel")

		let text = ""
		let format = "decimal"
		let jc = "left"
		let follow = 0
		let start = 1
		let pPr = -1
		let rPr = -1

		for (let child = numbering.firstChildElement(level); child >= 0; child = numbering.nextSiblingElement(child)) {
			const local = numbering.localName(child)
			const value = numbering.attribute(child, "w:val") ?? ""

			switch (local) {
				case "start":
					start = Number(value)
					break
				case "numFmt":
					format = value
					break
				case "lvlText":
					text = value
					break
				case "lvlJc":
					jc = value
					break
				case "suff":
					follow = value === "space" ? 1 : value === "nothing" ? 2 : 0
					break
				case "isLgl":
					out.word("levellegal", 1)
					break
				case "lvlRestart":
					if (value !== "0") throw new RtfWriteRefusal("numbering", "lvlRestart")
					out.word("levelnorestart", 1)
					break
				case "pPr":
					pPr = child
					break
				case "rPr":
					rPr = child
					break
				case "pStyle":
				case "legacy":
				case "lvlPicBulletId":
					throw new RtfWriteRefusal("numbering", local)
				default:
					throw new RtfWriteRefusal("numbering", `lvl/${local}`)
			}
		}

		const nfc = NUMBER_FORMAT_CODES.get(format)

		if (nfc === undefined) throw new RtfWriteRefusal("numbering", `numFmt ${format}`)

		out.word("levelnfc", nfc).word("levelnfcn", nfc)
		out.word("leveljc", jc === "center" ? 1 : jc === "right" ? 2 : 0).word("leveljcn", jc === "center" ? 1 : jc === "right" ? 2 : 0)
		out.word("levelfollow", follow).word("levelstartat", start)

		// \leveltext: its length, then the template with level numbers as \'00..\'08.
		let template = ""
		let numbers = ""
		let length = 0

		for (let k = 0; k < text.length; k++) {
			const placeholder = /^%([1-9])/u.exec(text.slice(k))

			if (placeholder !== null) {
				template += `\\'0${Number(placeholder[1]) - 1}`
				numbers += `\\'${(length + 1).toString(16).padStart(2, "0")}`
				k++
			} else {
				template += encodeText(text[k] ?? "", this.source.read.facts.codepage).rtf
			}

			length++
		}

		out.rtf(`{\\leveltext\\uc1\\'${length.toString(16).padStart(2, "0")}${template};}{\\levelnumbers${numbers};}`)

		if (pPr >= 0) paraWordsOf(numbering, pPr, this.planForTables, out)

		if (rPr >= 0) charWordsOf(numbering, rPr, this.planForTables, out)

		out.rtf("}")
	}

	// The plan whose tables list entries add to (set during a run), and the last run's.
	planForTables: Plan | undefined = undefined
	private lastPlan: Plan | undefined = undefined

	// ---- the proof

	// Compares the file read back with the edit: blocks that differ are written (if they were kept) or refused.
	async verify(bytes: Uint8Array, job?: Job): Promise<"done" | "again"> {
		if (!this.prove && (await this.spanProof(bytes))) return "done"

		await turn(job)

		return this.fullProof(bytes, job)
	}

	// The proof by reading only the span the writing changed (checkpoint.ts), where it reaches a state the source
	// had: true when the file is proved to read as the edit; false leaves it to the whole file's reading. Everything
	// outside the span then reads as the translation, so the edit must hold the translation's parts and blocks there.
	async spanProof(written: Uint8Array): Promise<boolean> {
		const checkpoints = this.source.read.checkpoints
		const plan = this.lastPlan
		const edits = this.edits

		if (checkpoints === undefined || plan === undefined || edits === undefined || this.tracking !== undefined) return false
		if (plan.stylesAdded.length > 0 || plan.listsAdded.length > 0) return false

		let body: ContainerState | undefined

		for (const state of this.states.values()) {
			if (state.container.kind === "body") body = state
			else if (state.ops.some(op => op.kind !== "keep")) return false
		}

		if (body === undefined || body.lastSection >= 0) return false

		for (const [name, bytes] of edits.parts) {
			if (name === BODY_PART || name === SETTINGS_PART || IGNORED_PARTS.has(name)) continue
			if (!this.source.translation.has(name) || !equalBytes(bytes, await this.source.translation.read(name))) return false
		}

		const source = this.source.bytes
		const head = commonHead(source, written)
		const tail = commonTail(source, written, Math.min(source.length, written.length) - head)

		const from = startingPoint(checkpoints, head)

		if (from === undefined) return false

		const regionEnd = written.length - tail
		let span: ReturnType<typeof readSpan>

		try {
			span = readSpan(written, checkpoints, from, regionEnd, written.length - source.length, regionEnd + SPAN_REACH)
		} catch {
			return false
		}

		if (span === undefined) return false

		return this.spanReadsAsEdited(body, from, span.to, span.blocks)
	}

	// The body as read back: the translation's blocks before `from`, the span's, the translation's from `to` on.
	private spanReadsAsEdited(state: ContainerState, from: Checkpoint, to: Checkpoint, blocks: readonly Block[]): boolean {
		const sourceBlocks = state.container.blocks
		const placed = (checkpoint: Checkpoint): boolean => {
			if (checkpoint.end) return true
			if (checkpoint.paragraphEnd < 0) return checkpoint.blocks === 0

			const block = sourceBlocks[checkpoint.blocks - 1]

			return block?.kind === "p" && block.end === checkpoint.paragraphEnd
		}

		if (!placed(from) || !placed(to)) return false

		const edited = state.edited
		const original = state.original
		const expected = digestedBlocks(edited, containerElement(edited, state.container))
		const translated = digestedBlocks(original, containerElement(original, state.container))
		const head = from.blocks
		const tail = translated.length - to.blocks

		if (tail < 1 || head + blocks.length + tail !== expected.length) return false
		if (!sameSpan(edited, expected, 0, original, translated, 0, head)) return false
		if (!sameSpan(edited, expected, head + blocks.length, original, translated, to.blocks, tail)) return false

		const read = spanDocument(blocks)

		if (read === undefined) return false

		const names = this.styles === undefined ? new Map<string, string>() : styleNames(this.styles)
		const context: DigestContext = { target: id => `?${id}`, style: id => names.get(id) ?? `?${id}` }
		let node = read.firstChildElement(read.firstChildElement(read.documentElement()))

		for (let k = 0; k < blocks.length; k++, node = read.nextSiblingElement(node)) {
			const block = expected[head + k] ?? -1

			// A block the edited body holds in place of its markup (bodyWindows): beyond what is compared here.
			if (node < 0 || block < 0 || edited.attribute(block, "w:held") !== undefined) return false
			if (sameBytes(edited, block, read, node)) continue

			// The span holds no bookmarks or relationships: a block with them is compared in the whole file.
			const raw = edited.raw(block)

			if (namesRelationship(raw) || includes(raw, BOOKMARK)) return false
			if (blockDigest(edited, block, context) !== blockDigest(read, node, context)) return false
		}

		return true
	}

	async fullProof(bytes: Uint8Array, job?: Job): Promise<"done" | "again"> {
		const read = await readRtf(bytes, job === undefined ? { stored: true } : { stored: true, turns: job })

		await turn(job)

		if (!read.ok) throw new RtfWriteRefusal("proof", "the written file is not RTF")
		if (this.tracking !== undefined && read.facts.revisions.length > 0 !== this.tracking)
			throw new RtfWriteRefusal("proof", "the written file does not keep the track-changes switch")

		const newKinds = new Set(read.preserved.map(entry => entry.kind))

		for (const kind of ["unclosedGroup", "trailing", "tooDeep"] as const)
			if (newKinds.has(kind) && !this.preserved.some(entry => entry.kind === kind))
				throw new RtfWriteRefusal("proof", `the written file has ${kind}`)

		const reread = await OpcPackage.open(bytesSource(read.docx))

		await turn(job)

		const readParts = new Map<string, XmlDocument>()
		const readPart = async (name: string): Promise<XmlDocument | undefined> => {
			if (!reread.has(name)) return undefined

			let document = readParts.get(name)

			if (document === undefined) {
				document = await reread.xml(name, job?.aborting)
				readParts.set(name, document)
			}

			return document
		}
		const expectedTargets = await this.targets(
			name => this.expectedRelationships(name),
			this.source.translation,
			this.styles,
			async name => this.parts.get(name) ?? (this.source.translation.has(name) ? this.source.translation.xml(name) : undefined),
			true
		)
		const actualStyles = await readPart("word/styles.xml")
		const actualTargets = await this.targets(
			async name => (reread.has(name) ? reread.xml(name) : undefined),
			reread,
			actualStyles,
			readPart,
			false
		)
		let again = false
		// Gate 1 writes every block: one that reads back byte for byte as translated needs no digest where both name
		// styles alike and it names no relationship or bookmark end (whose names come from blocks before it).
		const stylesAlike = this.prove && sameNames(this.styles, actualStyles)

		// Notes and comments are numbered by where their references are: matched in that order on both sides, and each
		// comment's range by the comment it names.
		const expectedMarks: string[] = []
		const actualMarks: string[] = []
		const expectedNotes = await this.noteOrder(name => Promise.resolve(this.parts.get(name) ?? this.originals.get(name)), expectedMarks)
		const actualNotes = await this.noteOrder(readPart, actualMarks)
		// Each kind's ids by where they first come in the expected order.
		const expectedIndex = new Map<NoteKind | "comment", Map<string, number>>()

		for (const [kind, ids] of expectedNotes) {
			const index = new Map<string, number>()

			ids.forEach((noteId, k) => {
				if (!index.has(noteId)) index.set(noteId, k)
			})
			expectedIndex.set(kind, index)
		}

		if (expectedMarks.join() !== actualMarks.join()) {
			if (!this.prove) throw new RtfWriteRefusal("proof", "comment ranges and references read back otherwise")

			// Gate 1: every block with a comment's range or reference is kept as it is.
			for (const [id, state] of this.states)
				state.editedBlocks.forEach((block, k) => {
					if (includes(state.edited.raw(block), COMMENT_MARK)) this.fail(id, k, "comment")
				})
		}

		await turn(job)

		for (const [id, state] of this.states) {
			const container = state.container
			let actualId = container.id

			if (job?.clock.due === true) await turn(job)

			// Compared where a section names them (above).
			if (container.kind === "header" || container.kind === "footer") continue

			if (container.kind === "footnote" || container.kind === "endnote" || container.kind === "comment") {
				const order = expectedIndex.get(container.kind)?.get(container.id) ?? -1

				if (order < 0) continue

				actualId = actualNotes.get(container.kind)?.[order] ?? ""
			}

			const actualDocument = await readPart(container.part)

			if (actualDocument === undefined) throw new RtfWriteRefusal("proof", `${id} is not read back`)

			const actualElement = containerElement(actualDocument, { part: container.part, id: actualId })

			if (actualElement < 0) throw new RtfWriteRefusal("proof", `${id} is not read back`)

			const expectedElement = containerElement(state.edited, container)
			const expectedBlocks = digestedBlocks(state.edited, expectedElement)
			const actualBlocks = digestedBlocks(actualDocument, actualElement)
			// A kept block that reads back byte for byte as it was needs no digest (one naming relationships still
			// gets one: the same id may name another target there).
			const same = (k: number): boolean => {
				if (expectedBlocks.length !== actualBlocks.length) return false

				const expectedNode = expectedBlocks[k] ?? -1
				const actualNode = actualBlocks[k] ?? -1

				if (this.prove) {
					if (!stylesAlike || !sameBytes(state.edited, expectedNode, actualDocument, actualNode)) return false

					const raw = state.edited.raw(expectedNode)

					return !namesRelationship(raw) && !endsBookmark(raw)
				}

				if (state.ops[k]?.kind !== "keep") return false

				return (
					sameBytes(state.edited, expectedNode, actualDocument, actualNode) && !namesRelationship(state.edited.raw(expectedNode))
				)
			}
			const skipped: boolean[] = []

			for (let k = 0; k < expectedBlocks.length; k++) {
				skipped.push(same(k))

				if (job !== undefined && (k & 1023) === 1023 && job.clock.due) await turn(job)
			}

			const skip = (k: number): boolean => skipped[k] === true

			if (job?.clock.due === true) await turn(job)

			const expected = blockDigestsExcept(state.edited, expectedElement, expectedTargets(container.part), skip)

			if (job?.clock.due === true) await turn(job)

			const actual = blockDigestsExcept(actualDocument, actualElement, actualTargets(container.part), skip)

			if (expected.length !== actual.length) {
				if (this.prove) throw new RtfWriteRefusal("proof", `${id} reads back as ${actual.length} blocks, not ${expected.length}`)

				// Something leaked into the structure: everything kept in the container is written next time.
				if (this.forceAll(id, state)) again = true
				else throw new RtfWriteRefusal("proof", `${id} reads back as ${actual.length} blocks, not ${expected.length}`)

				continue
			}

			for (let k = 0; k < expected.length; k++) {
				if (expected[k] === actual[k]) continue

				// The body's last section properties come last in both.
				if (this.prove) {
					this.fail(id, k, "proof")

					continue
				}

				const op = state.ops[k]
				const table = op?.kind === "write" && op.source?.kind === "tbl"

				// A kept block, or a table some of whose rows were kept: written in full next time.
				if ((op?.kind === "keep" || table) && this.forced.get(id)?.has(k) !== true) {
					this.force(id, k)
					again = true
				} else {
					throw readBackRefusal(`${id} block ${String(k)}`, actual[k] ?? "", expected[k] ?? "")
				}
			}
		}

		// Comments the edit added read back with what it gave them: author, initials, date and blocks.
		if (this.newComments.size > 0) {
			const edited = this.parts.get(COMMENTS_PART)
			const actualDocument = await readPart(COMMENTS_PART)
			const expectedOrder = expectedIndex.get("comment")
			const actualOrder = actualNotes.get("comment") ?? []

			for (const id of this.newComments) {
				const order = expectedOrder?.get(id) ?? -1

				if (order < 0) throw new RtfWriteRefusal("comment", "a new comment without its reference")

				const expectedElement = edited === undefined ? -1 : containerElement(edited, { part: COMMENTS_PART, id })
				const actualElement =
					actualDocument === undefined
						? -1
						: containerElement(actualDocument, { part: COMMENTS_PART, id: actualOrder[order] ?? "" })

				if (edited === undefined || actualDocument === undefined || expectedElement < 0 || actualElement < 0)
					throw new RtfWriteRefusal("proof", `comment ${id} is not read back`)

				for (const name of ["w:author", "w:initials", "w:date"])
					if ((edited.attribute(expectedElement, name) ?? "") !== (actualDocument.attribute(actualElement, name) ?? ""))
						throw new RtfWriteRefusal("proof", `comment ${id} reads back with another ${name}`)

				const expected = blockDigestsExcept(edited, expectedElement, expectedTargets(COMMENTS_PART), () => false)
				const actual = blockDigestsExcept(actualDocument, actualElement, actualTargets(COMMENTS_PART), () => false)

				if (expected.join("\u0002") !== actual.join("\u0002"))
					throw readBackRefusal(`comment ${id}`, actual.join("\n"), expected.join("\n"))
			}
		}

		// Styles the edit added read back with the properties it gave them (by name: the reader names ids).
		for (const id of this.lastPlan?.stylesAdded ?? []) {
			const want = this.styles === undefined ? undefined : styleDefinition(this.styles, id, this.styles)
			const name = this.styles === undefined ? undefined : styleNames(this.styles).get(id)
			const actualId = actualStyles === undefined || name === undefined ? undefined : idOfName(actualStyles, name)
			const got =
				actualStyles === undefined || actualId === undefined ? undefined : styleDefinition(actualStyles, actualId, actualStyles)

			if (want === undefined || got === undefined || want !== got) throw readBackRefusal(`style ${id}`, got, want)
		}

		// Lists the edit added read back with the levels it gave them.
		const added = this.lastPlan?.listsAdded ?? []

		if (added.length > 0) {
			const expected = this.numbering
			const actual = await readPart("word/numbering.xml")

			for (const numId of added) {
				const want = expected === undefined ? undefined : levelsOf(expected, String(numId))
				const got = actual === undefined ? undefined : levelsOf(actual, String(numId))

				if (want === undefined || got === undefined || want !== got) throw readBackRefusal(`list ${String(numId)}`, got, want)
			}
		}

		return again ? "again" : "done"
	}

	private force(id: string, index: number): void {
		let set = this.forced.get(id)

		if (set === undefined) {
			set = new Set()
			this.forced.set(id, set)
		}

		set.add(index)
	}

	private forceAll(id: string, state: ContainerState): boolean {
		let any = false

		state.ops.forEach((op, index) => {
			if (op.kind === "keep" && this.forced.get(id)?.has(index) !== true) {
				this.force(id, index)
				any = true
			}
		})

		return any
	}

	private async expectedRelationships(name: string): Promise<XmlDocument | undefined> {
		return this.edits === undefined ? undefined : this.editedPart(this.edits, name)
	}

	// Relationship targets by part: media named by their bytes, other targets as written.
	// Header and footer references name their story by what it holds: a section's headers may be copies in the file
	// written (\\sectd leaves a section none), numbered otherwise than the source's.
	private async targets(
		relationships: (name: string) => Promise<XmlDocument | undefined>,
		media: OpcPackage,
		styles: XmlDocument | undefined,
		story: (name: string) => Promise<XmlDocument | undefined>,
		edited: boolean
	): Promise<(part: string) => DigestContext> {
		const cache = new Map<string, Map<string, string>>()
		const names = styles === undefined ? new Map<string, string>() : styleNames(styles)

		for (const container of this.source.read.containers) {
			const part = container.part

			if (cache.has(part)) continue

			const slash = part.lastIndexOf("/")
			const rels = await relationships(`${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`)
			const map = new Map<string, string>()

			if (rels !== undefined) {
				const root = rels.documentElement()

				for (let child = rels.firstChildElement(root); child >= 0; child = rels.nextSiblingElement(child)) {
					const id = rels.attribute(child, "Id") ?? ""
					const target = rels.attribute(child, "Target") ?? ""
					const external = rels.attribute(child, "TargetMode") === "External"
					const name = external ? undefined : `word/${target}`

					const header = name !== undefined && /^word\/(header|footer)\d+\.xml$/u.test(name) ? await story(name) : undefined

					if (header !== undefined) {
						// The story's own pictures by their bytes.
						const own = new Map<string, string>()
						const storyRels = await relationships(`word/_rels/${target}.rels`)

						for (
							let rel = storyRels === undefined ? -1 : storyRels.firstChildElement(storyRels.documentElement());
							rel >= 0 && storyRels !== undefined;
							rel = storyRels.nextSiblingElement(rel)
						) {
							const mediaName = `word/${storyRels.attribute(rel, "Target") ?? ""}`

							if (/\/media\//u.test(mediaName) && media.has(mediaName)) {
								const bytes = await media.read(mediaName)

								own.set(storyRels.attribute(rel, "Id") ?? "", `media:${bytes.length}:${hash(bytes)}`)
							}
						}

						map.set(
							id,
							`story:${blockDigests(header, header.documentElement(), { target: value => own.get(value) ?? value }).join("\u0002")}`
						)
					} else if (
						name !== undefined &&
						/\/media\//u.test(name) &&
						((edited && this.edits?.parts.has(name) === true) || media.has(name))
					) {
						const bytes = (edited ? this.edits?.parts.get(name) : undefined) ?? (await media.read(name))

						map.set(id, `media:${bytes.length}:${hash(bytes)}`)
					} else {
						map.set(id, `${external ? "external:" : ""}${target}`)
					}
				}
			}

			cache.set(part, map)
		}

		return part => ({ target: id => cache.get(part)?.get(id) ?? `?${id}`, style: id => names.get(id) ?? `?${id}` })
	}

	// Each note and comment id in the order of its reference; with comments, each range mark and reference as the
	// comment it names (by that order).
	private async noteOrder(
		part: (name: string) => Promise<XmlDocument | undefined>,
		marks?: string[]
	): Promise<Map<NoteKind | "comment", string[]>> {
		const order = new Map<NoteKind | "comment", string[]>([
			["footnote", []],
			["endnote", []],
			["comment", []]
		])
		const comments = order.get("comment") ?? []
		const raw: [string, string][] = []
		const names = [
			"word/document.xml",
			...new Set(this.source.read.containers.filter(c => c.kind === "header" || c.kind === "footer").map(c => c.part))
		]

		for (const name of names) {
			const document = await part(name)

			if (document === undefined) continue

			const walk = (node: number): void => {
				for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
					const local = document.localName(child)

					if (local === "footnoteReference" || local === "endnoteReference") {
						order.get(local === "footnoteReference" ? "footnote" : "endnote")?.push(document.attribute(child, "w:id") ?? "")
					} else if (local === "commentReference" || local === "commentRangeStart" || local === "commentRangeEnd") {
						const id = document.attribute(child, "w:id") ?? ""

						if (local === "commentReference") comments.push(id)
						if (marks !== undefined) raw.push([local, id])
					} else walk(child)
				}
			}

			walk(document.documentElement())
		}

		if (marks !== undefined) {
			const index = new Map<string, number>()

			comments.forEach((id, k) => {
				if (!index.has(id)) index.set(id, k)
			})

			for (const [local, id] of raw) marks.push(`${local}:${index.get(id) ?? -1}`)
		}

		return order
	}

	// Gate 1's verdict: top-level blocks (by their offset in the translation's part) that do not round-trip.
	lockedBlocks(): RtfProofResult["locked"] {
		const out: { part: string; offset: number; reason: string }[] = []

		for (const [id, failed] of this.failed) {
			const state = this.states.get(id)

			if (state === undefined) continue

			for (const [index, reason] of failed) {
				const node = state.originalBlocks[index]

				if (node !== undefined) out.push({ part: state.container.part, offset: state.original.start(node), reason })
			}
		}

		return out
	}
}

const NUMBER_FORMAT_CODES = new Map<string, number>([
	["decimal", 0],
	["upperRoman", 1],
	["lowerRoman", 2],
	["upperLetter", 3],
	["lowerLetter", 4],
	["ordinal", 5],
	["cardinalText", 6],
	["ordinalText", 7],
	["bullet", 23],
	["decimalZero", 22],
	["none", 255]
])

// Where two digests part: a little of each from there.
// A read-back refusal names where `what` differs, never what it holds: the message is logged, and digests, style
// definitions and list levels carry document text. The window around the first difference is on the detail.
function readBackRefusal(what: string, actual: string | undefined, expected: string | undefined): RtfWriteRefusal {
	if (actual === undefined || expected === undefined)
		return new RtfWriteRefusal(
			"proof",
			`${what} reads back differently: ${actual === undefined ? "nothing read back" : "nothing expected"}`,
			`${String(actual)}\n!=\n${String(expected)}`
		)

	let at = 0

	while (at < actual.length && actual[at] === expected[at]) at++

	const from = Math.max(0, at - 80)

	return new RtfWriteRefusal(
		"proof",
		`${what} reads back differently at offset ${String(at)}, ${String(actual.length)} characters written, ${String(expected.length)} expected`,
		`…${actual.slice(from, at + 160)}\n!=\n…${expected.slice(from, at + 160)}`
	)
}

// The levels of list `numId` (its w:num's abstract definition), canonical.
function levelsOf(numbering: XmlDocument, numId: string): string | undefined {
	const root = numbering.documentElement()
	let abstractId: string | undefined

	for (let child = numbering.firstChildElement(root); child >= 0; child = numbering.nextSiblingElement(child)) {
		if (numbering.localName(child) !== "num" || numbering.attribute(child, "w:numId") !== numId) continue

		const reference = childNamed(numbering, child, "abstractNumId")

		abstractId = reference < 0 ? undefined : numbering.attribute(reference, "w:val")
	}

	if (abstractId === undefined) return undefined

	for (let child = numbering.firstChildElement(root); child >= 0; child = numbering.nextSiblingElement(child)) {
		if (numbering.localName(child) !== "abstractNum" || numbering.attribute(child, "w:abstractNumId") !== abstractId) continue

		let out = ""

		for (let level = numbering.firstChildElement(child); level >= 0; level = numbering.nextSiblingElement(level))
			if (numbering.localName(level) === "lvl") out += canonical(numbering, level).replace(/ w:tplc="[^"]*"/u, "")

		return out
	}

	return undefined
}

function hash(bytes: Uint8Array): string {
	let h = 0x811c9dc5

	for (let k = 0; k < bytes.length; k++) h = Math.imul(h ^ (bytes[k] ?? 0), 0x01000193)

	return (h >>> 0).toString(16)
}

function drawingKey(document: XmlDocument, drawing: number): string {
	const walk = (at: number): string => {
		const local = document.localName(at)
		const attributes = document
			.attributes(at)
			.filter(
				attribute =>
					!attribute.name.startsWith("xmlns") &&
					!((local === "docPr" || local === "cNvPr") && (attribute.name === "id" || attribute.name === "name"))
			)
			.map(attribute => `${attribute.name}=${attribute.value}`)
			.sort()
			.join(" ")
		let out = `<${local} ${attributes}>`

		for (let child = document.firstChildElement(at); child >= 0; child = document.nextSiblingElement(child)) out += walk(child)

		return out
	}

	return walk(drawing)
}

function canonicalChild(document: XmlDocument, node: number, local: string): string {
	const child = childNamed(document, node, local)

	return child < 0 ? "" : canonical(document, child)
}

function sectionOf(document: XmlDocument, paragraph: number): string {
	const pPr = childNamed(document, paragraph, "pPr")
	const sectPr = pPr < 0 ? -1 : childNamed(document, pPr, "sectPr")

	return sectPr < 0 ? "" : canonical(document, sectPr)
}

function rowsOf(document: XmlDocument, table: number): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(table); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "tr") out.push(child)
		else if (local !== "tblPr" && local !== "tblGrid") throw new RtfWriteRefusal("tableContent", local)
	}

	return out
}

function cellsOf(document: XmlDocument, row: number): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(row); child >= 0; child = document.nextSiblingElement(child))
		if (document.localName(child) === "tc") out.push(child)

	return out
}

function blocksIn(document: XmlDocument, cell: number): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(cell); child >= 0; child = document.nextSiblingElement(child)) {
		const local = document.localName(child)

		if (local === "p" || local === "tbl") out.push(child)
		else if (local !== "tcPr" && local !== "bookmarkStart" && local !== "bookmarkEnd") throw new RtfWriteRefusal("tableContent", local)
	}

	return out
}

// The row's own definitions and its cells' (not their content) are the same.
function sameDefinitions(a: XmlDocument, aRow: number, b: XmlDocument, bRow: number): boolean {
	if (canonicalChild(a, aRow, "trPr") !== canonicalChild(b, bRow, "trPr")) return false
	if (canonicalChild(a, aRow, "tblPrEx") !== canonicalChild(b, bRow, "tblPrEx")) return false

	const aCells = cellsOf(a, aRow)
	const bCells = cellsOf(b, bRow)

	return (
		aCells.length === bCells.length &&
		aCells.every((cell, k) => canonicalChild(a, cell, "tcPr") === canonicalChild(b, bCells[k] ?? -1, "tcPr"))
	)
}

// What the source table's rows state that a row written into it restates (SourceTableWords): their \\tblindN (relative
// to their \\trleftN where it is in twips) and a \\tsN no style holds. Rows that disagree have no one value to
// restate: a row written into their table is refused.
function sourceTableWords(table: SourceTable): SourceTableWords | undefined {
	const first = table.rows[0]

	if (first === undefined) return undefined

	const indentOf = (row: SourceRow): SourceTableWords["indent"] => {
		if (row.indent === undefined) return undefined

		const relative = row.indentType === -1 || row.indentType === 3

		return { relative, value: relative ? row.indent - row.left : row.indent, type: row.indentType }
	}
	const indent = indentOf(first)
	const style = first.danglingStyle >= 0 ? first.danglingStyle : undefined

	for (const row of table.rows) {
		const other = indentOf(row)
		const same =
			other === undefined || indent === undefined
				? other === indent
				: other.relative === indent.relative && other.value === indent.value && other.type === indent.type

		if (!same) throw new RtfWriteRefusal("table", "rows with different \\tblindN")
		if ((row.danglingStyle >= 0 ? row.danglingStyle : undefined) !== style)
			throw new RtfWriteRefusal("table", "rows with different \\tsN")
	}

	return indent === undefined && style === undefined
		? undefined
		: { ...(indent === undefined ? {} : { indent }), ...(style === undefined ? {} : { style }) }
}

// The words a table's rows, or those of tables nested in them, hold that their translation does not (SourceRow.unread).
function tableUnread(table: SourceTable): string {
	for (const row of table.rows) {
		if (row.unread !== "") return row.unread

		for (const cell of row.cells)
			for (const block of cell) {
				const nested = block.kind === "tbl" ? tableUnread(block) : ""

				if (nested !== "") return nested
			}
	}

	return ""
}

function firstStart(blocks: readonly SourceBlock[]): number | undefined {
	for (const block of blocks) {
		if (block.kind === "p" && block.from >= 0) return block.start
		if (block.kind === "tbl") return firstParagraph(block)?.start
	}

	return undefined
}

function firstFrom(blocks: readonly SourceBlock[]): number | undefined {
	for (const block of blocks) if (block.from >= 0) return block.from

	return undefined
}

function endOf(block: SourceBlock, fallback: number): number {
	return block.end >= 0 ? block.end : fallback
}

function endOfStory(state: ContainerState): number {
	for (let k = state.container.blocks.length - 1; k >= 0; k--) {
		const block = state.container.blocks[k]

		if (block !== undefined && block.end >= 0) return block.end
	}

	return state.container.end
}

function firstParagraph(table: SourceTable): SourceParagraph | undefined {
	for (const row of table.rows) {
		const found = firstParagraphOfRow(row)

		if (found !== undefined) return found
	}

	return undefined
}

function firstParagraphOfRow(row: SourceRow): SourceParagraph | undefined {
	for (const cell of row.cells) {
		for (const block of cell) {
			if (block.kind === "p" && block.from >= 0) return block

			if (block.kind === "tbl") {
				const found = firstParagraph(block)

				if (found !== undefined) return found
			}
		}
	}

	return undefined
}

function paraWordsOf(document: XmlDocument, pPr: number, plan: Plan | undefined, out: RtfOut): void {
	if (plan === undefined) throw new RtfWriteRefusal("numbering", "no plan")

	paraWords(document, pPr, plan, out)
}

function charWordsOf(document: XmlDocument, rPr: number, plan: Plan | undefined, out: RtfOut): void {
	if (plan === undefined) throw new RtfWriteRefusal("numbering", "no plan")

	charWords(document, rPr, plan, out)
}

// `body`: the body's part as edited and as translated, when given (bodyWindows), in place of the whole parts.
async function partsOf(
	source: RtfSource,
	edits: RtfEdits,
	body?: BodyWindows,
	job?: Job
): Promise<{ parts: Map<string, XmlDocument>; originals: Map<string, XmlDocument>; tracking: boolean | undefined }> {
	const slicing = job?.aborting
	const parts = new Map<string, XmlDocument>()
	const originals = new Map<string, XmlDocument>()
	let tracking: boolean | undefined

	if (body !== undefined) originals.set(BODY_PART, body.original)

	for (const [name, bytes] of edits.parts) {
		if (name === BODY_PART && body !== undefined) parts.set(name, body.edited)
		else if (STORY_PART.test(name)) parts.set(name, slicing === undefined ? parseXml(bytes) : await parseXmlSliced(bytes, slicing))
		else if (name === SETTINGS_PART) tracking = await trackingChange(source, parseXml(bytes))
		else if (name === COMMENTS_EXTENDED_PART) commentStates(parseXml(bytes))
		else if (RELS_PART.test(name) || IGNORED_PARTS.has(name) || name === "word/numbering.xml" || name === "word/styles.xml")
			parts.set(name, parseXml(bytes))
		// A picture the edit added: written where its drawing is (newPicture).
		else if (MEDIA_PART.test(name)) continue
		else throw new RtfWriteRefusal("part", `the edit changed ${name}`)
	}

	for (const name of edits.removed ?? []) throw new RtfWriteRefusal("part", `the edit removed ${name}`)

	for (const container of source.read.containers) {
		if (!originals.has(container.part)) {
			const document = await source.translation.xml(container.part, slicing)

			if (container.part === BODY_PART) source.body ??= indexBody(document, translationSize(source, BODY_PART))

			originals.set(container.part, document)
		}
	}

	for (const name of ["word/numbering.xml", "word/styles.xml"])
		if (source.translation.has(name)) originals.set(name, await source.translation.xml(name))

	return { parts, originals, tracking }
}

function translationSize(source: RtfSource, part: string): number {
	return source.translation.entry(part)?.uncompressedSize ?? -1
}

const SETTINGS_PART = "word/settings.xml"

// The settings as edited against the translation's: the track-changes switch is all RTF can write of them
// (\revisions); any other change is refused.
async function trackingChange(source: RtfSource, edited: XmlDocument): Promise<boolean | undefined> {
	const original = await source.translation.xml(SETTINGS_PART)
	const read = (document: XmlDocument): { tracking: boolean; rest: string[] } => {
		const rest: string[] = []
		let tracking = false

		for (let child = document.firstChild(document.documentElement()); child >= 0; child = document.nextSibling(child)) {
			if (document.kind(child) !== NodeKind.Element) continue
			if (document.localName(child) === "trackRevisions") {
				const value = document.attribute(child, "w:val")

				tracking = value === undefined || value === "true" || value === "1" || value === "on"
			} else rest.push(canonical(document, child))
		}

		return { tracking, rest }
	}
	const before = read(original)
	const after = read(edited)

	if (before.rest.join("") !== after.rest.join("")) throw new RtfWriteRefusal("part", `the edit changed ${SETTINGS_PART}`)

	return before.tracking === after.tracking ? undefined : after.tracking
}

// Writes the edited document as RTF; refuses (RtfWriteRefusal) what it cannot write as edited. `span: false` writes
// and proves the whole document even where the edit changed only a span of the body. `turns`: written in slices.
// `onFallback`: an error the span's writing threw (neither a refusal nor the end of the job), the whole document
// written in its place.
export async function writeRtf(
	source: RtfSource,
	edits: RtfEdits,
	options: { readonly span?: boolean; readonly turns?: RtfTurns; readonly onFallback?: (error: unknown) => void } = {}
): Promise<RtfWritten> {
	if (edits.parts.size === 0 && (edits.removed?.length ?? 0) === 0) return { bytes: source.bytes, written: 0, rounds: 0, path: "whole" }

	const job = jobOf(options.turns)

	if (options.span !== false) {
		try {
			const written = await writeChanged(source, edits, job)

			if (written !== undefined) return written
		} catch (error) {
			if (error instanceof RtfAborted) throw error
			// Refused or not: the whole document's writing decides.
			if (!(error instanceof RtfWriteRefusal)) options.onFallback?.(error)
		}
	}

	const { parts, originals, tracking } = await partsOf(source, edits, undefined, job)

	await turn(job)

	const writer = new RtfWriter(source, storyPartsOf(parts), originals, false, tracking)

	await writer.prepare(edits, job)

	for (let round = 1; round <= MAX_ROUNDS; round++) {
		await turn(job)

		const { bytes, written } = await writer.runIn(job)

		if ((await writer.verify(bytes, job)) === "done") return { bytes, written, rounds: round, path: "whole" }
	}

	throw new RtfWriteRefusal("proof", "the written file does not settle")
}

// An edit of the body alone, written and proved where it changed the body (bodyWindows, spanProof); undefined
// leaves it to the whole document's writing.
async function writeChanged(source: RtfSource, edits: RtfEdits, job: Job | undefined): Promise<RtfWritten | undefined> {
	const writer = await spanWriter(source, edits)

	if (writer === undefined) return undefined

	const { bytes, written } = await writer.runIn(job)

	return (await writer.spanProof(bytes)) ? { bytes, written, rounds: 1, path: "span" } : undefined
}

// A writer of the body's changed span (prepared), where the edit is one.
async function spanWriter(source: RtfSource, edits: RtfEdits): Promise<RtfWriter | undefined> {
	const body = edits.parts.get(BODY_PART)

	if (body === undefined || source.read.checkpoints === undefined || (edits.removed?.length ?? 0) > 0) return undefined

	// A picture the edit added names a relationship, which the span's proof never takes (spanReadsAsEdited).
	for (const name of edits.parts.keys()) if (MEDIA_PART.test(name)) return undefined

	const windows = await bodyWindows(source, body)

	if (windows === undefined) return undefined

	const { parts, originals, tracking } = await partsOf(source, edits, windows)

	if (tracking !== undefined) return undefined

	const writer = new RtfWriter(source, storyPartsOf(parts), originals, false)

	await writer.prepare(edits)

	return writer
}

function storyPartsOf(parts: ReadonlyMap<string, XmlDocument>): Map<string, XmlDocument> {
	return new Map([...parts].filter(([name]) => STORY_PART.test(name)))
}

// Both proofs of `written` as the file of `edits` (bytes the writer need not have written: what a test hands in):
// whether the span's proves it, and the whole file's verdict ("done", "again", or the refusal's message).
export async function proveWritten(
	source: RtfSource,
	edits: RtfEdits,
	written: Uint8Array
): Promise<{ readonly span: boolean; readonly whole: string }> {
	let span = false

	try {
		const writer = await spanWriter(source, edits)

		if (writer !== undefined) {
			writer.run()
			span = await writer.spanProof(written)
		}
	} catch {
		span = false
	}

	const { parts, originals, tracking } = await partsOf(source, edits)
	const writer = new RtfWriter(source, storyPartsOf(parts), originals, false, tracking)

	await writer.prepare(edits)
	writer.run()

	try {
		return { span, whole: await writer.fullProof(written) }
	} catch (error) {
		if (!(error instanceof RtfWriteRefusal)) throw error

		return { span, whole: error.message }
	}
}

// Gate 1: every paragraph of the document written from its WordprocessingML and read back; the top-level blocks
// that do not come back as they were are locked. `turns`: proved in slices.
export async function proveRtf(source: RtfSource, turns?: RtfTurns): Promise<RtfProofResult> {
	const job = jobOf(turns)
	const { originals } = await partsOf(source, { parts: new Map() }, undefined, job)

	await turn(job)

	const writer = new RtfWriter(source, new Map(), originals, true)

	await writer.prepare({ parts: new Map() }, job)
	await turn(job)

	const { bytes, written } = await writer.runIn(job)

	await writer.verify(bytes, job)

	return { locked: writer.lockedBlocks(), written }
}

export { RtfAborted, RtfWriteRefusal }
export type { RtfTurns }
export type { SourceRange }
export { carriedWords, openGroups, replaceable }
