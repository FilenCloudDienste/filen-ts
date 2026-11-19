import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { bytesSource, OpcPackage } from "@filen/office/core/opc"
import { DocxEditorSession, docxSchema, parseDocxEditorCommand } from "@filen/office/core/docx/edit"
import { saveDocx, writerProof } from "@filen/office/core/docx/write"
import { linkTargetRefusal, linkTargetUri } from "../core/docx/edit/commands/insert"
import { freshSlice } from "../core/docx/edit/invariants/index"
import { openBytes } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"

// A link's target is written as an external relationship's Target, an xsd:anyURI (ECMA-376 Part 2 §9.3): what
// RFC 3986 does not allow is percent-encoded as UTF-8, as Word writes a typed address.

// RFC 3986 characters only, every "%" an escape, at most one "#".
const URI_REFERENCE = /^(?:[A-Za-z0-9\-._~:/?@!$&'()*+,;=[\]]|%[0-9A-F]{2})*(?:#(?:[A-Za-z0-9\-._~:/?@!$&'()*+,;=]|%[0-9A-F]{2})*)?$/

const uri = (target: string): string | undefined => {
	const written = linkTargetUri(target)

	return "uri" in written ? written.uri : undefined
}

describe("link targets", () => {
	it("percent-encodes what a URI reference does not allow, as UTF-8", () => {
		expect(uri("https://filen.io/<&>\"']]>Z")).toBe("https://filen.io/%3C&%3E%22'%5D%5D%3EZ")
		expect(uri("https://e.example/a b{c}|d\\e^f`g")).toBe("https://e.example/a%20b%7Bc%7D%7Cd%5Ce%5Ef%60g")
		expect(uri("https://e.example/ü/€/\u{1F600}")).toBe("https://e.example/%C3%BC/%E2%82%AC/%F0%9F%98%80")
		expect(uri("https://e.example/100%/a#b#c")).toBe("https://e.example/100%25/a#b%23c")
		expect(uri("https://e.example/x[1]")).toBe("https://e.example/x%5B1%5D")
	})

	it("keeps what is valid as it is: escapes, an IP literal's brackets, reserved characters", () => {
		for (const target of [
			"https://filen.io/",
			"https://e.example/a%20b?q=1&r=%C3%BC#frag/x?y",
			"https://[2001:db8::1]:8080/path",
			"https://user@[::1]/",
			"mailto:a@e.example?subject=Hi%20there",
			"www.example.com/a;b=c,d",
			"https://e.example/(x)*+!$'"
		])
			expect(uri(target)).toBe(target)
	})

	it("gives what it encoded back unchanged, a valid URI reference", () => {
		for (const target of ["https://filen.io/<&>\"']]>Z", "https://e.example/a b#c#d", "x[y]%zz é\u{1F600}"]) {
			const once = uri(target) ?? ""

			expect(once).toMatch(URI_REFERENCE)
			expect(uri(once)).toBe(once)
		}
	})

	it("refuses what no URI reference carries, with why", () => {
		expect(linkTargetUri("https://e.example/\u0001")).toEqual({ refusal: "control" })
		expect(linkTargetUri("https://e.example/\t")).toEqual({ refusal: "control" })
		expect(linkTargetUri(`https://e.example/${String.fromCharCode(0xd800)}`)).toEqual({ refusal: "surrogate" })
		expect(linkTargetUri(`https://e.example/${String.fromCharCode(0xdc00)}x`)).toEqual({ refusal: "surrogate" })
	})

	it("encodes the target on the bridge and on the host's typed path, the file holding what the link shows", async () => {
		expect(parseDocxEditorCommand({ type: "link.set", target: "https://e.example/a b" })).toEqual({
			type: "link.set",
			target: "https://e.example/a%20b"
		})
		expect(parseDocxEditorCommand({ type: "link.set", target: `https://e.example/${String.fromCharCode(0xdc00)}` })).toBeUndefined()

		const opened = await openBytes(buildDocx({ body: p("See here") }))
		const session = new DocxEditorSession(opened.context, { proof: writerProof(opened.context) })

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 1, 4)))
		expect(session.execute({ type: "link.set", target: "https://filen.io/<&>\"']]>Z" })).toBe(true)
		expect(session.snapshot().context.link?.target).toBe("https://filen.io/%3C&%3E%22'%5D%5D%3EZ")
		expect(session.execute({ type: "link.set", target: `https://e.example/${String.fromCharCode(0xd800)}` })).toBe(false)

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })
		const pkg = await OpcPackage.open(bytesSource(result.bytes as Uint8Array))
		const rels = new TextDecoder().decode(await pkg.read("word/_rels/document.xml.rels"))

		expect(rels).toContain('Target="https://filen.io/%3C&amp;%3E%22&apos;%5D%5D%3EZ" TargetMode="External"')
	})

	it("writes a link whose target no command made (a copy of a file's) as a URI reference", async () => {
		const opened = await openBytes(buildDocx({ body: p("See here") }))
		const session = new DocxEditorSession(opened.context, { proof: writerProof(opened.context) })
		const link = docxSchema.marks.link.create({ target: "https://filen.io/a b]]>", anchor: null })

		session.dispatch(session.state.tr.addMark(1, 4, link))

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })
		const pkg = await OpcPackage.open(bytesSource(result.bytes as Uint8Array))
		const rels = new TextDecoder().decode(await pkg.read("word/_rels/document.xml.rels"))

		expect(rels).toContain('Target="https://filen.io/a%20b%5D%5D%3E" TargetMode="External"')
	})

	it("writes a pasted copy of a file's link whose target holds a control character, the control percent-encoded", async () => {
		const opened = await openBytes(
			buildDocx({
				body: p("Start") + '<w:p><w:hyperlink r:id="rIdL"><w:r><w:t>Linked</w:t></w:r></w:hyperlink></w:p>',
				relationships: [{ id: "rIdL", type: "hyperlink", target: "http://example.com/a&#9;b", external: true }]
			})
		)
		const session = new DocxEditorSession(opened.context, { proof: writerProof(opened.context) })
		const doc = session.state.doc
		let from = -1

		doc.descendants((node, pos) => {
			if (node.isText && node.text === "Linked") from = pos
		})
		session.dispatch(session.state.tr.replaceRange(2, 2, freshSlice(doc.slice(from, from + 6))))

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })
		const pkg = await OpcPackage.open(bytesSource(result.bytes as Uint8Array))
		const rels = new TextDecoder().decode(await pkg.read("word/_rels/document.xml.rels"))

		expect(rels).toContain('Target="http://example.com/a%09b" TargetMode="External"')
	})

	// A link's existing target stays whatever its scheme: one the file holds unencoded (a raw space) is the same
	// target as its encoded form.
	it.each([
		["file:///C:/My Docs/a.docx", "file:///C:/My%20Docs/a.docx"],
		["https://e.example/a b", "https://e.example/a%20b"]
	])("edits the text of a link to %s, its target kept", async (target, written) => {
		const opened = await openBytes(
			buildDocx({
				body: p("Before") + '<w:p><w:hyperlink r:id="rIdL"><w:r><w:t>Link</w:t></w:r></w:hyperlink></w:p>',
				relationships: [{ id: "rIdL", type: "hyperlink", target, external: true }]
			})
		)
		const session = new DocxEditorSession(opened.context, { proof: writerProof(opened.context) })

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 10, 12)))

		expect(session.snapshot().context.link?.target).toBe(target)
		expect(session.execute({ type: "link.set", target, text: "Edited" })).toBe(true)
		expect(session.state.doc.textContent).toBe("BeforeEdited")

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })
		const pkg = await OpcPackage.open(bytesSource(result.bytes as Uint8Array))
		const rels = new TextDecoder().decode(await pkg.read("word/_rels/document.xml.rels"))
		const document = new TextDecoder().decode(await pkg.read("word/document.xml"))
		const hyperlinks = [
			...rels.matchAll(/<Relationship Id="([^"]+)" Type="[^"]+\/hyperlink" Target="([^"]*)" TargetMode="External"\/>/g)
		]

		// One relationship, the target written as the URI reference it is (a raw space encoded), the link's text the new one.
		expect(rels.match(/\/hyperlink"/g)).toHaveLength(1)
		expect(hyperlinks).toHaveLength(1)
		expect(hyperlinks[0]?.[2]).toBe(written)
		expect(document).toContain(`<w:hyperlink r:id="${hyperlinks[0]?.[1] ?? ""}"><w:r><w:t>Edited</w:t></w:r></w:hyperlink>`)
	})

	it("links new targets to web, email and phone addresses only, with why", () => {
		for (const target of ["https://filen.io/", "HTTP://E.EXAMPLE/a b", "mailto:a@e.example", "tel:+491234"])
			expect(linkTargetRefusal(target)).toBeUndefined()

		for (const target of [
			"javascript:alert(1)",
			"file:///C:/a.docx",
			"ftp://e.example/",
			"sms:123",
			"www.example.com",
			"#top",
			"https:x"
		])
			expect(linkTargetRefusal(target)).toBe("scheme")

		expect(linkTargetRefusal("file:///C:/a.docx", "file:///C:/a.docx")).toBeUndefined()
		expect(linkTargetRefusal("file:///C:/a b.docx", "file:///C:/a%20b.docx")).toBeUndefined()
		expect(linkTargetRefusal("file:///C:/b.docx", "file:///C:/a.docx")).toBe("scheme")
		expect(linkTargetRefusal("https://e.example/\u0001")).toBe("control")
	})

	it("refuses a new link elsewhere, keeps a file's link and lets its text change without its target", async () => {
		const opened = await openBytes(
			buildDocx({
				body: '<w:p><w:hyperlink r:id="rIdL"><w:r><w:t>local file</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and more</w:t></w:r></w:p>',
				relationships: [{ id: "rIdL", type: "hyperlink", target: "file:///C:/a.docx", external: true }]
			})
		)
		const session = new DocxEditorSession(opened.context, { proof: writerProof(opened.context) })
		const select = (from: number, to: number): void => {
			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
		}

		// The bridge's parser takes any scheme (what the target is, not what the link at the selection is).
		expect(parseDocxEditorCommand({ type: "link.set", target: "javascript:alert(1)" })).toEqual({
			type: "link.set",
			target: "javascript:alert(1)"
		})

		select(16, 19)
		expect(session.execute({ type: "link.set", target: "javascript:alert(1)" })).toBe(false)
		expect(session.execute({ type: "link.set", target: "file:///C:/a.docx" })).toBe(false)
		expect(session.state.doc.textContent).toBe("local file and more")
		expect(session.execute({ type: "link.set", target: "https://filen.io/" })).toBe(true)

		select(3, 3)
		expect(session.snapshot().context.link?.target).toBe("file:///C:/a.docx")
		expect(session.execute({ type: "link.set", target: "ftp://e.example/" })).toBe(false)
		expect(session.execute({ type: "link.set", target: "file:///C:/a.docx", text: "the file" })).toBe(true)
		expect(session.state.doc.textContent).toBe("the file and more")
		select(3, 3)
		expect(session.snapshot().context.link).toEqual({ target: "file:///C:/a.docx", anchor: null, text: "the file" })
	})

	// Word stores https://host/page#part as the relationship's target plus w:anchor.
	it("takes a target with its anchor, and a link's text edit keeps both, saved", async () => {
		expect(parseDocxEditorCommand({ type: "link.set", target: "https://e.example/docs", anchor: "sec-2.1", text: "Docs" })).toEqual({
			type: "link.set",
			target: "https://e.example/docs",
			anchor: "sec-2.1",
			text: "Docs"
		})

		const opened = await openBytes(
			buildDocx({
				body: '<w:p><w:hyperlink r:id="rIdL" w:anchor="install"><w:r><w:t>Install</w:t></w:r></w:hyperlink></w:p>',
				relationships: [{ id: "rIdL", type: "hyperlink", target: "https://e.example/docs", external: true }]
			})
		)
		const session = new DocxEditorSession(opened.context, { proof: writerProof(opened.context) })
		const select = (from: number, to: number): void => {
			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
		}

		select(3, 3)
		expect(session.snapshot().context.link).toEqual({ target: "https://e.example/docs", anchor: "install", text: "Install" })
		// Unchanged: nothing to do.
		expect(session.execute({ type: "link.set", target: "https://e.example/docs", anchor: "install" })).toBe(true)
		expect(session.state.doc.textContent).toBe("Install")
		expect(session.execute({ type: "link.set", target: "https://e.example/docs", anchor: "install", text: "Setup" })).toBe(true)
		select(3, 3)
		expect(session.snapshot().context.link).toEqual({ target: "https://e.example/docs", anchor: "install", text: "Setup" })

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })
		const pkg = await OpcPackage.open(bytesSource(result.bytes as Uint8Array))
		const rels = new TextDecoder().decode(await pkg.read("word/_rels/document.xml.rels"))
		const document = new TextDecoder().decode(await pkg.read("word/document.xml"))

		expect(rels).toContain('Target="https://e.example/docs"')
		expect(document).toMatch(/<w:hyperlink r:id="[^"]+" w:anchor="install"><w:r><w:t>Setup<\/w:t><\/w:r><\/w:hyperlink>/)
	})
})
