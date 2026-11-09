import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, memorySink, writeZip, ZipArchive } from "@filen/office/core/opc"
import { OdfPackage, newOdfPlan, odfMediaType, parseManifest, readContentPrologue, readUntilBody, writeManifest } from "../core/odf/index"
import { CORPUS_DIR } from "./corpusDir"
import { buildZip, text } from "./zipBuilder"

const TEXT = "application/vnd.oasis.opendocument.text"
const OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
const CONTENT = `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="${OFFICE}" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"><office:body><office:text><text:p>Hi</text:p></office:text></office:body></office:document-content>`

function manifest(extra = "", root = TEXT): string {
	return `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${root}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>${extra}</manifest:manifest>`
}

async function written(mediaType: string, parts: { name: string; data: string }[]): Promise<Uint8Array> {
	const sink = memorySink()

	await writeZip(newOdfPlan({ mediaType, parts: parts.map(part => ({ name: part.name, bytes: text(part.data) })) }), null, sink)

	return sink.bytes()
}

async function open(bytes: Uint8Array, kinds?: ("text" | "spreadsheet")[]) {
	return OdfPackage.open(bytesSource(bytes), kinds === undefined ? {} : { kinds })
}

describe("ODF package", () => {
	it("writes the mimetype first, stored, with no extra field, so the media type sits at byte 38", async () => {
		const bytes = await written(TEXT, [
			{ name: "META-INF/manifest.xml", data: manifest() },
			{ name: "content.xml", data: CONTENT }
		])

		expect(new TextDecoder().decode(bytes.subarray(30, 38))).toBe("mimetype")
		expect(new TextDecoder().decode(bytes.subarray(38, 38 + TEXT.length))).toBe(TEXT)

		const archive = await ZipArchive.open(bytesSource(bytes))

		expect(archive.entries[0]?.name).toBe("mimetype")
		expect(archive.entries[0]?.method).toBe(0)
		expect(archive.entries[0]?.extra.length).toBe(0)

		const opened = await open(bytes)

		expect(opened.ok).toBe(true)
		if (!opened.ok) return
		expect(opened.package.facts).toMatchObject({ kind: "text", template: false, mediaType: TEXT, version: "1.3", issues: [] })
		expect(opened.package.facts.mimetype).toEqual({ present: true, value: TEXT, first: true, stored: true, extraField: false })
	})

	it("opens a package whose mimetype is deflated or not first, recording the deviation", async () => {
		const bytes = buildZip([
			{ name: "content.xml", data: text(CONTENT) },
			{ name: "mimetype", data: text(TEXT), method: 8 },
			{ name: "META-INF/manifest.xml", data: text(manifest()) }
		])
		const opened = await open(bytes)

		expect(opened.ok).toBe(true)
		if (!opened.ok) return
		expect(opened.package.facts.issues).toContainEqual({
			kind: "mimetype",
			facts: { present: true, value: TEXT, first: false, stored: false, extraField: false }
		})
	})

	it("takes the media type from the manifest when the mimetype stream is missing", async () => {
		const opened = await open(
			buildZip([
				{ name: "META-INF/manifest.xml", data: text(manifest("", "application/vnd.oasis.opendocument.spreadsheet-template")) },
				{ name: "content.xml", data: text(CONTENT) }
			])
		)

		expect(opened.ok && opened.package.facts).toMatchObject({ kind: "spreadsheet", template: true })
	})

	it("refuses an encrypted package with the algorithms it uses", async () => {
		const encrypted =
			'<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml" manifest:size="10"><manifest:encryption-data manifest:checksum-type="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#sha256-1k" manifest:checksum="AA=="><manifest:algorithm manifest:algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" manifest:initialisation-vector="AA=="/><manifest:key-derivation manifest:key-derivation-name="PBKDF2" manifest:key-size="32" manifest:iteration-count="1024" manifest:salt="AA=="/></manifest:encryption-data></manifest:file-entry>'
		const opened = await open(
			buildZip([
				{ name: "mimetype", data: text(TEXT), method: 0 },
				{ name: "META-INF/manifest.xml", data: text(manifest(encrypted)) },
				{ name: "content.xml", data: text(CONTENT) },
				{ name: "styles.xml", data: text("garbage") }
			])
		)

		expect(opened.ok).toBe(false)
		if (opened.ok) return
		expect(opened.reason).toBe("encrypted")
		expect(opened.encryption).toEqual({
			entries: ["styles.xml"],
			algorithms: ["http://www.w3.org/2001/04/xmlenc#aes256-cbc"],
			keyDerivations: ["PBKDF2"],
			openPgp: false,
			zipEntries: []
		})
	})

	it("refuses an OpenPGP-encrypted package", async () => {
		const opened = await open(
			buildZip([
				{ name: "mimetype", data: text(TEXT), method: 0 },
				{ name: "META-INF/manifest.xml", data: text(manifest("<manifest:keyinfo/>")) },
				{ name: "content.xml", data: text(CONTENT) }
			])
		)

		expect(!opened.ok && [opened.reason, opened.encryption?.openPgp]).toEqual(["encrypted", true])
	})

	it("refuses zips that are not OpenDocument with a typed reason", async () => {
		const docx = await open(buildZip([{ name: "[Content_Types].xml", data: text("<Types/>") }]))
		const legacy = await open(
			buildZip([{ name: "content.xml", data: text('<office:document-content xmlns:office="http://openoffice.org/2000/office"/>') }])
		)
		const notZip = await open(text("plain text, not a zip at all, long enough"))

		expect(!docx.ok && docx.reason).toBe("notOdf")
		expect(!legacy.ok && legacy.reason).toBe("notOdf")
		expect(!legacy.ok && legacy.message).toMatch(/1\.x/)
		expect(!notZip.ok && notZip.reason).toBe("notZip")
	})

	it("refuses a package without content.xml, a malformed manifest, and a kind the caller did not ask for", async () => {
		const noContent = await open(
			buildZip([
				{ name: "mimetype", data: text(TEXT), method: 0 },
				{ name: "META-INF/manifest.xml", data: text(manifest()) }
			])
		)
		const badManifest = await open(
			buildZip([
				{ name: "mimetype", data: text(TEXT), method: 0 },
				{ name: "META-INF/manifest.xml", data: text("<manifest:manifest") },
				{ name: "content.xml", data: text(CONTENT) }
			])
		)
		const wrong = await open(await written(TEXT, [{ name: "content.xml", data: CONTENT }]), ["spreadsheet"])

		expect(!noContent.ok && noContent.reason).toBe("invalidPackage")
		expect(!badManifest.ok && badManifest.reason).toBe("invalidPackage")
		expect(!wrong.ok && wrong.reason).toBe("wrongKind")
	})

	it("records manifest entries missing from the zip and zip entries the manifest leaves out", async () => {
		const opened = await open(
			buildZip([
				{ name: "mimetype", data: text(TEXT), method: 0 },
				{
					name: "META-INF/manifest.xml",
					data: text(manifest('<manifest:file-entry manifest:full-path="Pictures/a.png" manifest:media-type="image/png"/>'))
				},
				{ name: "content.xml", data: text(CONTENT) },
				{ name: "layout-cache", data: text("x") }
			])
		)

		expect(opened.ok && opened.package.facts.issues).toEqual([
			{ kind: "missingEntry", path: "Pictures/a.png" },
			{ kind: "unlistedEntry", path: "layout-cache" }
		])
	})

	it("reads the media types of ODF 1.3 Part 2 Appendix C only", () => {
		expect(odfMediaType("application/vnd.oasis.opendocument.text-master-template")).toEqual({ kind: "text-master", template: true })
		expect(odfMediaType("application/vnd.oasis.opendocument.text-web")).toEqual({ kind: "text-web", template: false })
		expect(odfMediaType("application/vnd.oasis.opendocument.base")).toBeUndefined()
		expect(odfMediaType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBeUndefined()
	})

	it("writes a manifest that reads back to the same entries", () => {
		const bytes = writeManifest("1.3", [
			{ fullPath: "/", mediaType: TEXT, version: "1.3" },
			{ fullPath: "content.xml", mediaType: "text/xml" },
			{ fullPath: "Pictures/a&b.png", mediaType: "image/png" }
		])
		const read = parseManifest(bytes)

		expect(read.version).toBe("1.3")
		expect(read.entries.map(entry => [entry.fullPath, entry.mediaType, entry.version])).toEqual([
			["/", TEXT, "1.3"],
			["content.xml", "text/xml", undefined],
			["Pictures/a&b.png", "image/png", undefined]
		])
	})

	it("reads a manifest bound to another prefix", () => {
		const read = parseManifest(
			text(
				'<m:manifest xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><m:file-entry m:full-path="/" m:media-type="x"/></m:manifest>'
			)
		)

		expect(read.entries[0]?.mediaType).toBe("x")
	})
})

describe("content.xml prologue", () => {
	const head = `<?xml version="1.0"?><!-- c --><o:document-content xmlns:o="${OFFICE}" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" o:version="1.3" title="a>b"><o:automatic-styles><style:style style:name="P1" style:family="paragraph"/></o:automatic-styles>`

	it("parses only what precedes office:body and reports where the body starts", () => {
		// The body is not well-formed: only the prologue may be parsed.
		const bytes = text(`${head}<o:body><broken></o:document-content>`)
		const prologue = readContentPrologue(bytes)

		expect(prologue.sliced).toBe(true)
		expect(prologue.bodyStart).toBe(head.length)
		expect(prologue.document.name(prologue.document.firstChildElement(prologue.root))).toBe("o:automatic-styles")
	})

	it("falls back to the whole stream when the body tag appears inside a comment", () => {
		const bytes = text(`${head.replace("<o:automatic-styles>", "<!-- <o:body> --><o:automatic-styles>")}<o:body/></o:document-content>`)
		const prologue = readContentPrologue(bytes)

		expect(prologue.sliced).toBe(false)
		expect(new TextDecoder().decode(bytes.subarray(prologue.bodyStart, prologue.bodyStart + 8))).toBe("<o:body/")
	})
})

describe("content.xml prefix", () => {
	it("inflates content.xml only until office:body, never the whole body", async () => {
		const head = `<?xml version="1.0"?><office:document-content xmlns:office="${OFFICE}"><office:automatic-styles/>`
		// Filler that compresses poorly, so the whole body is far more than one compressed step.
		const filler = Array.from({ length: 400_000 }, (_, k) => `<p>${(k * 2654435761) % 1_000_000_007}</p>`).join("")
		const body = `<office:body><office:text>${filler}</office:text></office:body></office:document-content>`
		const archive = await ZipArchive.open(bytesSource(buildZip([{ name: "content.xml", data: text(head + body) }])))
		const entry = archive.get("content.xml")

		if (entry === undefined) throw new Error("no entry")

		const prefix = await readUntilBody(archive, entry)

		expect(entry.uncompressedSize).toBeGreaterThan(5_000_000)
		expect(prefix.length).toBeLessThan(1_000_000)
		expect(readContentPrologue(prefix).bodyStart).toBe(head.length)
	})

	it("returns the whole stream when there is no office:body", async () => {
		const xml = `<office:document-content xmlns:office="${OFFICE}"><office:automatic-styles/></office:document-content>`
		const archive = await ZipArchive.open(bytesSource(buildZip([{ name: "content.xml", data: text(xml) }])))
		const entry = archive.get("content.xml")

		if (entry === undefined) throw new Error("no entry")

		expect(new TextDecoder().decode(await readUntilBody(archive, entry))).toBe(xml)
	})
})

const ODT = join(CORPUS_DIR, "odt")
const ODS = join(CORPUS_DIR, "ods")

describe.skipIf(!existsSync(ODT) || !existsSync(ODS))("ODF corpus packages", () => {
	it("opens every corpus text and spreadsheet package or refuses it with a typed reason", async () => {
		const reasons = new Map<string, string>()
		let opened = 0

		for (const [directory, kind] of [
			[ODT, "text"],
			[ODS, "spreadsheet"]
		] as const) {
			for (const name of readdirSync(directory).sort()) {
				const result = await OdfPackage.open(bytesSource(new Uint8Array(readFileSync(join(directory, name)))), { kinds: [kind] })

				if (result.ok) opened++
				else reasons.set(name, result.reason)
			}
		}

		// ODF 1.3 Part 2 §4.8: encrypted packages (Blowfish CFB and AES-256-CBC) are refused as encrypted.
		expect(Object.fromEntries(reasons)).toEqual({
			"lo__password.ods": "encrypted",
			"lo__passwordOld.ods": "encrypted",
			"odftk__testInvalidPkg2.odt": "invalidPackage",
			"tika__testODTEncrypted.odt": "encrypted"
		})
		expect(opened).toBe(146)
	})
})
