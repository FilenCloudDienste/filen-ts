import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { LayerState, TimeNode, TimingTree } from "../core/anim/model"
import { compile, instantiate } from "../core/anim/timegraph"
import type { SlideNode } from "../core/presentation/model"
import { readTiming } from "../core/pptx/read/timing"
import { PartReader } from "../core/pptx/read/xml"
import { encodeUtf8, parseXml } from "../core/xml/index"
import { BUDGETS, animatedSlide, shape } from "./animFixtures"
import { freshFromPptx } from "./odpWriteFreshFixtures"
import { entriesOf, openOdpDeck, saveDeck, shapeNamed, slideAt, text, touched } from "./odpWriteFixtures"
import { buildPptx, sp, xfrm } from "./pptxFixtures"
import { budget } from "./timing"

// p:subTnLst after-effects through ODP. LibreOffice 7.5 plays an after-effect as an anim:set where it happens and names
// its master with presentation:master-element (ODF 1.3 allows that attribute on containers only, so the set is wrapped
// in a par carrying it): "hide after animation" in its master's par timed from the master's begin, "dim / hide on next
// mouse click" in the next click's first group, one with no next click waiting (begin indefinite) in its master.
// Converted from pptx, read back, saved again after an edit, they play in the timegraph as the pptx does.
// FILEN_OFFICE_AFTER_EFFECTS_OUT: a directory the converted package is written to (jing, odfvalidator, LibreOffice).

const OUT = process.env["FILEN_OFFICE_AFTER_EFFECTS_OUT"] || undefined
const RED = 0xff0000ff

function sub(id: number, spid: number, attribute: string, to: string, rel: "sameClick" | "nextClick", delay: number): string {
	return `<p:set><p:cBhvr override="childStyle"><p:cTn id="${String(id)}" dur="1" fill="hold" display="0" masterRel="${rel}" afterEffect="1"><p:stCondLst><p:cond delay="${String(delay)}"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${String(spid)}"/></p:tgtEl><p:attrNameLst><p:attrName>${attribute}</p:attrName></p:attrNameLst></p:cBhvr><p:to>${to}</p:to></p:set>`
}

function click(id: number, spid: number, subs: string): string {
	return (
		`<p:par><p:cTn id="${String(id)}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="${String(id + 1)}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
		`<p:par><p:cTn id="${String(id + 2)}" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
		`<p:set><p:cBhvr><p:cTn id="${String(id + 3)}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${String(spid)}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>` +
		`<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${String(id + 4)}" dur="500"/><p:tgtEl><p:spTgt spid="${String(spid)}"/></p:tgtEl></p:cBhvr></p:animEffect>` +
		`</p:childTnLst>${subs === "" ? "" : `<p:subTnLst>${subs}</p:subTnLst>`}</p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`
	)
}

// Four clicks: hide after animation, dim on next click, hide on next click, and a hide on next click with no next click.
const TIMING =
	'<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>' +
	click(10, 2, sub(15, 2, "style.visibility", '<p:strVal val="hidden"/>', "sameClick", 500)) +
	click(20, 3, sub(25, 3, "style.color", '<p:clrVal><a:srgbClr val="FF0000"/></p:clrVal>', "nextClick", 0)) +
	click(30, 4, sub(35, 4, "style.visibility", '<p:strVal val="hidden"/>', "nextClick", 0)) +
	click(40, 5, sub(45, 5, "style.visibility", '<p:strVal val="hidden"/>', "nextClick", 0)) +
	'</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
const NAMES = ["A", "B", "C", "D"]
const BOX = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="2563EB"/></a:solidFill>'

function pptxBytes(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes: NAMES.map((name, k) =>
					sp(k + 2, name, undefined, `${xfrm(914400 + k * 1828800, 914400, 1371600, 914400)}${BOX}`)
				).join(""),
				after: TIMING
			}
		]
	})
}

function pptxTiming(): TimingTree {
	const document = parseXml(
		encodeUtf8(
			`<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${TIMING}</p:sld>`
		)
	)
	const timing = readTiming({ reader: new PartReader(document), part: "s", epoch: 0, budgets: BUDGETS }, document.documentElement())

	if (timing === undefined) throw new Error("no timing")

	return timing
}

function subsOf(tree: TimingTree): TimeNode[] {
	const out: TimeNode[] = []
	const stack: TimeNode[] = [tree.root]

	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		out.push(...(node.ctn.subTnLst ?? []))
		stack.push(...node.ctn.children)
	}

	return out
}

// Visible and text colour per shape (in A..D order) over a fixed click script.
function play(tree: TimingTree, ids: readonly number[]): string[] {
	const t = instantiate(
		compile(
			animatedSlide(
				tree,
				ids.map(id => shape(id))
			),
			{ shapes: Int32Array.from(ids) },
			BUDGETS
		)
	)
	const frames: string[] = []
	const frame = (at: number): void => {
		const states = t.sample(at)

		frames.push(
			ids
				.map((_, k) => {
					const state: LayerState | undefined = states.find(entry => entry.layer === k)

					return `${state?.visible === false ? "-" : "+"}${state?.dom?.textColor === RED ? "r" : ""}`
				})
				.join(" ")
		)
	}

	t.fire({ kind: "slideBegin" }, 0)

	for (const [at, samples] of [
		[1000, [1000, 1499, 1501]],
		[3000, [3000, 3500]],
		[5000, [5000, 5600]],
		[7000, [7000, 7600]],
		[9000, [9000]]
	] as const) {
		t.fire({ kind: "next" }, at)

		for (const sample of samples) frame(sample)
	}

	t.fire({ kind: "prev" }, 9500)
	frame(9500)

	return frames
}

function odpIds(node: SlideNode): number[] {
	return NAMES.map(name => shapeNamed(node, name).id)
}

describe("after-effects through ODP", () => {
	it(
		"converts pptx after-effects to anim:set in a par naming its master, reads them back and plays them as the pptx",
		{ timeout: budget(60_000) },
		async () => {
			const fresh = await freshFromPptx(pptxBytes())

			if ("kind" in fresh) throw new Error(fresh.reason)
			if (OUT !== undefined) writeFileSync(join(OUT, "after-effects.odp"), fresh.bytes)

			const content = text((await entriesOf(fresh.bytes)).get("content.xml"))

			// Hide after: in its master's par, 0.5 s from its begin; dim and hide on next click: in the next click's group;
			// the last (no next click): in its master, waiting.
			expect(content.match(/presentation:master-element="/gu)?.length).toBe(4)
			expect(content).toMatch(
				/<anim:par smil:fill="hold" presentation:master-element="[^"]+"><anim:set smil:begin="0\.5s"[^>]*smil:attributeName="visibility"[^>]*smil:to="hidden"/u
			)
			expect(content).toMatch(/<anim:par smil:begin="indefinite" smil:fill="hold" presentation:master-element="[^"]+"><anim:set /u)

			const opened = await openOdpDeck(fresh.bytes)
			const node = slideAt(opened, 0)
			const odp = node.timing

			if (odp === undefined) throw new Error("no ODP timing")

			// Each read back under its master: one from the master's begin, three at a click.
			expect(
				subsOf(odp)
					.map(entry => entry.ctn.masterRel ?? "")
					.sort()
			).toEqual(["nextClick", "nextClick", "nextClick", "sameClick"])

			const expected = play(pptxTiming(), [2, 3, 4, 5])

			// A hides 0.5 s after its click; B dims and C hides with the click after theirs; D's hide comes with the click
			// past the last step, which previous takes back.
			expect(expected).toEqual([
				"+ - - -",
				"+ - - -",
				"- - - -",
				"- + - -",
				"- + - -",
				"- +r + -",
				"- +r + -",
				"- +r - +",
				"- +r - +",
				"- +r - -",
				"- +r - +"
			])
			expect(play(odp, odpIds(node))).toEqual(expected)

			// Saved again after editing A's and C's fades (A's par holds its hide, C's click group B's dim): the
			// after-effects stay where they are, read the same, and the next save is unchanged.
			touched(node)

			// The fade of the entrance on the shape named `name`.
			const fadeOf = (name: string): TimeNode | undefined => {
				const id = shapeNamed(node, name).id
				const stack: TimeNode[] = [odp.root]

				for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
					const fade = at.ctn.children.find(
						child =>
							child.kind === "behavior" &&
							child.behavior.type === "animEffect" &&
							child.behavior.common.target.kind === "shape" &&
							child.behavior.common.target.shape === id
					)

					if (fade !== undefined && at.ctn.presetClass === "entr") return fade

					stack.push(...at.ctn.children)
				}

				return undefined
			}
			const a = fadeOf("A")
			const c = fadeOf("C")

			if (a === undefined || c === undefined) throw new Error("no fades")

			a.ctn.dur = 600
			c.ctn.dur = 600

			const saved = await saveDeck(opened)

			expect(saved.outcome.kind).toBe("written")

			if (OUT !== undefined) writeFileSync(join(OUT, "after-effects-saved.odp"), saved.bytes)
			expect(text((await entriesOf(saved.bytes)).get("content.xml"))).toContain('smil:dur="0.6s"')

			const reopened = await openOdpDeck(saved.bytes)
			const again = slideAt(reopened, 0)

			expect(again.timing === undefined ? 0 : subsOf(again.timing).length).toBe(4)
			expect(again.timing === undefined ? [] : play(again.timing, odpIds(again))).toEqual(expected)
			expect((await saveDeck(reopened)).outcome.kind).toBe("unchanged")
		}
	)
})
