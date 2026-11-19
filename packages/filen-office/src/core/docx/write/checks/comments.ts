import { NodeKind, type XmlDocument } from "../../../xml/index"
import { COMMENT_NAMESPACES, COMMENT_PARTS, type CommentPartKind } from "../../model/comments"
import { Ns } from "../../model/namespaces"
import { partReader } from "../../model/reader"
import { DocxVerifyError } from "../failure"
import type { CheckedPart, CheckInput, DocxCheck } from "./index"

// The comments of a save hold together: every new reference and range resolves to a comment, a new range
// ends, a comment the save removed leaves no anchor behind, a new comment takes no id the source's ranges or
// references use without a comment (it would take them over) and has an author. commentsExtended, commentsIds
// and commentsExtensible entries the save wrote name paragraph ids the story parts have, never twice, a
// resolved state or parent of a paragraph that exists, durable ids that are unique and known; no entry is
// left for a comment the save removed; people.xml lists each author once, and nothing writes an author's
// e-mail, presence or foreign attributes. Gate 2 counts comment, range, reference and
// paragraph ids itself (verify.ts); duplicates among them refuse there.

interface Entry {
	readonly key: string
	readonly values: readonly (string | undefined)[]
}

interface Family {
	// Entries of each family part as written that the source part does not have as they are.
	readonly added: Map<CommentPartKind, Entry[]>
	// Every entry as written, per part.
	readonly written: Map<CommentPartKind, Entry[]>
	// commentRangeEnd elements the save added to story parts, by id.
	readonly ends: Map<string, number>
}

const STATES = new WeakMap<CheckInput, Family>()

function stateOf(input: CheckInput): Family {
	let state = STATES.get(input)

	if (state === undefined) {
		state = { added: new Map(), written: new Map(), ends: new Map() }
		STATES.set(input, state)
	}

	return state
}

const KINDS = Object.keys(COMMENT_PARTS) as CommentPartKind[]
// What identifies an entry and what it says, per part.
const FIELDS: Readonly<Record<CommentPartKind, { readonly ns: Ns; readonly key: string; readonly values: readonly string[] }>> = {
	commentsExtended: { ns: Ns.W15, key: "paraId", values: ["paraIdParent", "done"] },
	commentsIds: { ns: Ns.W16Cid, key: "paraId", values: ["durableId"] },
	commentsExtensible: { ns: Ns.W16Cex, key: "durableId", values: ["dateUtc"] },
	people: { ns: Ns.W15, key: "author", values: [] }
}

function fail(reason: "duplicateId" | "danglingReference" | "content", message: string): never {
	throw new DocxVerifyError(reason, message)
}

function entries(document: XmlDocument, kind: CommentPartKind): Entry[] {
	const reader = partReader(document)
	const fields = FIELDS[kind]
	const info = COMMENT_PARTS[kind]
	const out: Entry[] = []
	const root = document.documentElement()

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (!reader.is(child, fields.ns, info.child)) continue

		const key = reader.attr(child, fields.ns, fields.key)
		const upper = kind === "people" ? key : key?.toUpperCase()

		out.push({ key: upper ?? "", values: fields.values.map(name => reader.attr(child, fields.ns, name)?.toUpperCase()) })
	}

	return out
}

function signature(entry: Entry): string {
	return `${entry.key}\u0000${entry.values.join("\u0000")}`
}

// Attributes and elements no comment writer of ours makes (an author's e-mail or presence, foreign
// attributes), counted in nodes [first, end) of a document.
function foreign(document: XmlDocument, first = 0, end = document.count): number {
	let count = 0

	for (let node = first; node < end; node++) {
		if (document.kinds[node] !== NodeKind.Element) continue
		if (document.localName(node) === "presenceInfo") count++

		for (const attribute of document.attributes(node)) {
			const name = attribute.name

			if (name.endsWith("authorEmail") || name.startsWith("custom:")) count++
		}
	}

	return count
}

// The node after `node`'s subtree.
function after(document: XmlDocument, node: number): number {
	let next = node + 1

	while (next < document.count && (document.starts[next] ?? 0) < document.end(node)) next++

	return next
}

function kindOf(input: CheckInput, name: string): CommentPartKind | undefined {
	const type = input.types.typeOf(name)

	return KINDS.find(kind => COMMENT_PARTS[kind].contentType === type)
}

async function familyPart(input: CheckInput, part: CheckedPart, kind: CommentPartKind): Promise<void> {
	const state = stateOf(input)
	const written = entries(part.document, kind)
	const original = input.original.has(part.name) ? await input.original.xml(part.name) : undefined
	const before = original === undefined ? [] : entries(original, kind)
	const known = new Set(before.map(signature))

	state.written.set(kind, written)
	state.added.set(
		kind,
		written.filter(entry => !known.has(signature(entry)))
	)

	if (foreign(part.document) > (original === undefined ? 0 : foreign(original)))
		fail("content", `${part.name}: an author e-mail, presence or foreign attribute was added`)

	// Each key once, as far as the source has them once.
	const seen = new Map<string, number>()
	const sourceCount = new Map<string, number>()

	for (const entry of written) seen.set(entry.key, (seen.get(entry.key) ?? 0) + 1)
	for (const entry of before) sourceCount.set(entry.key, (sourceCount.get(entry.key) ?? 0) + 1)

	for (const [key, count] of seen) {
		if (count > 1 && count > (sourceCount.get(key) ?? 0)) fail("duplicateId", `${part.name}: ${key} appears ${count} times`)
	}
}

// The name ids of `document` whose local name is `local` (none in most parts: no scan then).
function namesOf(document: XmlDocument, local: string): Set<number> {
	const out = new Set<number>()

	document.names.forEach((name, id) => {
		if (name === local || name.endsWith(`:${local}`)) out.add(id)
	})

	return out
}

// Counts the commentRangeEnd elements (`names`: their name ids in `document`) starting in bytes [from, to) of
// `document` into `into`, times `sign`.
function rangeEnds(
	document: XmlDocument,
	names: ReadonlySet<number>,
	into: Map<string, number>,
	sign: number,
	from = 0,
	to = Number.MAX_SAFE_INTEGER
): void {
	if (names.size === 0 || to <= from) return

	const reader = partReader(document)
	const starts = document.starts
	const ids = document.nameIds
	let low = 0
	let high = document.count

	while (low < high) {
		const middle = (low + high) >> 1

		if ((starts[middle] ?? 0) < from) low = middle + 1
		else high = middle
	}

	for (let node = low; node < document.count && (starts[node] ?? 0) < to; node++) {
		if (document.kinds[node] !== NodeKind.Element || !names.has(ids[node] ?? -1) || reader.group(node) !== Ns.W) continue

		const id = reader.attr(node, Ns.W, "id")

		if (id !== undefined) into.set(id, (into.get(id) ?? 0) + sign)
	}
}

// What a story's source range [from, to) lost to the rewrite, its copies (`trusted`) given back: the range less
// every copy, as walking the whole range and then each copy would count it (a range copied twice counts once
// more, a copy from outside the range whole). Only the gaps between the copies are walked, not the source the
// copies cover.
function replacedRangeEnds(
	document: XmlDocument,
	names: ReadonlySet<number>,
	into: Map<string, number>,
	from: number,
	to: number,
	trusted: readonly number[]
): void {
	const ranges: [number, number][] = []

	for (let k = 0; k < trusted.length; k += 4) ranges.push([trusted[k + 2] ?? 0, trusted[k + 3] ?? 0])

	ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])

	let at = from

	for (const [start, end] of ranges) {
		if (start < at || start >= to) {
			// Copied before, or from outside the range: it counts once more.
			rangeEnds(document, names, into, 1, start, end)

			continue
		}

		rangeEnds(document, names, into, -1, at, start)
		// What it copies past the range is not given back by a gap.
		rangeEnds(document, names, into, 1, to, end)
		at = Math.min(end, to)
	}

	rangeEnds(document, names, into, -1, at, to)
}

// Range ends a story part gained, counted as gate 2 counts ids: the new markup's (a skeleton: copies of
// source nodes stand as placeholders) less what the rewritten stories replaced of the source, or a whole
// part's against the source's. And attributes no writer of ours makes.
function storyPart(input: CheckInput, part: CheckedPart): void {
	const document = part.document
	const state = stateOf(input)
	const source = part.part
	const original = source !== undefined && input.original.has(part.name) ? source.document : undefined

	rangeEnds(document, namesOf(document, "commentRangeEnd"), state.ends, 1)

	if (original === undefined || source === undefined) return

	const names = namesOf(original, "commentRangeEnd")

	if (names.size === 0) return

	if (!part.skeleton) {
		rangeEnds(original, names, state.ends, -1)

		return
	}

	for (const story of input.changes.stories) {
		if (story.part !== source) continue

		const item = story.session.story.story.item
		const node = item >= 0 ? source.node(item) : -1
		const from = node >= 0 ? original.start(node) : (story.range?.from ?? 0)
		const to = node >= 0 ? original.end(node) : (story.range?.to ?? 0)

		replacedRangeEnds(original, names, state.ends, from, to, story.output.trusted)
	}
}

const DECLARABLE = new Set<string>([
	COMMENT_NAMESPACES.w14,
	COMMENT_NAMESPACES.w15,
	"http://schemas.openxmlformats.org/markup-compatibility/2006"
])

// A story part's root as written differs from the source's at most by declarations of w14, w15 and mc and by
// those prefixes made ignorable (what the save adds to a 2007-era comments part so its paragraphs take ids).
function sameRoot(part: CheckedPart): void {
	const source = part.part?.document
	const document = part.document

	if (source === undefined) return

	const root = document.documentElement()
	const sourceRoot = source.documentElement()

	if (document.name(root) !== source.name(sourceRoot)) fail("content", `${part.name}: its root is another element`)

	const before = new Map(source.attributes(sourceRoot).map(attribute => [attribute.name, attribute.value]))
	const after = new Map(document.attributes(root).map(attribute => [attribute.name, attribute.value]))
	const declared = new Map<string, string>()

	for (const [name, value] of after) if (name.startsWith("xmlns:")) declared.set(name.slice(6), value)

	const mc = [...declared].find(([, uri]) => uri === "http://schemas.openxmlformats.org/markup-compatibility/2006")?.[0]
	const ignorable = mc === undefined ? undefined : `${mc}:Ignorable`

	for (const [name, value] of after) {
		const was = before.get(name)

		if (was === value) continue

		if (name === ignorable) {
			const tokens = new Set((was ?? "").split(/\s+/).filter(token => token !== ""))
			const added = value.split(/\s+/).filter(token => token !== "" && !tokens.has(token))

			if (
				[...tokens].every(token => value.split(/\s+/).includes(token)) &&
				added.every(token => DECLARABLE.has(declared.get(token) ?? ""))
			)
				continue
		} else if (was === undefined && name.startsWith("xmlns:") && DECLARABLE.has(value)) {
			continue
		}

		fail("content", `${part.name}: its root's ${name} changed`)
	}

	for (const name of before.keys()) if (!after.has(name)) fail("content", `${part.name}: its root lost ${name}`)
}

// New comments in the comments part: each has an author, and no author e-mail or foreign attribute.
function newComments(input: CheckInput, part: CheckedPart): void {
	const document = part.document
	const reader = partReader(document)
	const root = document.documentElement()

	if (!reader.is(root, Ns.W, "comments")) return

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (!reader.is(child, Ns.W, "comment")) continue

		const id = reader.attr(child, Ns.W, "id")

		if (id === undefined || input.source(`comment:${id}`) > 0) continue
		if ((reader.attr(child, Ns.W, "author") ?? "") === "") fail("content", `A new comment ${id} has no author`)
		if (foreign(document, child, after(document, child)) > 0)
			fail("content", `A new comment ${id} has an author e-mail or a foreign attribute`)
	}
}

export const commentChecks: readonly DocxCheck[] = [
	{
		async part(input, part) {
			const kind = kindOf(input, part.name)

			if (kind !== undefined) {
				await familyPart(input, part, kind)

				return
			}

			if (part.part === undefined) return

			sameRoot(part)
			storyPart(input, part)
			newComments(input, part)
		},
		done(input) {
			const state = stateOf(input)

			for (const id of input.added("commentReference")) {
				if (input.ids(`comment:${id}`) < 1) fail("danglingReference", `A new reference to comment ${id} has no comment`)
			}

			const starts = new Set(input.added("commentRangeStart"))

			for (const id of starts) {
				if (input.ids(`comment:${id}`) < 1) fail("danglingReference", `A new range of comment ${id} has no comment`)
				if ((state.ends.get(id) ?? 0) < 1) fail("danglingReference", `A new range of comment ${id} has no end`)
			}

			for (const [id, count] of state.ends) {
				if (count > 0 && !starts.has(id)) fail("duplicateId", `A new end of comment ${id}'s range has no new start`)
			}

			for (const id of input.added("comment")) {
				if (
					input.source(`comment:${id}`) === 0 &&
					(input.source(`commentRangeStart:${id}`) > 0 || input.source(`commentReference:${id}`) > 0)
				)
					fail("duplicateId", `A new comment ${id} takes the id of a range or reference without a comment`)
			}

			// paraIds and durable ids the new entries name.
			const paragraph = (id: string | undefined): boolean => id === undefined || input.ids(`paraId:${id}`) > 0
			const durable = new Set((state.written.get("commentsIds") ?? []).map(entry => entry.values[0]))

			for (const entry of state.added.get("commentsExtended") ?? []) {
				for (const id of [entry.key, entry.values[0]])
					if (!paragraph(id)) fail("danglingReference", `commentsExtended names paragraph ${id ?? ""}, which no part has`)
			}

			for (const entry of state.added.get("commentsIds") ?? []) {
				const value = entry.values[0]

				if (!paragraph(entry.key)) fail("danglingReference", `commentsIds names paragraph ${entry.key}, which no part has`)
				if (value === undefined || !/^[0-9A-F]{8}$/.test(value) || Number.parseInt(value, 16) >= 0x80000000)
					fail("content", `commentsIds: durable id ${value ?? ""} is not valid`)
			}

			const durableIds = new Map<string, number>()

			for (const entry of state.written.get("commentsIds") ?? []) {
				const value = entry.values[0] ?? ""

				durableIds.set(value, (durableIds.get(value) ?? 0) + 1)
			}

			for (const entry of state.added.get("commentsIds") ?? []) {
				if ((durableIds.get(entry.values[0] ?? "") ?? 0) > 1)
					fail("duplicateId", `commentsIds: durable id ${entry.values[0] ?? ""} appears twice`)
			}

			for (const entry of state.added.get("commentsExtensible") ?? []) {
				if (!durable.has(entry.key))
					fail("danglingReference", `commentsExtensible names durable id ${entry.key}, which commentsIds lacks`)
			}

			// Entries of paragraphs the save took out (a removed comment's) are gone too.
			for (const kind of ["commentsExtended", "commentsIds"] as const) {
				for (const entry of state.written.get(kind) ?? []) {
					if (input.ids(`paraId:${entry.key}`) === 0 && input.source(`paraId:${entry.key}`) > 0)
						fail("danglingReference", `${kind} keeps an entry for paragraph ${entry.key}, which the save removed`)
				}
			}

			// No reply is left answering a comment the save removed.
			for (const entry of state.written.get("commentsExtended") ?? []) {
				const parent = entry.values[0]

				if (parent !== undefined && input.ids(`paraId:${parent}`) === 0 && input.source(`paraId:${parent}`) > 0)
					fail("danglingReference", `commentsExtended: ${entry.key} replies to paragraph ${parent}, which the save removed`)
			}

			// A comment the save removed leaves no anchor behind.
			for (const comment of input.context.model.comments) {
				const id = comment.id

				if (input.source(`comment:${id}`) > 0 && input.ids(`comment:${id}`) === 0)
					if (input.ids(`commentReference:${id}`) > 0 || input.ids(`commentRangeStart:${id}`) > 0)
						fail("danglingReference", `Comment ${id} was removed but is still referred to`)
			}
		}
	}
]
