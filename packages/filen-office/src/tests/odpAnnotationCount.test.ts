import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { countPageAnnotations } from "../core/odp/read/annotationCount"
import { readAnnotations } from "../core/odp/read/annotations"
import { Fragment } from "../core/odp/read/context"
import { pageFragment, type ContentPages, type PageSpan } from "../core/odp/read/scan"
import { commentCharacters, MAX_SLIDE_COMMENT_CHARACTERS } from "../core/presentation/comments"
import { PresentationError } from "../core/presentation/model"
import { Namespaces } from "../core/xml/index"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes, page } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"

// The counting scan of a page's comment characters against the reader: the same count, or the same refusal, on
// every page; and the scan takes the pages it is given (it leaves to the reader only what it cannot follow).

type Outcome = number | string

function outcome(run: () => number | undefined): Outcome | undefined {
	try {
		return run()
	} catch (error) {
		if (error instanceof PresentationError) return error.reason

		throw error
	}
}

function readerOutcome(content: ContentPages, span: PageSpan, room: number): Outcome {
	return outcome(() => {
		const document = pageFragment(content, span)
		const fragment = new Fragment(document, new Namespaces(document, { lenient: true }), "content.xml", span.start, "content", 0)

		return commentCharacters(readAnnotations(fragment, document.firstChildElement(document.documentElement()), room))
	}) as Outcome
}

async function pagesOf(bytes: Uint8Array) {
	const s = await driveSession(bytes, "odp")
	const parts = odpParts(s.session.deck)

	if (parts === undefined) throw new Error("no parts")

	return { content: parts.content, spans: s.session.deck.slides.map(ref => parts.span(ref) as PageSpan) }
}

const annotation = (paragraphs: string) =>
	`<officeooo:annotation xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>A</dc:creator>${paragraphs}</officeooo:annotation>`
const plain = (paragraphs: string) =>
	`<office:annotation><dc:creator>A&amp;B</dc:creator><dc:date>2026</dc:date>${paragraphs}</office:annotation>`

const CASES: readonly (readonly [string, string, number])[] = [
	["no comments", "", MAX_SLIDE_COMMENT_CHARACTERS],
	["plain lines", plain("<text:p>One</text:p><text:p/><text:p>Three</text:p>"), MAX_SLIDE_COMMENT_CHARACTERS],
	[
		"references, CDATA, line ends, supplementary characters",
		plain("<text:p>a&amp;b&#x1F600;&#233;\r\nc<![CDATA[x\r\ny]]>é😀</text:p>"),
		MAX_SLIDE_COMMENT_CHARACTERS
	],
	[
		"spaces, tabs, breaks, spans, links, comments and instructions",
		plain(
			'<text:p>a<text:s/><text:s text:c="5"/><text:s text:c="99999"/><text:tab/><text:line-break/><text:span>b<text:a>c</text:a></text:span><!-- no --><?pi no?>d</text:p>'
		),
		MAX_SLIDE_COMMENT_CHARACTERS
	],
	[
		"a list",
		plain("<text:p>x</text:p><text:list><text:list-item><text:p>l<text:s/>m</text:p></text:list-item></text:list>"),
		MAX_SLIDE_COMMENT_CHARACTERS
	],
	["several annotations", plain("<text:p>1</text:p>") + plain("<text:p>22</text:p>") + plain(""), MAX_SLIDE_COMMENT_CHARACTERS],
	["an annotation not a child of the page", `<draw:g>${plain("<text:p>hidden</text:p>")}</draw:g>`, MAX_SLIDE_COMMENT_CHARACTERS],
	["past the room", plain("<text:p>123456</text:p>"), 5],
	["past a comment's characters", plain(`<text:p>${'<text:s text:c="1000"/>'.repeat(1001)}</text:p>`), MAX_SLIDE_COMMENT_CHARACTERS],
	[
		"spans past the depth",
		plain(`<text:p>${"<text:span>".repeat(70)}x${"</text:span>".repeat(70)}</text:p>`),
		MAX_SLIDE_COMMENT_CHARACTERS
	],
	["a declaration of its own", annotation("<text:p>declared</text:p>"), MAX_SLIDE_COMMENT_CHARACTERS]
]

describe("counting a page's comment characters", () => {
	for (const [name, body, room] of CASES) {
		it(`counts as the reader reads: ${name}`, async () => {
			const { content, spans } = await pagesOf(odpBytes({ body: page(body) }))
			const span = spans[0] as PageSpan
			const counted = outcome(() => countPageAnnotations(content, span, room))
			const read = readerOutcome(content, span, room)

			if (name === "a declaration of its own") expect(counted).toBeUndefined()
			else expect(counted).toBe(read)
		})
	}

	it.skipIf(!existsSync(join(CORPUS_DIR, "odp")))("counts every corpus page as the reader reads it", { timeout: 300_000 }, async () => {
		const directory = join(CORPUS_DIR, "odp")
		let pages = 0
		let scanned = 0

		for (const file of readdirSync(directory).filter(name => name.toLowerCase().endsWith(".odp"))) {
			let opened: Awaited<ReturnType<typeof pagesOf>>

			try {
				opened = await pagesOf(new Uint8Array(readFileSync(join(directory, file))))
			} catch {
				continue
			}

			for (const span of opened.spans) {
				const counted = outcome(() => countPageAnnotations(opened.content, span, MAX_SLIDE_COMMENT_CHARACTERS))

				pages++

				if (counted === undefined) continue

				scanned++
				expect([file, counted]).toEqual([file, readerOutcome(opened.content, span, MAX_SLIDE_COMMENT_CHARACTERS)])
			}
		}

		expect(pages).toBeGreaterThan(0)
		expect(scanned / pages).toBeGreaterThan(0.9)
	})
})
