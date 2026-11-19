import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { DocxEngine, type DocxEngineServices, type DocxEvent, type DocxPageData } from "@filen/office/dom/docx"
import { openOdtAsDocx } from "../core/odt/index"
import { odtBytes } from "./odtFixtures"
import { buildZip, text } from "./zipBuilder"
import { engineServices } from "./engineFixtures"

function services(): DocxEngineServices {
	return engineServices({
		yield: () => Promise.resolve(),
		sliceMs: Infinity,
		openOdt: openOdtAsDocx
	})
}

async function run(bytes: Uint8Array, withOdt = true): Promise<{ events: DocxEvent[]; pages: DocxPageData[] }> {
	const events: DocxEvent[] = []
	const pages: DocxPageData[] = []
	const { openOdt, ...rest } = services()
	const engine = new DocxEngine(
		bytesSource(bytes),
		withOdt && openOdt !== undefined ? { ...rest, openOdt } : rest,
		event => {
			events.push(event)

			if (event.type === "pages") for (const page of event.pages) pages[page.index] = page
		},
		{ format: "odt" }
	)

	await engine.run()

	return { events, pages }
}

describe("the document engine opening ODT", () => {
	it("lays out an ODF text document", async () => {
		const { events, pages } = await run(
			odtBytes({
				body: '<text:p>One</text:p><text:p text:style-name="Break">Two</text:p>',
				automatic:
					'<style:style style:name="Break" style:family="paragraph"><style:paragraph-properties fo:break-before="page"/></style:style>'
			})
		)

		expect(events[0]?.type).toBe("opened")
		expect(pages.length).toBe(2)
	})

	it("refuses an encrypted package with a typed reason", async () => {
		const manifest =
			'<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml" manifest:size="1000"><manifest:encryption-data manifest:checksum-type="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#sha256-1k" manifest:checksum="AAAA"><manifest:algorithm manifest:algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" manifest:initialisation-vector="AAAA"/><manifest:key-derivation manifest:key-derivation-name="PBKDF2" manifest:key-size="32" manifest:iteration-count="100000" manifest:salt="AAAA"/></manifest:encryption-data></manifest:file-entry></manifest:manifest>'
		const bytes = buildZip([
			{ name: "mimetype", data: text("application/vnd.oasis.opendocument.text"), method: 0 },
			{ name: "content.xml", data: new Uint8Array(1000).fill(7) },
			{ name: "META-INF/manifest.xml", data: text(manifest) }
		])
		const { events } = await run(bytes)
		const error = events.find(event => event.type === "error")

		expect(error?.type === "error" ? error.reason : undefined).toBe("unsupportedEncryption")
	})

	it("opens no ODT on a host without the translator (the in-thread editor)", async () => {
		const { events } = await run(odtBytes({ body: "<text:p>x</text:p>" }), false)
		const error = events.find(event => event.type === "error")

		expect(error?.type === "error" ? error.reason : undefined).toBe("failed")
	})

	it("refuses a spreadsheet opened as a text document", async () => {
		const bytes = buildZip([
			{ name: "mimetype", data: text("application/vnd.oasis.opendocument.spreadsheet"), method: 0 },
			{ name: "content.xml", data: text("<x/>") }
		])
		const { events } = await run(bytes)
		const error = events.find(event => event.type === "error")

		expect(error?.type === "error" ? error.reason : undefined).toBe("notWordprocessing")
	})
})
