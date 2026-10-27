import { describe, expect, it } from "vitest"
import type { TimeNode, TimingTree } from "../core/anim/model"
import { odpTargetId, odpTimingMarkup, presetFromOdf, presetToOdf, readOdpTiming } from "../core/anim/odf"
import { compile, instantiate } from "../core/anim/timegraph"
import { Fragment } from "../core/odp/read/context"
import type { EmitPiece } from "../core/pptx/write/types"
import type { ShapeNode } from "../core/presentation/model"
import { sameModel } from "../core/pptx/write/emit/shape"
import { Namespaces, decodeUtf8, encodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"
import { BUDGETS, animatedSlide } from "./animFixtures"
import { ODP_NS } from "./odpFixtures"

// ODF SMIL timing through core/anim/odf.ts: LibreOffice's tree read into the model, untouched timing as its source
// span, an edit rewriting only what changed, the model alone written back, and the preset table both ways.

const TRANSITION = '<anim:par smil:begin="0s"><anim:transitionFilter smil:dur="1s" smil:type="fade" smil:subtype="crossfade"/></anim:par>'
const MAIN =
	'<anim:seq smil:dur="indefinite" presentation:node-type="main-sequence">' +
	'<anim:par smil:begin="indefinite" smil:fill="hold"><anim:par smil:begin="0s" smil:fill="hold">' +
	'<anim:par smil:begin="0s" smil:fill="hold" presentation:node-type="on-click" presentation:preset-class="entrance" presentation:preset-id="ooo-entrance-fly-in" presentation:preset-sub-type="from-bottom" presentation:group-id="0">' +
	'<anim:set smil:begin="0s" smil:dur="0.001s" smil:fill="hold" smil:targetElement="id1" smil:attributeName="visibility" smil:to="visible"/>' +
	'<anim:animate smil:dur="0.5s" smil:fill="hold" smil:targetElement="id1" smil:attributeName="y" smil:values="1+height/2;y" smil:keyTimes="0;1"/>' +
	"</anim:par></anim:par>" +
	'<anim:par smil:begin="0.5s" smil:fill="hold"><anim:par smil:begin="0s" smil:fill="hold" presentation:node-type="after-previous" presentation:preset-class="emphasis" presentation:preset-id="ooo-emphasis-spin" loext:extra="kept">' +
	'<anim:animateTransform smil:dur="2s" smil:fill="hold" smil:targetElement="id1" smil:attributeName="transform" smil:by="360" svg:type="rotate"/>' +
	"</anim:par></anim:par></anim:par></anim:seq>"
const INTERACTIVE =
	'<anim:seq presentation:node-type="interactive-sequence"><anim:par smil:begin="id2.click"><anim:par smil:begin="0s">' +
	'<anim:par smil:begin="0s" smil:fill="hold" presentation:node-type="on-click" presentation:preset-class="exit" presentation:preset-id="ooo-exit-dissolve">' +
	'<anim:transitionFilter smil:dur="0.5s" smil:targetElement="id2" smil:type="dissolve" smil:mode="out"/>' +
	'<anim:set smil:begin="0.499s" smil:dur="0.001s" smil:fill="hold" smil:targetElement="id2" smil:attributeName="visibility" smil:to="hidden"/>' +
	"</anim:par></anim:par></anim:par></anim:seq>"
const ROOT = `<anim:par smil:dur="indefinite" smil:restart="never" presentation:node-type="timing-root">${TRANSITION}${MAIN}${INTERACTIVE}</anim:par>`
const FRAMES =
	'<draw:frame draw:id="id1" xml:id="id1" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box/></draw:frame>' +
	'<draw:frame draw:id="id2" xml:id="id2" svg:x="8cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box/></draw:frame>'

interface Page {
	readonly document: XmlDocument
	readonly fragment: Fragment
	readonly page: number
	readonly shapes: ShapeNode[]
}

function pageOf(timing: string): Page {
	const document = parseXml(
		encodeUtf8(`<office:fragment ${ODP_NS}><draw:page draw:name="p1">${FRAMES}${timing}</draw:page></office:fragment>`)
	)
	const fragment = new Fragment(document, new Namespaces(document, { lenient: true }), "content.xml", 100, "content", 0)
	const page = document.firstChildElement(document.documentElement())
	const shapes: ShapeNode[] = []
	let id = 1

	for (let child = document.firstChildElement(page); child >= 0; child = document.nextSiblingElement(child)) {
		if (fragment.name(child) === "draw:frame") shapes.push({ id: id++, name: "", hidden: false, kind: "sp", src: fragment.src(child) })
	}

	return { document, fragment, page, shapes }
}

function read(page: Page): TimingTree {
	const tree = readOdpTiming(page.fragment, page.page, page.shapes, BUDGETS)

	if (tree === undefined) throw new Error("no timing")

	return tree
}

function find(tree: TimingTree, test: (node: TimeNode) => boolean): TimeNode {
	const visit = (node: TimeNode): TimeNode | undefined =>
		test(node) ? node : node.ctn.children.map(visit).find(found => found !== undefined)
	const found = visit(tree.root)

	if (found === undefined) throw new Error("not found")

	return found
}

function text(page: Page | undefined, pieces: readonly EmitPiece[]): string {
	return pieces
		.map(piece =>
			typeof piece === "string"
				? piece
				: piece instanceof Uint8Array
					? decodeUtf8(piece)
					: decodeUtf8(page?.document.raw(piece.hole) ?? new Uint8Array())
		)
		.join("")
}

describe("ODF timing", () => {
	const source = pageOf(ROOT)

	it("reads LibreOffice's tree into the model: node types, presets, conditions, behaviours and the trigger", () => {
		const tree = read(source)
		const main = find(tree, node => node.ctn.nodeType === "mainSeq")
		const fly = find(tree, node => node.ctn.presetID === 2)

		expect(tree.root.ctn.nodeType).toBe("tmRoot")
		// The transition par is not an effect.
		expect(tree.root.ctn.children.map(child => child.ctn.nodeType)).toEqual(["mainSeq", "interactiveSeq"])
		expect(main.ctn.children[0]?.ctn.stCondLst).toEqual([{ delay: "indefinite" }])
		expect(fly.ctn).toMatchObject({ presetClass: "entr", presetSubtype: 4, nodeType: "clickEffect", grpId: 0 })
		expect(fly.ctn.children[1]).toMatchObject({
			kind: "behavior",
			behavior: {
				type: "anim",
				common: { attrNames: ["ppt_y"], target: { kind: "shape", shape: 1 } },
				tavLst: [
					{ tm: 0, val: "1+#ppt_h/2" },
					{ tm: 100000, val: "#ppt_y" }
				]
			},
			ctn: { dur: 500 }
		})
		expect(find(tree, node => node.kind === "behavior" && node.behavior.type === "animRot")).toMatchObject({
			behavior: { by: 21600000 },
			ctn: { dur: 2000 }
		})
		expect(find(tree, node => node.ctn.presetClass === "exit")).toMatchObject({ ctn: { presetID: 9 } })
		expect(find(tree, node => node.kind === "behavior" && node.behavior.type === "animEffect")).toMatchObject({
			behavior: { transition: "out", filter: "dissolve" }
		})
		expect(find(tree, node => node.ctn.nodeType === "interactiveSeq").ctn.children[0]?.ctn.stCondLst).toEqual([
			{ evt: "onClick", delay: 0, tgtEl: { kind: "shape", shape: 2 } }
		])
	})

	it("plays the read tree: one main step, and the trigger on the second shape", () => {
		const slide = animatedSlide(read(source), [])
		const graph = compile(slide, { shapes: Int32Array.of(1, 2) }, BUDGETS)
		const t = instantiate(graph)

		expect(graph.mainSteps).toBe(1)
		expect(graph.interactive.map(entry => entry.trigger.id)).toEqual([2])
		t.fire({ kind: "slideBegin" }, 0)
		expect(t.sample(0).find(state => state.layer === 0)?.visible).toBe(false)
		t.fire({ kind: "click", shape: 2 }, 100)
		expect(t.sample(1000).find(state => state.layer === 1)?.visible).toBe(false)
	})

	it("writes untouched timing as its source span", () => {
		const tree = read(source)
		const out = odpTimingMarkup({ fragment: source.fragment, shapes: source.shapes }, tree, read(source))

		expect(text(source, out)).toBe(ROOT)
	})

	it("rewrites only the edited node, keeping the transition par, unmodelled attributes and untouched siblings", () => {
		const edited = read(source)
		const spin = find(edited, node => node.ctn.presetID === 8)

		;(spin.ctn.children[0]?.ctn as { dur?: number }).dur = 3000
		delete spin.ctn.presetSubtype

		const out = text(source, odpTimingMarkup({ fragment: source.fragment, shapes: source.shapes }, edited, read(source)))

		expect(out).toContain(TRANSITION)
		expect(out).toContain(INTERACTIVE)
		expect(out).toContain('loext:extra="kept"')
		expect(out).toContain('smil:dur="3s"')
		expect(sameModel(read(pageOf(out)), edited)).toBe(true)
	})

	it("writes the model alone without a source, naming targets by their ids", () => {
		const tree = read(source)
		const out = text(undefined, odpTimingMarkup({ fragment: undefined, shapes: source.shapes }, tree, undefined))

		expect(odpTargetId(source.shapes[0] as ShapeNode)).toBe("id1")
		expect(sameModel(read(pageOf(out)), tree)).toBe(true)
	})

	it("keeps a begin token the model cannot hold, and declares a prefix the page does not bind", () => {
		const page = pageOf(
			'<anim:par xmlns:anim="urn:oasis:names:tc:opendocument:xmlns:animation:1.0" presentation:node-type="timing-root"><anim:par smil:begin="pid1.begin"/>' +
				MAIN +
				"</anim:par>"
		)
		const edited = read(page)

		edited.root.ctn.restart = "never"

		const out = text(page, odpTimingMarkup({ fragment: page.fragment, shapes: page.shapes }, edited, read(page)))

		expect(out).toContain('smil:begin="pid1.begin"')
		expect(out).toMatch(/^<anim:par[^>]* xmlns:anim="urn:oasis:names:tc:opendocument:xmlns:animation:1.0"/u)
		expect(out).toContain('smil:restart="never"')
	})

	it("keeps another application's preset names in the model and writes them back", () => {
		const own = MAIN.replace(
			'presentation:preset-id="ooo-emphasis-spin"',
			'presentation:preset-id="Whirlpool" presentation:preset-sub-type="Full Spin"'
		)
		const page = pageOf(`<anim:par presentation:node-type="timing-root">${own}</anim:par>`)
		const tree = read(page)
		const spin = find(tree, node => node.ctn.presetName !== undefined)

		expect(spin.ctn).toMatchObject({ presetClass: "emph", presetName: "Whirlpool", presetSubtypeName: "Full Spin" })
		expect(spin.ctn.presetID).toBeUndefined()

		const out = text(undefined, odpTimingMarkup({ fragment: undefined, shapes: page.shapes }, tree, undefined))

		expect(out).toContain('presentation:preset-id="Whirlpool" presentation:preset-sub-type="Full Spin"')
		expect(sameModel(read(pageOf(out)), tree)).toBe(true)
	})

	it("writes each preset attribute once when a node with another application's preset names is edited", () => {
		const own = MAIN.replace(
			'presentation:preset-id="ooo-emphasis-spin"',
			'presentation:preset-id="Whirlpool" presentation:preset-sub-type="Full Spin"'
		)
		const page = pageOf(`<anim:par presentation:node-type="timing-root">${own}</anim:par>`)
		const edited = read(page)
		const spin = find(edited, node => node.ctn.presetName !== undefined)

		;(spin.ctn as { dur?: number }).dur = 1500

		const out = text(page, odpTimingMarkup({ fragment: page.fragment, shapes: page.shapes }, edited, read(page)))

		expect(out.match(/presentation:preset-id=/gu)?.length).toBe(2)
		expect(out.match(/presentation:preset-sub-type=/gu)?.length).toBe(2)
		expect(out).toContain('presentation:preset-id="Whirlpool" presentation:preset-sub-type="Full Spin"')
		expect(sameModel(read(pageOf(out)), edited)).toBe(true)
	})

	it("maps ECMA presets to LibreOffice's names and back", () => {
		expect(presetToOdf("entr", 2, 4)).toEqual({ id: "ooo-entrance-fly-in", subtype: "from-bottom" })
		expect(presetToOdf("entr", 5, 10)).toEqual({ id: "ooo-entrance-checkerboard", subtype: "across" })
		expect(presetToOdf("emph", 6, 0)).toEqual({ id: "ooo-emphasis-grow-and-shrink" })
		expect(presetToOdf("path", 64, 0)).toEqual({ id: "ooo-motionpath-up" })
		expect(presetToOdf("entr", 33, 0)).toEqual({})
		expect(presetFromOdf("ooo-entrance-checkerboard", "across")).toEqual({ presetClass: "entr", id: 5, subtype: 10 })
		expect(presetFromOdf("ooo-exit-fly-out", "from-left")).toEqual({ presetClass: "exit", id: 2, subtype: 8 })
	})
})
