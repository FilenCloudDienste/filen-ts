import type { Mark, MarkType, Node } from "prosemirror-model"
import { escapeAttribute } from "../../xml/index"
import { NO_SOURCE, WRAPPER_MARKS, docxSchema } from "../edit/schema"
import { Item } from "../model/index"
import { closeTag, copyNode, openTag, startTagWith, type Out } from "./markup"
import { NEW_CONTROL_WRAPPER, closeSdtWrapper, openSdtWrapper } from "./sdt"
import { R_NAMESPACE, src } from "./source"
import type { StoryWriting } from "./story"
import { DocxWriteError } from "./values"

const marks = docxSchema.marks
const wrapperTypes = new Set(WRAPPER_MARKS.map(name => marks[name]))

// Source items that wrap runs in a paragraph.
export const WRAPPER_ITEMS = new Set<number>([
	Item.Hyperlink,
	Item.SmartTag,
	Item.CustomXml,
	Item.Sdt,
	Item.Insertion,
	Item.Deletion,
	Item.MoveFrom,
	Item.MoveTo,
	Item.Bidi
])

const REVISION_WRAPPERS: ReadonlySet<MarkType> = new Set([marks.insertion, marks.deletion, marks.move_from, marks.move_to])

// The prefix a hyperlink declares for the relationships namespace when the part binds none (a name no
// WordprocessingML part uses for anything else).
const LOCAL_R = "filenr"

// Writes the element a wrapper mark without a source stands for, around the content it marks.
export interface WrapperWriter {
	readonly type: MarkType
	open(w: StoryWriting, out: Out, mark: Mark): void
	close(w: StoryWriting, out: Out, mark: Mark): void
}

const LINK_EXTRAS: readonly (readonly [string, string])[] = [
	["targetFrame", "tgtFrame"],
	["history", "history"],
	["docLocation", "docLocation"]
]

// A new link: an external target is a relationship, a bookmark is w:anchor; a link may have both.
const LINK: WrapperWriter = {
	type: marks.link,
	open(w, out, mark) {
		const names = w.names
		const anchor = mark.attrs["anchor"] as string | null
		const tooltip = mark.attrs["tooltip"] as string | null
		let attributes = ""

		const target = (mark.attrs["target"] as string | null) ?? ""

		if (target !== "") {
			const id = escapeAttribute(w.env.hyperlink(w.part.name, target))

			// A part that never needed relationships may not bind their namespace: declare it here.
			attributes += names.r === "" ? ` xmlns:${LOCAL_R}="${R_NAMESPACE}" ${LOCAL_R}:id="${id}"` : ` ${names.relId()}="${id}"`
		}

		if (anchor !== null && anchor !== "") attributes += ` ${names.attr("anchor")}="${escapeAttribute(anchor)}"`

		if (tooltip !== null) attributes += ` ${names.attr("tooltip")}="${escapeAttribute(tooltip)}"`

		// What a link of the file a command replaced said besides its target (CT_Hyperlink, ECMA-376 Part 1
		// 17.16.22); absent on a new link.
		for (const [attr, local] of LINK_EXTRAS) {
			const value: unknown = mark.attrs[attr]

			if (typeof value === "string") attributes += ` ${names.attr(local)}="${escapeAttribute(value)}"`
		}

		out.text(`<${names.el("hyperlink")}${attributes}>`)
	},
	close(w, out) {
		out.text(`</${w.names.el("hyperlink")}>`)
	}
}

// A tracked change the editor recorded: w:ins, w:del, w:moveFrom or w:moveTo with a new id, its author and date.
function revisionWriter(type: MarkType, local: string): WrapperWriter {
	return {
		type,
		open(w, out, mark) {
			const author = mark.attrs["author"] as string | null
			const date = mark.attrs["date"] as string | null

			// Without its author it is no change Word can show: refused like any wrapper it cannot write.
			if (author === null || author === "") throw new DocxWriteError("missingSource", `A new ${mark.type.name} wrapper`)

			out.text(
				w.names
					.empty(local, [
						["id", String(w.env.nextRevisionId())],
						["author", author],
						["date", date]
					])
					.replace(/\/>$/, ">")
			)
		},
		close(w, out) {
			out.text(`</${w.names.el(local)}>`)
		}
	}
}

// Writers of new wrappers by mark type; a new wrapper of any other type is refused.
const NEW_WRAPPERS: ReadonlyMap<MarkType, WrapperWriter> = new Map(
	[
		LINK,
		revisionWriter(marks.insertion, "ins"),
		revisionWriter(marks.deletion, "del"),
		revisionWriter(marks.move_from, "moveFrom"),
		revisionWriter(marks.move_to, "moveTo"),
		NEW_CONTROL_WRAPPER
	].map(writer => [writer.type, writer])
)

export function isRevisionWrapper(mark: Mark): boolean {
	return REVISION_WRAPPERS.has(mark.type)
}

// The node's wrapper marks, outermost first: source wrappers by their item (an outer element comes
// first in document order), new ones innermost.
export function wrappersOf(node: Node): Mark[] {
	const wrappers = node.marks.filter(mark => wrapperTypes.has(mark.type)).sort((a, b) => wrapperRank(a) - wrapperRank(b))
	const link = wrappers.findIndex(mark => mark.type === marks.link && src(mark) === NO_SOURCE)
	const revision = wrappers.findIndex(mark => REVISION_WRAPPERS.has(mark.type))

	// A tracked change holds runs only (CT_RunTrackChange): a new link goes around it.
	if (link >= 0 && revision >= 0 && revision < link) wrappers.splice(revision, 0, ...wrappers.splice(link, 1))

	return wrappers
}

function wrapperRank(mark: Mark): number {
	const own = src(mark)

	return own === NO_SOURCE ? Number.MAX_SAFE_INTEGER : own
}

// The source wrappers around source run `run`, outermost first.
export function sourceWrappers(w: StoryWriting, run: number): number[] {
	const out: number[] = []
	const part = w.part

	for (let at = part.parent(run); at >= 0 && part.kinds[at] !== Item.Paragraph; at = part.parent(at)) {
		if (WRAPPER_ITEMS.has(part.kinds[at] ?? 0)) out.push(at)
	}

	return out.reverse()
}

// Closes the open wrappers `stack` holds down to what it shares with `wanted`, then opens the rest. `owned`:
// the source paragraph the paragraph being written owns; a source tracked change opened away from its own
// paragraph (a copy) gets a new id.
export function transition(w: StoryWriting, out: Out, stack: Mark[], wanted: readonly Mark[], owned: number): void {
	let common = 0

	while (common < stack.length && common < wanted.length && stack[common]?.eq(wanted[common] as Mark) === true) common++

	while (stack.length > common) {
		const mark = stack.pop()

		if (mark !== undefined) closeWrapper(w, out, mark)
	}

	for (let k = common; k < wanted.length; k++) {
		const mark = wanted[k] as Mark

		openWrapper(w, out, mark, owned)
		stack.push(mark)
	}
}

function openWrapper(w: StoryWriting, out: Out, mark: Mark, owned: number): void {
	const own = src(mark)

	if (own === NO_SOURCE) {
		const writer = NEW_WRAPPERS.get(mark.type)

		if (writer === undefined) throw new DocxWriteError("missingSource", `A new ${mark.type.name} wrapper`)

		writer.open(w, out, mark)

		return
	}

	const part = w.part
	const document = part.document
	const element = part.node(own)
	const again = w.openedWrappers.has(own)

	w.openedWrappers.add(own)

	switch (part.kinds[own]) {
		case Item.Sdt:
			openSdtWrapper(w, out, mark, own, again)

			return
		case Item.SmartTag:
		case Item.CustomXml: {
			openTag(out, document, element)

			const properties = part.aux[own] ?? -1

			if (properties >= 0) copyNode(out, document, properties)

			return
		}
		case Item.Insertion:
		case Item.Deletion:
		case Item.MoveFrom:
		case Item.MoveTo:
			if (again || paragraphOf(w, own) !== owned)
				startTagWith(out, document, element, w.names.attr("id"), String(w.env.nextRevisionId()))
			else openTag(out, document, element)

			return
		default:
			openTag(out, document, element)
	}
}

// The source paragraph a source item (a run, a wrapper) lies in, or NO_SOURCE.
export function paragraphOf(w: StoryWriting, item: number): number {
	const part = w.part

	for (let at = part.parent(item); at >= 0; at = part.parent(at)) if (part.kinds[at] === Item.Paragraph) return at

	return NO_SOURCE
}

function closeWrapper(w: StoryWriting, out: Out, mark: Mark): void {
	const own = src(mark)

	if (own === NO_SOURCE) {
		// Only a type openWrapper wrote can be open.
		NEW_WRAPPERS.get(mark.type)?.close(w, out, mark)

		return
	}

	const part = w.part

	if (part.kinds[own] === Item.Sdt) {
		closeSdtWrapper(w, out, own)

		return
	}

	closeTag(out, part.document, part.node(own))
}
