import { describe, expect, test } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Guards the one rule every DOM (WebView) page has to obey about safe-area padding.
 *
 * `installDomViewportReset` pins html/body to the layout viewport and sets `overflow: hidden`, so
 * anything taller than the viewport is CLIPPED rather than scrolled. An element that declares both a
 * full height and padding therefore has to be `border-box`: under the default content-box the two
 * add up, the element stands taller than the root, and the last paddingTop+paddingBottom of the
 * document lands below the cut — reachable only as a rubber-band that springs straight back.
 *
 * The editors state this rule in prose (codeMirrorLayout's ".cm-content, never `&`" and the Quill
 * wrapper's "box AROUND the scroller"), and the pdf and docx viewers still shipped the bug, because
 * prose does not fail a build. This does.
 *
 * The better shape, where a component can take it, is to put the padding on the SCROLLED CONTENT
 * instead — then no box combines the two and this check never applies.
 */
describe("DOM page scroll padding", () => {
	// A definite full height: the literals, plus the two constants that resolve to 100dvh.
	const FULL_HEIGHT = /height:\s*(?:["'](?:100%|100dvh|100vh)["']|CODE_MIRROR_HEIGHT|VIEWPORT_HEIGHT)/
	const PADDING = /padding(?:Top|Bottom|Left|Right)?\s*:/
	// The PROPERTY, never the phrase: the fixed elements explain themselves in a comment that says
	// "border-box", and a substring check reads that as compliance — which is how the first version of
	// this test passed while the bug was reintroduced.
	const BORDER_BOX = /(?:boxSizing|["']?box-sizing["']?)\s*:/
	const OPENS_STYLE = /(?:style=\{\{|style:\s*\{)/g

	// Comments are prose about the code, not the code — a check that reads them is a check that can be
	// satisfied by writing the right word in a sentence.
	// Only whole-line `//`, never a trailing one: cutting from `//` to end of line would also eat a
	// property sitting before it, and these blocks keep their comments on their own lines anyway.
	function withoutComments(source: string): string {
		return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "")
	}

	function collect(directory: string): string[] {
		const files: string[] = []

		for (const entry of readdirSync(directory)) {
			const path = join(directory, entry)

			// This file names the pattern it bans; scanning the test tree would only catch itself.
			if (entry === "tests") {
				continue
			}

			if (statSync(path).isDirectory()) {
				files.push(...collect(path))
			} else if (/\.(ts|tsx)$/.test(entry)) {
				files.push(path)
			}
		}

		return files
	}

	// The style object's own text, brace-matched from its opening so a nested object cannot end it early.
	function styleBlocks(contents: string): { block: string; line: number }[] {
		const blocks: { block: string; line: number }[] = []

		for (const match of contents.matchAll(OPENS_STYLE)) {
			let depth = match[0].endsWith("{{") ? 2 : 1
			let index = match.index + match[0].length

			while (index < contents.length && depth > 0) {
				if (contents[index] === "{") {
					depth++
				} else if (contents[index] === "}") {
					depth--
				}

				index++
			}

			blocks.push({
				block: contents.slice(match.index + match[0].length, index),
				line: contents.slice(0, match.index).split("\n").length
			})
		}

		return blocks
	}

	test("no element combines a full height with padding unless it is border-box", () => {
		const offenders: string[] = []

		for (const file of collect(join(process.cwd(), "src"))) {
			for (const { block, line } of styleBlocks(readFileSync(file, "utf-8"))) {
				const code = withoutComments(block)

				if (!FULL_HEIGHT.test(code) || !PADDING.test(code)) {
					continue
				}

				if (BORDER_BOX.test(code)) {
					continue
				}

				offenders.push(`${file}:${line}`)
			}
		}

		expect(offenders, "full height + padding without border-box overflows the clipped DOM root").toEqual([])
	})

	test("the check actually recognises the shape it bans", () => {
		// Without this the test above passes just as well when the matcher is broken.
		const bad = withoutComments(styleBlocks(`<div style={{ width: "100%", height: "100%", paddingTop: "40px" }} />`)[0]?.block ?? "")

		expect(FULL_HEIGHT.test(bad)).toBe(true)
		expect(PADDING.test(bad)).toBe(true)
		expect(BORDER_BOX.test(bad)).toBe(false)
	})

	test("a comment saying border-box does not count as being border-box", () => {
		// The first version of this test compared against the raw block, so the explanatory comment on
		// the very elements it guards read as compliance — deleting the property left it green.
		const commented = withoutComments(
			styleBlocks(`<div style={{
				height: "100%",
				// border-box, because this element carries both the height and the padding
				paddingTop: "40px"
			}} />`)[0]?.block ?? ""
		)

		expect(FULL_HEIGHT.test(commented)).toBe(true)
		expect(PADDING.test(commented)).toBe(true)
		expect(BORDER_BOX.test(commented)).toBe(false)
	})

	test("the real property still counts", () => {
		const fixed = withoutComments(styleBlocks(`<div style={{ height: "100%", boxSizing: "border-box", paddingTop: "40px" }} />`)[0]?.block ?? "")

		expect(BORDER_BOX.test(fixed)).toBe(true)
	})

	test("padding on the scrolled content is not flagged", () => {
		// The shape the editors use: the sized box carries no padding, so the two never combine.
		const wrapper = styleBlocks(`<div style={{ height: CODE_MIRROR_HEIGHT, overflowY: "auto" }} />`)[0]

		expect(PADDING.test(wrapper?.block ?? "")).toBe(false)
	})
})
