import { describe, expect, it } from "vitest"
import { ribbonFit, type RibbonGroupSize } from "@/features/office/components/ribbon/ribbonFit"

// The ribbon's command row: groups in full while there is room, then collapsed into a dropdown each, lowest priority
// (and of equals the later) first, then into the overflow menu; a phone skips collapsing.

const GROUPS: readonly RibbonGroupSize[] = [
	{ id: "undo", width: 60, collapsedWidth: 44, priority: Infinity },
	{ id: "clipboard", width: 145, collapsedWidth: 55, priority: 3 },
	{ id: "font", width: 357, collapsedWidth: 55, priority: 6 },
	{ id: "formatting", width: 221, collapsedWidth: 55, priority: 7 },
	{ id: "paragraph", width: 325, collapsedWidth: 55, priority: 5 },
	{ id: "styles", width: 157, collapsedWidth: null, priority: 4 },
	{ id: "editing", width: 55, collapsedWidth: null, priority: 2 }
]

function states(width: number, collapse: boolean): Record<string, string> {
	return Object.fromEntries(ribbonFit(width, GROUPS, collapse))
}

describe("ribbonFit", () => {
	it("keeps every group in full when they fit, or before the row is measured", () => {
		expect(Object.values(states(2000, true)).every(state => state === "full")).toBe(true)
		expect(Object.values(states(0, true)).every(state => state === "full")).toBe(true)
	})

	it("collapses the lowest priority groups first, never one that is a single control or always stays", () => {
		// 1320 px of groups: Clipboard collapses first (priority 3; Editing, priority 2, is one control).
		expect(states(1240, true)).toMatchObject({
			clipboard: "collapsed",
			paragraph: "full",
			font: "full",
			styles: "full",
			editing: "full"
		})
		expect(states(1000, true)).toMatchObject({ clipboard: "collapsed", paragraph: "collapsed", font: "full", formatting: "full" })
		expect(states(800, true)).toMatchObject({ font: "collapsed", formatting: "full", undo: "full", styles: "full" })
	})

	it("moves groups into the overflow menu once collapsing is not enough, collapsed ones too", () => {
		// 492 px with every group collapsed that can: room for all at 500, not at 400.
		expect(Object.values(states(500, true))).not.toContain("overflow")
		expect(states(400, true)).toEqual({
			undo: "full",
			clipboard: "overflow",
			font: "collapsed",
			formatting: "collapsed",
			paragraph: "collapsed",
			styles: "overflow",
			editing: "overflow"
		})
	})

	it("overflows straight away on a phone, keeping the groups that matter most in the row", () => {
		const phone = states(360 - 16, false)

		expect(Object.values(phone)).not.toContain("collapsed")
		expect(phone).toMatchObject({ undo: "full", formatting: "full", font: "overflow", paragraph: "overflow", editing: "overflow" })
	})

	it("never moves a group that always stays, however narrow", () => {
		expect(states(10, true)["undo"]).toBe("full")
		expect(states(10, false)["undo"]).toBe("full")
	})
})
