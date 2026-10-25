import { readFileSync } from "node:fs"
import { crc32, inflateRawSync } from "node:zlib"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { LAZY_VIEWER_TIMEOUT_MS, LIVE_WRITE_TIMEOUT_MS, uploadFiles, withScratchDirectory } from "./helpers/listing"
import { preview } from "@/locales/en/preview"

// OpenDocument text documents in the docx editor, in a real browser against the backend: translated in the docx
// worker, edited as the package they read as, saved as ODT by the source-preserving writer (the file stays ODT with its
// mimetype first and stored, untouched paragraphs keep their bytes), reopened with the edit; a second save alike, a
// template stays a template, and a document opened and closed without an edit is stored as it was.

test.describe.configure({ mode: "default" })

const ODT_MIME = "application/vnd.oasis.opendocument.text"
const OTT_MIME = "application/vnd.oasis.opendocument.text-template"
const MARKER = "Second paragraph of the ODT fixture"
const UNTOUCHED =
	'<text:p text:style-name="P1">First paragraph with <text:span text:style-name="T1">bold</text:span> text and a café.</text:p>'
const TABLE =
	'<table:table table:name="Table1"><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell office:value-type="string"><text:p>Cell A1</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Cell B1</text:p></table:table-cell></table:table-row></table:table>'
const NS =
	'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"'

// A zip of stored entries, in order (ODF 1.3 Part 2 §3: "mimetype" first, stored, no extra field).
function zip(entries: readonly { name: string; data: Buffer }[]): Buffer {
	const local: Buffer[] = []
	const central: Buffer[] = []
	let offset = 0

	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8")
		const header = Buffer.alloc(30)
		const crc = crc32(entry.data)

		header.writeUInt32LE(0x04034b50, 0)
		header.writeUInt16LE(20, 4)
		header.writeUInt32LE(crc, 14)
		header.writeUInt32LE(entry.data.length, 18)
		header.writeUInt32LE(entry.data.length, 22)
		header.writeUInt16LE(name.length, 26)
		local.push(header, name, entry.data)

		const record = Buffer.alloc(46)

		record.writeUInt32LE(0x02014b50, 0)
		record.writeUInt16LE(20, 4)
		record.writeUInt16LE(20, 6)
		record.writeUInt32LE(crc, 16)
		record.writeUInt32LE(entry.data.length, 20)
		record.writeUInt32LE(entry.data.length, 24)
		record.writeUInt16LE(name.length, 28)
		record.writeUInt32LE(offset, 42)
		central.push(record, name)
		offset += header.length + name.length + entry.data.length
	}

	const directory = Buffer.concat(central)
	const end = Buffer.alloc(22)

	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(entries.length, 8)
	end.writeUInt16LE(entries.length, 10)
	end.writeUInt32LE(directory.length, 12)
	end.writeUInt32LE(offset, 16)

	return Buffer.concat([...local, directory, end])
}

// A small ODF 1.3 text document (or template): a heading, two paragraphs (one with a bold span and a non-ASCII
// word), a table, a last paragraph.
function odtFixture(mime: string): Buffer {
	const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.3"><office:automatic-styles><style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="justify"/></style:style><style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles><office:body><office:text><text:h text:style-name="Heading_20_1" text:outline-level="1">ODT fixture heading</text:h>${UNTOUCHED}<text:p>${MARKER}</text:p>${TABLE}<text:p>Last paragraph.</text:p></office:text></office:body></office:document-content>`
	const styles = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3"><office:styles><style:style style:name="Standard" style:family="paragraph"/><style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Standard" style:default-outline-level="1"><style:text-properties fo:font-size="16pt" fo:font-weight="bold"/></style:style></office:styles></office:document-styles>`
	const manifest = `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`

	return zip([
		{ name: "mimetype", data: Buffer.from(mime, "ascii") },
		{ name: "content.xml", data: Buffer.from(content, "utf8") },
		{ name: "styles.xml", data: Buffer.from(styles, "utf8") },
		{ name: "META-INF/manifest.xml", data: Buffer.from(manifest, "utf8") }
	])
}

// An entry of a stored zip, by name: its bytes inflated where they are deflated, and where it sits.
function entry(file: Buffer, name: string): { data: Buffer; index: number; method: number } | undefined {
	let at = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
	const count = file.readUInt16LE(at + 10)
	const sorted: { name: string; offset: number; method: number; size: number }[] = []

	at = file.readUInt32LE(at + 16)

	for (let k = 0; k < count; k++) {
		const nameLength = file.readUInt16LE(at + 28)
		const extra = file.readUInt16LE(at + 30)
		const comment = file.readUInt16LE(at + 32)

		sorted.push({
			name: file.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
			offset: file.readUInt32LE(at + 42),
			method: file.readUInt16LE(at + 10),
			size: file.readUInt32LE(at + 20)
		})
		at += 46 + nameLength + extra + comment
	}

	sorted.sort((a, b) => a.offset - b.offset)

	const index = sorted.findIndex(item => item.name === name)
	const found = sorted[index]

	if (found === undefined) return undefined

	const start = found.offset + 30 + file.readUInt16LE(found.offset + 26) + file.readUInt16LE(found.offset + 28)
	const raw = file.subarray(start, start + found.size)

	return { data: found.method === 0 ? raw : inflateRawSync(raw), index, method: found.method }
}

function pageText(page: Page, text: string): Locator {
	return page.locator(".fo-docx-page").getByText(text, { exact: false }).first()
}

async function openDocument(page: Page, listbox: Locator, name: string, marker: string): Promise<void> {
	await listbox.getByRole("option", { name }).dblclick()
	await expect(pageText(page, marker)).toBeVisible({ timeout: LAZY_VIEWER_TIMEOUT_MS })
	await expect(page.getByRole("button", { name: preview.previewDocxBold, exact: true })).toBeEnabled({ timeout: LAZY_VIEWER_TIMEOUT_MS })
}

async function closeDocument(page: Page): Promise<void> {
	await page.keyboard.press("Escape")
	await expect(page.getByRole("toolbar", { name: preview.previewOfficeRibbonCommands })).toHaveCount(0)
}

async function save(page: Page): Promise<void> {
	const button = page.getByRole("dialog").getByRole("button", { name: preview.previewSaveAction, exact: true })

	await button.click()
	await expect(button).toHaveCount(0, { timeout: LIVE_WRITE_TIMEOUT_MS })
}

// The file as stored, downloaded from its row's menu.
async function storedBytes(page: Page, listbox: Locator, name: string): Promise<Buffer> {
	await listbox.getByRole("option", { name }).click({ button: "right" })

	const downloading = page.waitForEvent("download", { timeout: LIVE_WRITE_TIMEOUT_MS })

	await page.getByRole("menuitem", { name: /^Download$/u }).click()

	return readFileSync(await (await downloading).path())
}

for (const kind of [
	{ extension: "odt", mime: ODT_MIME },
	{ extension: "ott", mime: OTT_MIME }
] as const) {
	test(`an OpenDocument ${kind.extension === "ott" ? "template" : "document"}: edited in the docx editor, saved as ODT, reopened with the edit, other paragraphs byte for byte`, async ({
		page
	}) => {
		test.slow()

		await withScratchDirectory(page, `odt-edit-${kind.extension}`, async ({ listbox, runId }) => {
			const name = `e2e-${runId}-fixture.${kind.extension}`

			await uploadFiles(page, [{ name, mimeType: kind.mime, buffer: odtFixture(kind.mime) }], listbox)
			await openDocument(page, listbox, name, MARKER)

			await pageText(page, MARKER).click()
			await page.keyboard.press("Home")
			await page.keyboard.type("Edited in Filen: ")
			await save(page)
			await closeDocument(page)

			const stored = await storedBytes(page, listbox, name)
			const mimetype = entry(stored, "mimetype")
			const content = entry(stored, "content.xml")?.data.toString("utf8") ?? ""

			// Still the same kind of OpenDocument file, mimetype first and stored; the edit in it; the paragraph and
			// the table the edit did not touch exactly as they were.
			expect(mimetype?.index).toBe(0)
			expect(mimetype?.method).toBe(0)
			expect(mimetype?.data.toString("ascii")).toBe(kind.mime)
			expect(content).toContain(`Edited in Filen: ${MARKER}`)
			expect(content).toContain(UNTOUCHED)
			expect(content).toContain(TABLE)

			await openDocument(page, listbox, name, "Edited in Filen")
			await pageText(page, "Last paragraph.").click()
			await page.keyboard.press("End")
			await page.keyboard.type(" Second save.")
			await save(page)
			await closeDocument(page)
			await openDocument(page, listbox, name, "Second save.")
			await expect(pageText(page, "Edited in Filen")).toBeVisible()
			await closeDocument(page)
		})
	})
}

test("an OpenDocument document opened and closed without an edit is stored as it was", async ({ page }) => {
	await withScratchDirectory(page, "odt-edit-untouched", async ({ listbox, runId }) => {
		const name = `e2e-${runId}-untouched.odt`
		const fixture = odtFixture(ODT_MIME)

		await uploadFiles(page, [{ name, mimeType: ODT_MIME, buffer: fixture }], listbox)
		await openDocument(page, listbox, name, MARKER)
		await closeDocument(page)

		expect((await storedBytes(page, listbox, name)).equals(fixture)).toBe(true)
	})
})
