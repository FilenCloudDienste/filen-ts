import { describe, expect, it } from "vitest"
import { openDocxEditContext } from "@filen/office/core/docx/edit"
import { bytesSource } from "@filen/office/core/opc"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import { DocxEngine, type DocxEngineServices, type DocxEvent } from "@filen/office/dom/docx"
import { openOdtAsDocx } from "../core/odt/index"
import { OdtWriteRefusal, writeOdt } from "../core/odt/write/writer"
import { docxRtfServer, inThreadDocxRtf } from "../dom/docx/rtfWorker"
import { odtBytes } from "./odtFixtures"
import { editOdt, odtEditsOf } from "./odtWriteFixtures"
import { text } from "./zipBuilder"

// A signed ODF text document opens view-only ("signed", as a signed DOCX, ODS or ODP does) and its writer refuses
// an edit saved in place: the package's META-INF/documentsignatures.xml would keep digests the edit no longer matches.

const SIGNATURES =
	'<?xml version="1.0" encoding="UTF-8"?><document-signatures xmlns="urn:oasis:names:tc:opendocument:xmlns:digitalsignature:1.0"/>'

function odt(signed: boolean): Uint8Array {
	return odtBytes({
		body: "<text:p>Signed words</text:p><text:p>Last</text:p>",
		...(signed ? { extra: [{ name: "META-INF/documentsignatures.xml", data: text(SIGNATURES) }] } : {})
	})
}

const measurer: TextMeasurer = {
	kerningControl: true,
	measure(_font, _kerning, texts, count, widths) {
		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * 8
	},
	fontExtents(): FontExtents {
		return { ascent: 13, descent: 3 }
	}
}

function services(): DocxEngineServices {
	return {
		fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
		replayFonts: false,
		fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
		measurer,
		yield: () => Promise.resolve(),
		sliceMs: Infinity,
		openOdt: openOdtAsDocx
	}
}

function openedGate(events: readonly DocxEvent[]): readonly string[] | undefined {
	for (const event of events) if (event.type === "opened") return event.info.gate

	return undefined
}

describe("a signed ODF text document", () => {
	it("opens view-only in the engine that translates it", async () => {
		const gate = async (bytes: Uint8Array): Promise<readonly string[] | undefined> => {
			const events: DocxEvent[] = []

			await new DocxEngine(bytesSource(bytes), services(), event => events.push(event), { format: "odt" }).run()

			return openedGate(events)
		}

		expect(await gate(odt(true))).toContain("signed")
		expect(await gate(odt(false))).not.toContain("signed")
	})

	it("is held with the reason, and engine sessions on its translation open view-only", async () => {
		const server = docxRtfServer()

		expect(await server.open(1, odt(true), "odt")).toMatchObject({ ok: true, gate: ["signed"] })
		expect(server.gate(1)).toEqual(["signed"])
		expect(await server.open(2, odt(false), "odt")).toMatchObject({ ok: true, gate: [] })

		const opened = await inThreadDocxRtf(() => services(), "odt").open(odt(true))

		if (opened.kind !== "opened") throw new Error(opened.kind)

		expect(opened.document.gate).toEqual(["signed"])

		const events: DocxEvent[] = []

		await new Promise<void>(resolve => {
			const session = opened.document.host(opened.document.bytes, event => {
				events.push(event)

				if (event.type === "opened" || event.type === "error") {
					session.close()
					resolve()
				}
			})
		})

		expect(openedGate(events)).toContain("signed")
		opened.document.release()
	})

	it("refuses an edit saved in place and keeps an untouched save the source", async () => {
		const bytes = odt(true)
		const editing = await editOdt(bytes, { prove: false })

		editing.session.dispatch(editing.session.state.tr.insertText("New ", 1))

		const edits = await odtEditsOf(editing)

		expect(edits.parts.size).toBeGreaterThan(0)
		await expect(writeOdt(editing.source, edits)).rejects.toMatchObject({ name: "OdtWriteRefusal", reason: "signed" })
		await expect(writeOdt(editing.source, edits)).rejects.toBeInstanceOf(OdtWriteRefusal)
		expect((await writeOdt(editing.source, { parts: new Map() })).bytes).toBe(editing.source.bytes)

		const server = docxRtfServer()

		await server.open(1, bytes, "odt")
		expect(await server.write(1, { parts: [...edits.parts], removed: [] })).toMatchObject({ ok: false, reason: "signed" })
	})

	it("adds the reason to the editing context, which no unlock lifts", async () => {
		const editing = await editOdt(odt(false), { prove: false })
		const context = await openDocxEditContext(editing.opened.pkg, editing.opened.context.model, {
			gate: ["signed"],
			writeUnlocked: true,
			protectionUnlocked: true
		})

		expect(editing.opened.context.gate).not.toContain("signed")
		expect(context.gate).toContain("signed")
	})
})
