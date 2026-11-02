import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, OpcPackage } from "../core/opc/index"
import {
	countLegacyComments,
	countModernComments,
	MODERN_COMMENTS_TYPE,
	readLegacyComments,
	readModernComments
} from "../core/pptx/read/comments"
import { commentCharacters } from "../core/presentation/comments"
import { PresentationError } from "../core/presentation/model"
import { encodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"
import { CORPUS_DIR } from "./corpusDir"

// The comment parts counted without entries against the readers: the same comments and characters, or the same
// refusal, on hand-made parts and on every comments part of the corpus.

const LEGACY_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.comments+xml"
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const P188 =
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"'

function outcome(run: () => { comments: number; characters: number }): string {
	try {
		const { comments, characters } = run()

		return `${String(comments)} / ${String(characters)}`
	} catch (error) {
		if (error instanceof PresentationError) return error.reason

		throw error
	}
}

function compare(document: XmlDocument, modern: boolean, before = 0, room?: number): void {
	const read = outcome(() => {
		const comments = (modern ? readModernComments : readLegacyComments)(document, before, room)

		return { comments: comments.entries.length, characters: commentCharacters(comments) }
	})

	expect(outcome(() => (modern ? countModernComments : countLegacyComments)(document, before, room))).toBe(read)
}

const modern = (body: string, replies = "") =>
	`<p188:cm id="{1}" authorId="{A}"><p188:replyLst>${replies}</p188:replyLst><p188:txBody><a:bodyPr/>${body}</p188:txBody></p188:cm>`

describe("counting a comments part", () => {
	it("counts legacy comments as they read, line ends and references included", () => {
		compare(
			parseXml(
				encodeUtf8(
					`<p:cmLst ${P}><p:cm authorId="0" idx="1"><p:text>a&#13;&#10;b&#13;c</p:text></p:cm><p:cm authorId="0" idx="2"><p:text>é😀</p:text></p:cm></p:cmLst>`
				)
			),
			false
		)
	})

	it("counts modern comments and replies as they read", () => {
		const reply =
			'<p188:reply id="{2}" authorId="{A}"><p188:txBody><a:bodyPr/><a:p><a:r><a:t>re</a:t></a:r><a:br/><a:fld id="{F}" type="x"><a:t>7</a:t></a:fld></a:p><a:p/></p188:txBody></p188:reply>'

		compare(
			parseXml(
				encodeUtf8(
					`<p188:cmLst ${P188}>${modern("<a:p><a:r><a:t>one</a:t></a:r></a:p><a:p><a:r><a:t>two</a:t></a:r></a:p>", reply)}</p188:cmLst>`
				)
			),
			true
		)
	})

	it("refuses as the readers refuse: past the room, past the slide's comments", () => {
		const document = parseXml(encodeUtf8(`<p:cmLst ${P}><p:cm authorId="0" idx="1"><p:text>123456</p:text></p:cm></p:cmLst>`))

		compare(document, false, 0, 5)
		compare(document, false, 100_000)
		compare(parseXml(encodeUtf8(`<p188:cmLst ${P188}>${modern("<a:p><a:r><a:t>123456</a:t></a:r></a:p>")}</p188:cmLst>`)), true, 0, 5)
	})

	it.skipIf(!existsSync(join(CORPUS_DIR, "pptx")))("counts every corpus comments part as it reads", { timeout: 300_000 }, async () => {
		const directory = join(CORPUS_DIR, "pptx")
		let parts = 0

		for (const file of readdirSync(directory).filter(name => name.toLowerCase().endsWith(".pptx"))) {
			let opc: OpcPackage

			try {
				opc = await OpcPackage.open(bytesSource(new Uint8Array(readFileSync(join(directory, file)))))
			} catch {
				continue
			}

			const types = await opc.contentTypes()

			for (const entry of opc.entries()) {
				const type = types.typeOf(entry.name)

				if (type !== LEGACY_TYPE && type !== MODERN_COMMENTS_TYPE) continue

				parts++

				const document = await opc.xml(entry.name)

				expect([
					file,
					entry.name,
					outcome(() => (type === MODERN_COMMENTS_TYPE ? countModernComments : countLegacyComments)(document))
				]).toEqual([
					file,
					entry.name,
					outcome(() => {
						const comments = (type === MODERN_COMMENTS_TYPE ? readModernComments : readLegacyComments)(document)

						return { comments: comments.entries.length, characters: commentCharacters(comments) }
					})
				])
			}
		}

		expect(parts).toBeGreaterThan(0)
	})
})
