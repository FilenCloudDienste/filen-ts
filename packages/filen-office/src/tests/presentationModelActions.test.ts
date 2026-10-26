import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openPptx } from "../core/pptx/package"
import { classifyAction, classifyHref, type ActionContext } from "../core/presentation/actions"
import { slideRef, type Action, type ShapeNode } from "../core/presentation/model"
import { CORPUS_DIR } from "./corpusDir"

// Every action kind a deck can carry, as the show and the editor will treat it: links only to http, https and
// mailto; jumps and custom shows inside the deck; programs, macros, OLE verbs, files and unknown schemes refused.

const SLIDE = slideRef(7)
const context: ActionContext = { slideOf: part => (part === "/ppt/slides/slide3.xml" ? SLIDE : undefined) }
const external = (target: string) => ({ external: true, target })

describe("action classification", () => {
	it.each([
		["https://filen.io/drive", { kind: "url", href: "https://filen.io/drive" }],
		["http://example.com", { kind: "url", href: "http://example.com" }],
		["mailto:someone@example.com?subject=Hi", { kind: "url", href: "mailto:someone@example.com?subject=Hi" }],
		["HTTPS://EXAMPLE.COM/", { kind: "url", href: "HTTPS://EXAMPLE.COM/" }]
	] as const)("opens %s as a link", (href, expected) => {
		expect(classifyAction({ target: external(href) }, context)).toEqual(expected)
	})

	it.each([
		["file:///C:/secret.txt", "file"],
		["\\\\server\\share\\deck.pptx", "file"],
		["C:\\Users\\deck.pptx", "file"],
		["other.pptx", "file"],
		["javascript:alert(1)", "scheme"],
		["data:text/html,<script>", "scheme"],
		["ms-word:ofe|u|https://x", "scheme"],
		["https://exa mple.com", "scheme"],
		["http:", "scheme"]
	] as const)("refuses %s as a %s link", (href, what) => {
		expect(classifyAction({ target: external(href) }, context)).toEqual({ kind: "refused", what, raw: href })
		expect(classifyHref(href)).toEqual({ kind: "refused", what, raw: href })
	})

	it("jumps to slides by relationship, verb or none", () => {
		const target = { external: false, target: "slide3.xml", partName: "/ppt/slides/slide3.xml" }

		expect(classifyAction({ action: "ppaction://hlinksldjump", target }, context)).toEqual({ kind: "slide", slide: SLIDE })
		expect(classifyAction({ target }, context)).toEqual({ kind: "slide", slide: SLIDE })
		// A jump to a slide the deck does not list is no action (the markup is kept).
		expect(
			classifyAction({ action: "ppaction://hlinksldjump", target: { ...target, partName: "/ppt/slides/slide9.xml" } }, context)
		).toBeUndefined()
	})

	it.each([
		["nextslide", "next"],
		["previousslide", "previous"],
		["firstslide", "first"],
		["lastslide", "last"],
		["lastslideviewed", "lastViewed"],
		["endshow", "end"]
	] as const)("jumps in the show for hlinkshowjump?jump=%s", (jump, expected) => {
		expect(classifyAction({ action: `ppaction://hlinkshowjump?jump=${jump}` }, context)).toEqual({ kind: "internal", jump: expected })
	})

	it("plays custom shows, returning when asked", () => {
		expect(classifyAction({ action: "ppaction://customshow?id=2&return=true" }, context)).toEqual({
			kind: "customShow",
			id: 2,
			returnAfter: true
		})
		expect(classifyAction({ action: "ppaction://customshow?id=0" }, context)).toEqual({ kind: "customShow", id: 0, returnAfter: false })
		expect(classifyAction({ action: "ppaction://customshow?id=x" }, context)).toBeUndefined()
	})

	it("plays the shape's own media for ppaction://media", () => {
		expect(classifyAction({ action: "ppaction://media" }, context)).toEqual({ kind: "media" })
	})

	it("treats noaction and an empty link as no action", () => {
		expect(classifyAction({ action: "ppaction://noaction" }, context)).toBeUndefined()
		expect(classifyAction({}, context)).toBeUndefined()
		expect(classifyAction({ action: "ppaction://hlinkshowjump?jump=sideways" }, context)).toBeUndefined()
	})

	it("refuses programs, macros, OLE verbs, files, other presentations and unknown verbs", () => {
		expect(classifyAction({ action: "ppaction://program", target: external("calc.exe") }, context)).toEqual({
			kind: "refused",
			what: "program",
			raw: "calc.exe"
		})
		expect(classifyAction({ action: "ppaction://macro?name=AutoOpen" }, context)).toEqual({
			kind: "refused",
			what: "macro",
			raw: "ppaction://macro?name=AutoOpen"
		})
		expect(classifyAction({ action: "ppaction://ole?verb=0" }, context)).toEqual({
			kind: "refused",
			what: "ole",
			raw: "ppaction://ole?verb=0"
		})
		expect(classifyAction({ action: "ppaction://hlinkfile", target: external("notes.txt") }, context)).toEqual({
			kind: "refused",
			what: "file",
			raw: "notes.txt"
		})
		expect(classifyAction({ action: "ppaction://hlinkpres?slideindex=1", target: external("other.pptx") }, context)).toEqual({
			kind: "refused",
			what: "file",
			raw: "other.pptx"
		})
		expect(classifyAction({ action: "ppaction://frobnicate" }, context)).toEqual({
			kind: "refused",
			what: "scheme",
			raw: "ppaction://frobnicate"
		})
		expect(classifyAction({ action: "javascript:alert(1)" }, context)).toEqual({
			kind: "refused",
			what: "scheme",
			raw: "javascript:alert(1)"
		})
	})
})

function actionsOf(shapes: readonly ShapeNode[], out: Action[]): void {
	for (const shape of shapes) {
		if (shape.actions?.click !== undefined) out.push(shape.actions.click)
		if (shape.actions?.hover !== undefined) out.push(shape.actions.hover)

		for (const paragraph of shape.text?.paragraphs ?? []) {
			for (const run of paragraph.runs) {
				if (run.kind === "r" || run.kind === "br" || run.kind === "fld") {
					if (run.rPr.hlinkClick !== undefined) out.push(run.rPr.hlinkClick)
					if (run.rPr.hlinkMouseOver !== undefined) out.push(run.rPr.hlinkMouseOver)
				}
			}
		}

		actionsOf(shape.children ?? [], out)
	}
}

describe("actions in corpus decks", () => {
	it.each([
		["pptm/pypptx__act-props.pptm"],
		["pptm/lo__macro.pptm"],
		["pptm/poi__PPTWithAttachments.pptm"],
		["pptx/tika__testWPSAttachment.pptx"]
	])("classifies every action of %s, refusing programs, macros, OLE and files", async path => {
		const file = join(CORPUS_DIR, path)

		if (!existsSync(file)) return

		const open = await openPptx(bytesSource(new Uint8Array(readFileSync(file))))

		if (open.kind !== "opened") throw new Error(open.reason)

		await open.parts.parseAll()

		const actions: Action[] = []

		for (const ref of open.deck.slides) actionsOf(open.deck.nodes.get(ref)?.shapes ?? [], actions)

		const kinds = new Set(actions.map(action => (action.kind === "refused" ? `refused:${action.what}` : action.kind)))
		const expected: Readonly<Record<string, readonly string[]>> = {
			"pptm/pypptx__act-props.pptm": [
				"slide",
				"internal",
				"customShow",
				"url",
				"refused:program",
				"refused:macro",
				"refused:ole",
				"refused:file"
			],
			"pptm/lo__macro.pptm": ["refused:macro"],
			"pptm/poi__PPTWithAttachments.pptm": ["refused:file"],
			"pptx/tika__testWPSAttachment.pptx": ["refused:ole"]
		}

		for (const kind of expected[path] ?? []) expect(kinds, kind).toContain(kind)

		// Nothing but http, https and mailto is ever a link.
		for (const action of actions) if (action.kind === "url") expect(action.href).toMatch(/^(https?:\/\/|mailto:)/iu)
	})
})
