import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "../core/opc/index"
import { readRtf } from "../core/rtf/index"
import { probedRouteCount } from "../core/rtf/reader"
import { XmlStore } from "../core/rtf/story"
import { docxRtfServer } from "../dom/docx/rtfWorker"
import { latin1 } from "./rtfWriteFixtures"

// Reading a long RTF document holds its markup as UTF-8 (deflated past a budget) and returns a deflated package
// with the same WordprocessingML.

const H = "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Times;}{\\f1 Arial;}}"

// About 700 bytes of markup per paragraph: past the reader's raw budget at this length.
function longBody(count: number): string {
	return Array.from(
		{ length: count },
		(_, k) =>
			`\\pard\\plain\\f${k % 2}\\fs${20 + (k % 5) * 2} Paragraph ${k} with {\\b bold} and {\\i italic \\u1046?} text here.\\par\n`
	).join("")
}

async function read(rtf: string): Promise<Uint8Array> {
	const result = await readRtf(latin1(rtf))

	if (!result.ok) throw new Error(result.reason)

	return result.docx
}

describe("RTF reader memory", () => {
	it("returns a long document's package with its large parts deflated", async () => {
		const docx = await read(`${H}${longBody(20000)}}`)
		const archive = await ZipArchive.open(bytesSource(docx))
		const document = archive.entries.find(entry => entry.name === "word/document.xml")
		const parts = Object.values(unzipSync(docx)).reduce((sum, bytes) => sum + bytes.length, 0)

		expect(document?.method).toBe(8)
		expect(docx.length).toBeLessThan(parts / 10)
	})

	it("reads paragraphs, tables, notes and comments held past the raw budget back whole", async () => {
		const tail =
			"\\pard\\intbl first\\cell second\\cell\\row\\pard tail{\\super\\chftn}{\\footnote \\pard\\chftn  note}" +
			"{\\*\\atrfstart 1}c{\\*\\atrfend 1}{\\*\\atnauthor A}\\chatn{\\*\\annotation{\\*\\atnref 1}remark}\\par"
		const docx = await read(`${H}{\\*\\revtbl{Unknown;}{A;}}${longBody(20000)}\\trowd\\cellx2000\\cellx4000${tail}}`)
		const xml = strFromU8(unzipSync(docx)["word/document.xml"] ?? new Uint8Array())

		expect(xml.match(/<w:p>/gu)?.length).toBe(20003)
		expect(xml).toContain("Paragraph 0 with </w:t>")
		expect(xml).toContain("Paragraph 19999 with </w:t>")
		expect(xml).toContain("<w:tbl>")
		expect(xml).toContain(">second</w:t>")
		expect(xml).toContain('<w:footnoteReference w:id="1"/>')
		expect(xml).toContain('<w:commentRangeStart w:id="0"/>')
		expect(xml).toContain('<w:commentRangeEnd w:id="0"/>')
		expect(xml).not.toContain("\u0000")
	})

	it("keeps no more than its budget of markup raw, every piece reading back as put", () => {
		const budget = { raw: 0 }
		const store = new XmlStore(budget)
		const pieces: { at: number; size: number; xml: string }[] = []

		for (let k = 0; k < 40000; k++) {
			const xml = `<w:p><w:r><w:t>Paragraph ${k} Ж ${"x".repeat(k % 500)}</w:t></w:r></w:p>`
			const at = store.put(xml)

			pieces.push({ at, size: store.size, xml })
		}

		expect(budget.raw).toBeLessThanOrEqual(8 * 1024 * 1024)

		const decoder = new TextDecoder()

		for (const piece of [pieces[0], pieces[12345], pieces[39999]]) {
			if (piece === undefined) throw new Error("no piece")

			const views = [...store.read(piece.at, piece.size)]

			expect(views).toHaveLength(1)
			expect(decoder.decode(views[0])).toBe(piece.xml)
		}
	})

	it("hands the editor a copy of the held package", async () => {
		const server = docxRtfServer()
		const opened = await server.open(1, latin1(`${H}${longBody(200)}}`))

		expect(opened.ok).toBe(true)

		const held = server.package(1)
		const taken = server.take(1)

		expect(taken).toEqual(held)
		expect(taken.buffer).not.toBe(held?.buffer)
	})

	it("holds a bounded number of routes for many distinct unknown words, over-long ones among them", async () => {
		const letters = (k: number): string => {
			let name = ""

			for (let n = k; n > 0 || name === ""; n = Math.floor(n / 26)) name += String.fromCharCode(0x61 + (n % 26))

			return name
		}
		const words = Array.from({ length: 6_000 }, (_, k) => `\\zq${letters(k)} ${k % 10}`).join("")
		const long = Array.from({ length: 100 }, (_, k) => `\\${"x".repeat(40)}${letters(k)} y`).join("")
		const docx = await read(`${H}\\pard ${words}${long}\\par}`)
		const xml = strFromU8(unzipSync(docx)["word/document.xml"] ?? new Uint8Array())
		const text = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/gu)].map(match => match[1]).join("")

		expect(probedRouteCount()).toBeLessThanOrEqual(4096)
		expect(text).toBe(`${Array.from({ length: 6_000 }, (_, k) => `${k % 10}`).join("")}${"y".repeat(100)}`)
	})
})
