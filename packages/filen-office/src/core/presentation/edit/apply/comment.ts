import { spliceAll } from "../../../arrays"
import {
	MAX_COMMENTS_PER_SLIDE,
	commentCharactersFit,
	commentTextProblem,
	commentTime,
	initialsOf,
	reviewFacts,
	setSlideComments,
	slideComments,
	threadOrder,
	type CommentEntry,
	type CommentFormat,
	type SlideComments
} from "../../comments"
import { refused, type Author, type Deck, type Refused, type SlideNode } from "../../model"
import type { ApplyFamily, ApplyResult, Touch } from "../apply"
import type { CommentModel, CommentOp } from "../ops"

// The comment ops on the session's comments (core/presentation/comments.ts): add a thread, reply to one, edit a
// comment's text, resolve or reopen a thread (modern comments only: legacy and ODF comments have no such state), delete
// a comment (a thread's root takes its replies with it). Every op replaces the slide's list; its inverse puts the list
// it replaced back whole, entries and their source bytes as they were, and the deck's authors with it, so an undo
// after a save writes the comments the file had byte for byte. The inverse is an op of this family the session marks
// (RESTORES): it never leaves the worker, so the mark needs no field of the op's contract.
//
// A new comment takes the deck's form (reviewFacts: modern when the file has modern comments or none, legacy in a
// legacy-only file, odf in an ODF deck); a reply takes its thread's. Its author is the deck's author of that name, or
// a new one: a modern author with the GUID the page sent (userId the name, providerId "None", as PowerPoint writes a
// local author), a legacy p:cmAuthor with the next id, an ODF dc:creator name. The op as applied names the comment's
// id and author as they were made, so a redo makes the same ones.

type AddOp = Extract<CommentOp, { kind: "add" | "reply" }>

interface Held {
	readonly entries: readonly CommentEntry[]
	readonly authors?: readonly Author[]
}

const RESTORES = new WeakMap<CommentOp, Held>()

const GUID = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/iu
const LEGACY_ID = /^legacy:(\d+):(\d+)$/u

function slideOf(deck: Deck, op: CommentOp): { readonly node: SlideNode; readonly held: SlideComments } | Refused {
	const node = deck.nodes.get(op.slide)

	if (node === undefined) return refused("notFound", `slide ${String(op.slide)} is not parsed`)
	if (node.kind !== "slide") return refused("unsupported", "comments on a node that is not a slide")

	const held = slideComments(deck, op.slide)

	if (held === undefined) return refused("notFound", `the comments of slide ${String(op.slide)} were not read`)

	return { node, held }
}

function checkText(text: string): Refused | undefined {
	if (text.trim() === "") return refused("malformed", "an empty comment")

	const problem = commentTextProblem(text)

	return problem === undefined ? undefined : refused(problem === "comment text" ? "tooLarge" : "malformed", problem)
}

// The author a new comment is written with: `model.author` when the deck has it, else the deck's author named `name`
// in the comment's form, else a new one (added to `authors`).
function authorFor(
	format: CommentFormat,
	model: CommentModel,
	name: string | undefined,
	authors: Author[],
	chosenInitials: string | undefined
): { readonly id: string; readonly legacyId?: number } | Refused {
	if (format === "odf") {
		const own = name ?? model.author

		return own.trim() === "" ? refused("malformed", "a comment without an author") : { id: own }
	}

	const legacy = format === "legacy"
	const ofForm = authors.filter(author => (author.legacyId !== undefined) === legacy)
	const known =
		ofForm.find(author => author.id === model.author) ?? (name === undefined ? undefined : ofForm.find(author => author.name === name))

	if (known !== undefined) return { id: known.id, ...(known.legacyId === undefined ? {} : { legacyId: known.legacyId }) }
	if (name === undefined || name.trim() === "") return refused("malformed", "a comment without an author")

	const initials = chosenInitials ?? initialsOf(name)

	if (legacy) {
		let next = 0

		for (const author of authors) if (author.legacyId !== undefined) next = Math.max(next, author.legacyId + 1)

		const wanted = /^\d+$/u.test(model.author) ? Number(model.author) : -1
		const legacyId = wanted >= 0 && !authors.some(author => author.legacyId === wanted) ? wanted : next

		authors.push({ id: String(legacyId), name, ...(initials === "" ? {} : { initials }), legacyId })

		return { id: String(legacyId), legacyId }
	}

	if (!GUID.test(model.author)) return refused("malformed", "a new comment author's id")
	if (authors.some(author => author.id.toLowerCase() === model.author.toLowerCase())) return refused("malformed", "a taken author id")

	authors.push({ id: model.author, name, ...(initials === "" ? {} : { initials }), userId: name, providerId: "None" })

	return { id: model.author }
}

// The next comment index of a legacy author: past every index of the comments read so far and its p:cmAuthor lastIdx
// (§19.4.2: an index is never reused).
function nextLegacyIdx(deck: Deck, authorId: number): number {
	let last = reviewFacts(deck)?.legacyLastIdx.get(authorId) ?? 0

	for (const ref of deck.slides) {
		for (const entry of slideComments(deck, ref)?.entries ?? []) {
			if (entry.legacy?.authorId === authorId) last = Math.max(last, entry.legacy.idx)
		}
	}

	return last + 1
}

function rootOf(entries: readonly CommentEntry[], id: string): CommentEntry | undefined {
	const entry = entries.find(each => each.id === id)

	return entry?.parent === undefined ? entry : entries.find(each => each.id === entry.parent)
}

function inverseBytes(entries: readonly CommentEntry[]): number {
	let bytes = 64 + entries.length * 8

	for (const entry of entries) if (entry.changed) bytes += entry.text.length * 2

	return bytes
}

function add(deck: Deck, op: AddOp, node: SlideNode, held: SlideComments): ApplyResult<CommentOp> {
	const checked = checkText(op.comment.text)

	if (checked !== undefined) return checked
	if (held.entries.length + 1 > MAX_COMMENTS_PER_SLIDE) return refused("tooLarge", "comments on one slide")

	const parent = op.kind === "reply" ? rootOf(held.entries, op.parent) : undefined

	if (op.kind === "reply" && parent === undefined) return refused("notFound", `comment ${op.parent}`)

	const format: CommentFormat | undefined = parent?.format ?? (deck.format === "odp" ? "odf" : reviewFacts(deck)?.format)

	if (format === undefined) return refused("notFound", "the deck's comments were not read")
	if ((format === "odf") !== (deck.format === "odp")) return refused("unsupported", `${format} comments in a ${deck.format} deck`)

	const authors = [...deck.authors]
	const author = authorFor(format, op.comment, op.authorName, authors, op.authorInitials)

	if ("kind" in author) return author

	let id = op.comment.id
	let legacy: CommentEntry["legacy"]

	if (format === "legacy") {
		const authorId = author.legacyId ?? 0
		const asked = LEGACY_ID.exec(id)
		const idx =
			asked !== null && Number(asked[1]) === authorId && !held.entries.some(entry => entry.id === id)
				? Number(asked[2])
				: nextLegacyIdx(deck, authorId)

		id = `legacy:${String(authorId)}:${String(idx)}`
		legacy = {
			authorId,
			idx,
			...(parent?.legacy === undefined ? {} : { parent: { authorId: parent.legacy.authorId, idx: parent.legacy.idx } })
		}
	} else if (format === "modern" && !GUID.test(id)) return refused("malformed", "a modern comment's id")

	if (id === "" || held.entries.some(entry => entry.id === id)) return refused("malformed", "a taken comment id")

	const created = commentTime(op.comment.created)
	// Legacy p:pos is required (§19.4.1), and LibreOffice places an annotation by its svg:x and svg:y: a new one without a
	// place goes to the slide's top left.
	const anchor = parent?.anchor ?? op.comment.anchor ?? (format === "modern" ? undefined : { x: 0, y: 0 })
	const entry: CommentEntry = {
		id,
		format,
		...(parent === undefined ? {} : { parent: parent.id }),
		author: author.id,
		text: op.comment.text,
		created,
		resolved: false,
		...(anchor === undefined ? {} : { anchor }),
		changed: true,
		plain: true,
		...(legacy === undefined ? {} : { legacy })
	}
	const changedAuthors = authors.length !== deck.authors.length
	// A reply goes after its thread's last; a new thread after the last thread.
	const entries = threadOrder([...held.entries, entry])

	if (!commentCharactersFit(deck, op.slide, entries)) return refused("tooLarge", "comment characters on one slide or in the deck")

	const result = replace(deck, op, node, held, entries, changedAuthors ? authors : undefined)
	const comment: CommentModel = { ...op.comment, id, author: author.id, created }

	return result.kind === "applied" ? { ...result, op: { ...op, comment } } : result
}

// The slide's list replaced by `entries` (and the deck's authors by `authors`): the inverse puts back what it replaces.
function replace(
	deck: Deck,
	op: CommentOp,
	node: SlideNode,
	held: SlideComments,
	entries: readonly CommentEntry[],
	authors?: readonly Author[]
): ApplyResult<CommentOp> {
	const inverse: CommentOp = { family: "comment", kind: "delete", slide: op.slide, id: "" }

	RESTORES.set(inverse, { entries: held.entries, ...(authors === undefined ? {} : { authors: [...deck.authors] }) })

	if (authors !== undefined) spliceAll(deck.authors, 0, deck.authors.length, authors)

	setSlideComments(deck, op.slide, { entries, scope: held.scope })
	node.revision++

	return { kind: "applied", inverse: { ops: [inverse], bytes: inverseBytes(held.entries) }, op }
}

const UNCHANGED = { ops: [], bytes: 0 }

export const applyComment: ApplyFamily<CommentOp> = {
	apply(deck, op) {
		const found = slideOf(deck, op)

		if ("kind" in found) return found

		const { node, held } = found
		const restore = RESTORES.get(op)

		if (restore !== undefined) return replace(deck, op, node, held, restore.entries, restore.authors)

		switch (op.kind) {
			case "add":
			case "reply":
				return add(deck, op, node, held)
			case "edit": {
				const entry = held.entries.find(each => each.id === op.id)

				if (entry === undefined) return refused("notFound", `comment ${op.id}`)
				if (!entry.plain) return refused("unsupported", "a comment whose content is more than its text")

				const checked = checkText(op.text)

				if (checked !== undefined) return checked
				if (op.text === entry.text) return { kind: "applied", inverse: UNCHANGED, op }

				const entries = held.entries.map(each => (each === entry ? { ...entry, text: op.text, changed: true } : each))

				if (!commentCharactersFit(deck, op.slide, entries))
					return refused("tooLarge", "comment characters on one slide or in the deck")

				return replace(deck, op, node, held, entries)
			}
			case "resolve": {
				const root = rootOf(held.entries, op.id)

				if (root === undefined) return refused("notFound", `comment ${op.id}`)
				if (root.format !== "modern") return refused("unsupported", `resolving ${root.format} comments`)
				if (root.resolved === op.resolved && root.status === undefined) return { kind: "applied", inverse: UNCHANGED, op }

				const { status: _status, ...rest } = root

				return replace(
					deck,
					op,
					node,
					held,
					held.entries.map(each => (each === root ? { ...rest, resolved: op.resolved, changed: true } : each))
				)
			}
			case "delete": {
				const entry = held.entries.find(each => each.id === op.id)

				if (entry === undefined) return refused("notFound", `comment ${op.id}`)

				const gone = new Set([entry.id])

				if (entry.parent === undefined) for (const each of held.entries) if (each.parent === entry.id) gone.add(each.id)

				return replace(
					deck,
					op,
					node,
					held,
					held.entries.filter(each => !gone.has(each.id))
				)
			}
		}
	},
	touches(op) {
		const touches: Touch[] = [{ kind: "slide", slide: op.slide, dirt: { kind: "slidePart", part: "comments" } }]

		if (op.kind === "add" || op.kind === "reply" || RESTORES.get(op)?.authors !== undefined)
			touches.push({ kind: "presentation", what: "authors" })

		return touches
	}
}
