// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { buildStructTree, pageStructTree } from "../react/pdf/structTree"

// A tagged page's structure tree as the accessible tree in its canvas (react/pdf/structTree.ts), over the text layer's
// marked content spans as pdf.js's TextLayer writes them.

const DIMS = { pageHeight: 800, pageX: 0, pageY: 0 }

function textLayer(ids: readonly string[]): HTMLElement {
	const container = document.createElement("div")

	for (const id of ids) {
		const span = document.createElement("span")

		span.className = "markedContent"
		span.id = id
		span.textContent = `text of ${id}`
		container.append(span)
	}

	return container
}

const TREE = {
	role: "Root",
	children: [
		{
			role: "Document",
			children: [
				{ role: "H1", children: [{ type: "content", id: "p0R_mc0" }] },
				{ role: "P", children: [{ type: "content", id: "p0R_mc1" }] },
				{
					role: "Table",
					children: [
						{
							role: "TR",
							children: [
								{ role: "TH", structId: "h1", children: [{ type: "content", id: "p0R_mc2" }] },
								{ role: "TD", headers: ["h1"], children: [{ type: "content", id: "p0R_mc3" }] }
							]
						}
					]
				},
				{ role: "Figure", alt: "A chart", bbox: [10, 20, 110, 220], children: [{ type: "content", id: "p0R_mc4" }] },
				{
					role: "Link",
					children: [
						{ type: "content", id: "p0R_mc5" },
						{ type: "annotation", id: "15R" }
					]
				}
			]
		}
	]
}

describe("the structure tree", () => {
	it("gives roles, heading levels, table headers and figure labels, its ids prefixed", () => {
		const built = buildStructTree(document, TREE, { rawDims: DIMS, idPrefix: "doc1-" })

		expect(built).not.toBeNull()

		const root = built?.root ?? document.createElement("span")
		const heading = root.querySelector('[role="heading"]')

		expect(root.classList.contains("structTree")).toBe(true)
		expect(heading?.getAttribute("aria-level")).toBe("1")
		expect(heading?.getAttribute("aria-owns")).toBe("doc1-p0R_mc0")
		expect(root.querySelector('[role="paragraph"]')?.getAttribute("aria-owns")).toBe("doc1-p0R_mc1")
		expect(root.querySelector('[role="table"]')).not.toBeNull()

		const header = root.querySelector('[role="columnheader"]')

		expect(header?.id).toBe("doc1-s0")
		expect(root.querySelector('[role="cell"]')?.getAttribute("aria-describedby")).toBe("doc1-s0")
		expect(root.querySelector('[role="figure"]')?.getAttribute("aria-owns")).toBe("doc1-p0R_mc4")

		const link = root.querySelector('[role="link"]')

		// The annotation node is dropped: only the link's text is owned.
		expect(link?.getAttribute("aria-owns")).toBe("doc1-p0R_mc5")
		expect(root.innerHTML).not.toContain("15R")

		const container = textLayer(["p0R_mc0", "p0R_mc1", "p0R_mc4"])

		built?.applyToTextLayer(container)

		expect([...container.querySelectorAll(".markedContent")].map(span => span.id)).toEqual([
			"doc1-p0R_mc0",
			"doc1-p0R_mc1",
			"doc1-p0R_mc4"
		])

		const image = container.querySelector('#doc1-p0R_mc4 [role="img"]')

		expect(image?.getAttribute("aria-label")).toBe("A chart")
		expect((image as HTMLElement | null)?.style.top).toBe("calc(var(--total-scale-factor) * 580px)")
	})

	it("reads a formula's MathML through the host's sanitizer, else its text", () => {
		const formula = { role: "Formula", mathML: "<math><mi>x</mi></math>", children: [{ type: "content", id: "m0" }] }
		const sanitize = vi.fn((markup: string) => {
			const template = document.createElement("template")

			template.innerHTML = markup

			return template.content
		})
		const withMath = buildStructTree(document, formula, { rawDims: DIMS, idPrefix: "a-", sanitizeMathML: sanitize })
		const layer = textLayer(["m0"])

		withMath?.applyToTextLayer(layer)

		expect(sanitize).toHaveBeenCalledWith("<math><mi>x</mi></math>")
		expect(withMath?.root.querySelector("math")).not.toBeNull()
		expect(layer.querySelector("#a-m0")?.getAttribute("aria-hidden")).toBe("true")

		const plain = buildStructTree(document, formula, { rawDims: DIMS, idPrefix: "b-" })

		expect(plain?.root.querySelector("math")?.getAttribute("aria-owns")).toBe("b-m0")
	})

	it("builds nothing past the node cap or for no tree", () => {
		const wide = {
			role: "Document",
			children: Array.from({ length: 10 }, (_, index) => ({ type: "content", id: `c${String(index)}` }))
		}

		expect(buildStructTree(document, wide, { rawDims: DIMS, idPrefix: "x-", maxNodes: 10 })).toBeNull()
		expect(buildStructTree(document, wide, { rawDims: DIMS, idPrefix: "x-", maxNodes: 11 })).not.toBeNull()
		expect(buildStructTree(document, null, { rawDims: DIMS, idPrefix: "x-" })).toBeNull()
	})

	it("asks an untagged document's pages once, and every page of a tagged one", async () => {
		const untagged = {}
		const none = vi.fn(() => Promise.resolve(null))

		expect(await Promise.all([1, 2, 3].map(() => pageStructTree(untagged, { getStructTree: none })))).toEqual([null, null, null])
		expect(none).toHaveBeenCalledOnce()

		const tagged = {}
		const some = vi.fn(() => Promise.resolve(TREE))

		await Promise.all([1, 2, 3].map(() => pageStructTree(tagged, { getStructTree: some })))
		expect(some).toHaveBeenCalledTimes(3)
		expect(await pageStructTree({}, {})).toBeNull()
	})
})
