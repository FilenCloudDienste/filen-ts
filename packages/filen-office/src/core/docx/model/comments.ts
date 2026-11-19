import type { XmlDocument } from "../../xml/index"
import { Item, RevisionView } from "./kinds"
import { Ns } from "./namespaces"
import type { StoryPart } from "./part"
import { partReader, type PartReader } from "./reader"

export interface CommentInfo {
	readonly id: string
	readonly story: number
	readonly author: string | undefined
	readonly initials: string | undefined
	readonly date: string | undefined
	// w14:paraId of the comment's last paragraph, which commentsExtended and commentsIds key on.
	readonly paraId: string | undefined
	// The comment this one replies to (commentsExtended paraIdParent), by w:id.
	readonly parentId: string | undefined
	readonly done: boolean
	readonly durableId: string | undefined
	readonly dateUtc: string | undefined
	// Row in the model's comment anchors, or -1 when nothing in the document refers to it.
	readonly anchor: number
}

export interface Person {
	readonly author: string | undefined
	readonly providerId: string | undefined
	readonly userId: string | undefined
}

export interface CommentExtension {
	readonly parentParaId: string | undefined
	readonly done: boolean
}

// What the read-only viewer's annotations (dom/docx/annotate.ts) and the editor's live ones
// (paged/annotations.ts) show of a comment or tracked change, one definition for both: a change's text preview,
// a comment's text read, the boxes kept per comment or change, and a sane date.
export const MAX_PREVIEW = 160
export const MAX_COMMENT_CHARS = 20_000
export const MAX_RECTS = 512

// `text` on one line, shortened to MAX_PREVIEW characters.
export function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim()

	return flat.length > MAX_PREVIEW ? `${flat.slice(0, MAX_PREVIEW - 1)}…` : flat
}

// A recorded date when it parses as one, else "".
export function dateOf(value: string | undefined): string {
	return value !== undefined && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : ""
}

function children(
	document: XmlDocument,
	rootGroup: Ns,
	rootName: string,
	childName: string,
	visit: (reader: PartReader, node: number) => void
): void {
	const reader = partReader(document)
	const root = document.documentElement()

	if (!reader.is(root, rootGroup, rootName)) return

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (reader.is(child, rootGroup, childName)) visit(reader, child)
	}
}

// word/commentsExtended.xml: reply threading and resolved state, keyed by paraId.
export function readCommentsExtended(document: XmlDocument): Map<string, CommentExtension> {
	const out = new Map<string, CommentExtension>()

	children(document, Ns.W15, "commentsEx", "commentEx", (reader, node) => {
		const paraId = reader.attr(node, Ns.W15, "paraId")

		if (paraId !== undefined) {
			out.set(paraId.toUpperCase(), {
				parentParaId: reader.attr(node, Ns.W15, "paraIdParent")?.toUpperCase(),
				done: reader.flag(node, Ns.W15, "done")
			})
		}
	})

	return out
}

// word/commentsIds.xml: paraId -> durableId.
export function readCommentsIds(document: XmlDocument): Map<string, string> {
	const out = new Map<string, string>()

	children(document, Ns.W16Cid, "commentsIds", "commentId", (reader, node) => {
		const paraId = reader.attr(node, Ns.W16Cid, "paraId")
		const durableId = reader.attr(node, Ns.W16Cid, "durableId")

		if (paraId !== undefined && durableId !== undefined) out.set(paraId.toUpperCase(), durableId.toUpperCase())
	})

	return out
}

// word/commentsExtensible.xml: durableId -> UTC date.
export function readCommentsExtensible(document: XmlDocument): Map<string, string> {
	const out = new Map<string, string>()

	children(document, Ns.W16Cex, "commentsExtensible", "commentExtensible", (reader, node) => {
		const durableId = reader.attr(node, Ns.W16Cex, "durableId")
		const date = reader.attr(node, Ns.W16Cex, "dateUtc")

		if (durableId !== undefined && date !== undefined) out.set(durableId.toUpperCase(), date)
	})

	return out
}

// word/people.xml.
export function readPeople(document: XmlDocument): Person[] {
	const out: Person[] = []

	children(document, Ns.W15, "people", "person", (reader, node) => {
		const presence = reader.child(node, Ns.W15, "presenceInfo")

		out.push({
			author: reader.attr(node, Ns.W15, "author"),
			providerId: presence < 0 ? undefined : reader.attr(presence, Ns.W15, "providerId"),
			userId: presence < 0 ? undefined : reader.attr(presence, Ns.W15, "userId")
		})
	})

	return out
}

// Namespaces, relationship and content types of the comments part family.
export const COMMENT_NAMESPACES = {
	w14: "http://schemas.microsoft.com/office/word/2010/wordml",
	w15: "http://schemas.microsoft.com/office/word/2012/wordml",
	w16cid: "http://schemas.microsoft.com/office/word/2016/wordml/cid",
	w16cex: "http://schemas.microsoft.com/office/word/2018/wordml/cex"
} as const

const WML = "application/vnd.openxmlformats-officedocument.wordprocessingml"

// The parts beyond comments.xml: their kind (DocxPackage.part), root, child, namespace prefix and URI, content
// type and the main part's relationship type.
export const COMMENT_PARTS = {
	commentsExtended: {
		root: "commentsEx",
		child: "commentEx",
		prefix: "w15",
		uri: COMMENT_NAMESPACES.w15,
		contentType: `${WML}.commentsExtended+xml`,
		relationship: "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
		name: "word/commentsExtended.xml"
	},
	commentsIds: {
		root: "commentsIds",
		child: "commentId",
		prefix: "w16cid",
		uri: COMMENT_NAMESPACES.w16cid,
		contentType: `${WML}.commentsIds+xml`,
		relationship: "http://schemas.microsoft.com/office/2016/09/relationships/commentsIds",
		name: "word/commentsIds.xml"
	},
	commentsExtensible: {
		root: "commentsExtensible",
		child: "commentExtensible",
		prefix: "w16cex",
		uri: COMMENT_NAMESPACES.w16cex,
		contentType: `${WML}.commentsExtensible+xml`,
		relationship: "http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible",
		name: "word/commentsExtensible.xml"
	},
	people: {
		root: "people",
		child: "person",
		prefix: "w15",
		uri: COMMENT_NAMESPACES.w15,
		contentType: `${WML}.people+xml`,
		relationship: "http://schemas.microsoft.com/office/2011/relationships/people",
		name: "word/people.xml"
	}
} as const

export type CommentPartKind = keyof typeof COMMENT_PARTS

// Items a comment's text may hold for it to be edited as plain text (paragraphs of runs, text, tabs and
// breaks, the annotation mark, wrappers around runs).
const PLAIN_ITEMS = new Set<number>([
	Item.Paragraph,
	Item.Run,
	Item.Text,
	Item.DeletedText,
	Item.Tab,
	Item.PositionalTab,
	Item.Break,
	Item.CarriageReturn,
	Item.LastRenderedPageBreak,
	Item.AnnotationMark,
	Item.SoftHyphen,
	Item.NoBreakHyphen,
	Item.Symbol,
	Item.Hyperlink,
	Item.Insertion,
	Item.Deletion,
	Item.SmartTag,
	Item.Bidi
])

// Whether the comment at item `root` of `part` is plain paragraphs (see PLAIN_ITEMS): its text can be
// edited as plain text without losing anything but formatting.
export function plainComment(part: StoryPart, root: number): boolean {
	const end = part.end(root)

	for (let item = root + 1; item < end; item = part.end(item)) if (part.kinds[item] !== Item.Paragraph) return false
	for (let item = root + 1; item < end; item++) if (!PLAIN_ITEMS.has(part.kinds[item] ?? 0)) return false

	return true
}

// A comment's text as it shows (deletions left out), one string per paragraph of the comment, its line breaks
// U+2028.
export function commentParagraphTexts(part: StoryPart, root: number): string[] {
	const out: string[] = []
	const end = part.end(root)

	for (let paragraph = root + 1; paragraph < end; paragraph = part.end(paragraph)) {
		if (part.kinds[paragraph] !== Item.Paragraph) continue

		const paragraphEnd = part.end(paragraph)
		let text = ""

		for (let item = paragraph + 1; item < paragraphEnd; item++) {
			if (part.hidden(item, RevisionView.Final)) {
				item = part.end(item) - 1

				continue
			}

			switch (part.kinds[item]) {
				case Item.Text:
					text += part.text(item)
					break
				case Item.Tab:
				case Item.PositionalTab:
					text += "\t"
					break
				case Item.Break:
				case Item.CarriageReturn:
					text += "\u2028"
					break
				case Item.NoBreakHyphen:
					text += "\u2011"
					break
				case Item.Symbol: {
					const char = part.symbolChar(item)

					if (char > 0 && char <= 0x10ffff) text += String.fromCodePoint(char)

					break
				}
				case Item.Paragraph:
				case Item.Textbox:
					item = part.end(item) - 1
					break
			}
		}

		out.push(text)
	}

	return out
}

// Whether the part's root declares `uri` (a new w14:paraId needs w14 there).
export function declaresNamespace(document: XmlDocument, uri: string): boolean {
	return partReader(document).namespaces.prefixFor(document.documentElement(), uri) !== undefined
}
