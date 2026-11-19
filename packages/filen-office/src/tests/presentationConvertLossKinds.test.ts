import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ConversionReport, noteFresh } from "../core/convert/presentation/index"
import type { ConversionLossKind } from "../core/convert/presentation/report"

// What a Save as ODP reports by kind: each thing the ODP writer writes in a nearer form or leaves out is counted under
// the loss the user is told about.

const FRESH = fileURLToPath(new URL("../core/odp/write/fresh.ts", import.meta.url))

// Every string the fresh writer counts under, as its source spells it, with the kind it is reported as. A template
// carries an instance of what it writes; a variable (`what`, `shape.kind`) is counted from elsewhere or listed below.
const LITERALS: Readonly<Record<string, ConversionLossKind>> = {
	"animation triggered by a bookmark, started on click instead": "bookmarkTrigger",
	background: "background",
	chart: "chartDetail",
	"notes body placeholder written as a shape": "geometry",
	"placeholder written as a shape": "geometry",
	"shape without a box": "geometry",
	"transparent cell fill": "fill",
	"action hover": "action",
	"animation of a shape not written": "animation",
	"mirrored group": "shape",
	"picture fill": "fill",
	picture: "picture",
	transition: "transition",
	"bullet of more than one character": "text",
	"bullet size in points": "text",
	"dashed line": "line",
	"gradient fill": "fill",
	"line-breaking rules": "text",
	"media frame": "media",
	"outline level of a paragraph without a bullet": "outlineLevel",
	"outline unread": "geometry",
	"pattern fill": "fill",
	"picture bullet": "text",
	"run kept as its source": "text",
	"spacing in percent of a line": "text",
	"table style": "tableStyle",
	"group fill": "fill",
	"table frame without a box": "shape"
}

const TEMPLATES: Readonly<Record<string, readonly (readonly [string, ConversionLossKind])[]>> = {
	"action ${click.kind}": [["action customShow", "action"]],
	"action ${link.kind}": [["action program", "action"]],
	"action (${common.listeners.detail ?? common.listeners.reason})": [["action (unsafe)", "action"]],
	"shape (${pieces.detail ?? pieces.reason})": [["shape (unsupported)", "shape"]],
	'${shape.frame?.kind ?? "ole"} frame': [
		["ole frame", "oleObject"],
		["media frame", "media"]
	],
	"${shape.frame.kind} frame": [
		["chart frame", "chart"],
		["smartart frame", "smartArt"],
		["ole frame", "oleObject"],
		["media frame", "media"]
	],
	"compound line ${value.compound}": [["compound line dbl", "line"]],
	"numbering ${bullet.scheme}": [["numbering hebrew2Minus", "numbering"]],
	'outline ${geometry.kind === "preset" ? geometry.preset : "custom"}': [
		["outline star5", "geometry"],
		["outline custom", "geometry"]
	],
	"vertical ${body.vertical}": [["vertical wordArtVert", "text"]]
}

const VARIABLES: Readonly<Record<string, readonly (readonly [string, ConversionLossKind])[]>> = {
	"shape.kind": [
		["ink", "ink"],
		["opaque", "shape"]
	],
	what: []
}

function kindOf(what: string): ConversionLossKind | undefined {
	const report = new ConversionReport()

	noteFresh(report, { approximated: { [what]: 1 }, omitted: {} })

	return report.losses()[0]?.kind
}

describe("the losses a Save as ODP reports", () => {
	it("counts a paragraph's outline level as an outline level, not as a shape's outline", () => {
		const report = new ConversionReport()

		noteFresh(report, {
			approximated: { "outline level of a paragraph without a bullet": 3, "outline unread": 1 },
			omitted: {}
		})

		expect(report.losses()).toEqual([
			{ kind: "geometry", count: 1 },
			{ kind: "outlineLevel", count: 3 }
		])
	})

	it("reports a shape the writer kept in a nearer form as drawn in its nearest form, not as left out", () => {
		for (const what of ["shape without a box", "placeholder written as a shape", "notes body placeholder written as a shape"])
			expect(kindOf(what)).toBe("geometry")
	})

	it("knows the kind of every string the fresh writer counts under", () => {
		const source = readFileSync(FRESH, "utf8")
		const calls = [...source.matchAll(/count\((?:this\.)?report\.(?:approximated|omitted),\s*("[^"]*"|`[^`]*`|[\w.]+)\)/gu)].map(
			match => match[1] ?? ""
		)
		const literals = new Set<string>()
		const templates = new Set<string>()
		const variables = new Set<string>()

		for (const call of calls)
			if (call.startsWith('"')) literals.add(call.slice(1, -1))
			else if (call.startsWith("`")) templates.add(call.slice(1, -1))
			else variables.add(call)

		expect(calls.length).toBeGreaterThan(40)
		expect([...literals].sort()).toEqual(Object.keys(LITERALS).sort())
		expect([...templates].sort()).toEqual(Object.keys(TEMPLATES).sort())
		expect([...variables].sort()).toEqual(Object.keys(VARIABLES).sort())

		for (const [what, kind] of Object.entries(LITERALS)) expect([what, kindOf(what)]).toEqual([what, kind])

		for (const instances of [...Object.values(TEMPLATES), ...Object.values(VARIABLES)])
			for (const [what, kind] of instances) expect([what, kindOf(what)]).toEqual([what, kind])
	})
})
