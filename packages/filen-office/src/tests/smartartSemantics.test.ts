import { describe, expect, it } from "vitest"
import { data, layout, presented, run, type PointSpec } from "./smartartFixtures"

// Iteration, conditions and functions of the layout definition (ECMA-376 §21.4.2.14 forEach, §21.4.2.6 choose,
// §21.4.2.12 if, §21.4.7.6 ST_AxisType, §21.4.7.27 ST_ElementType, §21.4.7.33 ST_FunctionType, MS-OI29500
// §2.1.1618), observed through the points each laid-out shape presents.

// doc → a (a1, a2), b (b1), c; every node has its parent and sibling transitions.
const TREE: PointSpec[] = [
	{ id: "a" },
	{ id: "b" },
	{ id: "c" },
	{ id: "a1", parent: "a" },
	{ id: "a2", parent: "a" },
	{ id: "b1", parent: "b" }
]

const SHAPE = '<dgm:layoutNode name="x"><dgm:shape type="rect"/><dgm:presOf axis="self" hideLastTrans="0"/></dgm:layoutNode>'

function iterate(attributes: string, nodes: readonly PointSpec[] = TREE): string[] {
	return presented(run(data(nodes), layout(`<dgm:forEach name="f" ${attributes}>${SHAPE}</dgm:forEach>`), 100, 100))
}

// The shapes a choose produces: one named after the branch taken.
function branch(choose: string, nodes: readonly PointSpec[] = TREE, extra: readonly PointSpec[] = []): string[] {
	return run(data(nodes, extra), layout(choose), 100, 100).shapes.map(s => s.name)
}

function ifBranch(attributes: string): string {
	return `<dgm:choose name="c"><dgm:if name="i" ${attributes}><dgm:layoutNode name="yes"><dgm:shape type="rect"/></dgm:layoutNode></dgm:if>
		<dgm:else name="e"><dgm:layoutNode name="no"><dgm:shape type="rect"/></dgm:layoutNode></dgm:else></dgm:choose>`
}

describe("SmartArt axes (ST_AxisType)", () => {
	it.each([
		["ch nodes", 'axis="ch" ptType="node"', ["a", "b", "c"]],
		["ch every point, the last sibling transition hidden", 'axis="ch"', ["ap", "a", "as", "bp", "b", "bs", "cp", "c"]],
		["ch with hideLastTrans off", 'axis="ch" hideLastTrans="0"', ["ap", "a", "as", "bp", "b", "bs", "cp", "c", "cs"]],
		["des in document order", 'axis="des" ptType="node"', ["a", "a1", "a2", "b", "b1", "c"]],
		["desOrSelf", 'axis="desOrSelf" ptType="doc"', ["doc"]],
		["self", 'axis="self"', ["doc"]],
		["root", 'axis="ch ch root" ptType="node node all"', ["doc", "doc", "doc"]],
		["par", 'axis="ch ch par" ptType="node node all"', ["a", "a", "b"]],
		["ancst up to the root", 'axis="ch ch ancst" ptType="node node all"', ["a", "doc", "a", "doc", "b", "doc"]],
		["ancstOrSelf", 'axis="ch ch ancstOrSelf" ptType="node node all" cnt="1 1 2"', ["a1", "a"]],
		["followSib: later peers only", 'axis="ch followSib" ptType="node node"', ["b", "c", "c"]],
		["follow: later peers and their descendants", 'axis="ch follow" ptType="node node"', ["b", "b1", "c", "c"]],
		["precedSib: earlier peers, nearest first", 'axis="ch precedSib" ptType="node node" st="3 1"', ["b", "a"]],
		["preced: earlier peers and their descendants", 'axis="ch preced" ptType="node node" st="3 1"', ["b", "b1", "a", "a1", "a2"]],
		["none selects nothing", 'axis="none"', []]
	])("%s", (_name, attributes, expected) => {
		expect(iterate(attributes)).toEqual(expected)
	})
})

describe("SmartArt point types (ST_ElementType)", () => {
	const withAssistant: PointSpec[] = [{ id: "a" }, { id: "b", type: "asst" }, { id: "c" }]

	it.each([
		["node: normal and assistant nodes", "node", ["a", "b", "c"]],
		["norm: normal nodes only", "norm", ["a", "c"]],
		["asst", "asst", ["b"]],
		["nonAsst: everything but assistants", "nonAsst", ["ap", "a", "as", "bp", "bs", "cp", "c"]],
		["nonNorm: everything but normal nodes", "nonNorm", ["ap", "as", "bp", "b", "bs", "cp"]],
		["parTrans", "parTrans", ["ap", "bp", "cp"]],
		["sibTrans, the last hidden", "sibTrans", ["as", "bs"]]
	])("%s", (_name, ptType, expected) => {
		expect(iterate(`axis="ch" ptType="${ptType}"`, withAssistant)).toEqual(expected)
	})
})

describe("SmartArt iteration attributes", () => {
	it.each([
		["st starts at a 1-based position", 'st="2"', ["b", "c"]],
		["a negative st counts from the end", 'st="-1"', ["c"]],
		["step skips", 'step="2"', ["a", "c"]],
		["cnt bounds the count", 'cnt="2"', ["a", "b"]],
		["a negative step walks backwards", 'st="-1" step="-1"', ["c", "b", "a"]],
		["step 0 walks forward", 'step="0"', ["a", "b", "c"]]
	])("%s", (_name, attributes, expected) => {
		expect(iterate(`axis="ch" ptType="node" ${attributes}`)).toEqual(expected)
	})

	it("walks one step per list entry, as nested iterations (MS-OI29500 §2.1.1618b)", () => {
		expect(iterate('axis="ch ch" ptType="node node"')).toEqual(["a1", "a2", "b1"])
		expect(iterate('axis="ch ch" ptType="node node" st="2 1" cnt="0 1"')).toEqual(["b1"])
	})

	it("repeats a named forEach through ref, with the referencing forEach's own iterator", () => {
		const xml = layout(`<dgm:forEach name="top" axis="ch" ptType="node" cnt="1">${SHAPE}</dgm:forEach>
			<dgm:forEach name="again" ref="top"/><dgm:forEach name="mine" ref="top" axis="ch" ptType="node" st="3"/>`)

		expect(presented(run(data(TREE), xml, 100, 100))).toEqual(["a", "a", "c"])
	})

	it("lays out nested forEach bodies against each selected point", () => {
		const xml = layout(`<dgm:forEach name="o" axis="ch" ptType="node"><dgm:layoutNode name="outer"><dgm:shape type="rect"/>
			<dgm:presOf axis="self"/><dgm:forEach name="i" axis="ch" ptType="node">${SHAPE}</dgm:forEach></dgm:layoutNode></dgm:forEach>`)

		expect(presented(run(data(TREE), xml, 100, 100))).toEqual(["a", "a1", "a2", "b", "b1", "c"])
	})
})

describe("SmartArt conditions and functions (ST_FunctionType)", () => {
	it("takes the first branch whose condition holds, else the else branch", () => {
		const choose = `<dgm:choose name="c">
			<dgm:if name="i1" axis="ch" ptType="node" func="cnt" op="gt" val="5"><dgm:layoutNode name="many"><dgm:shape type="rect"/></dgm:layoutNode></dgm:if>
			<dgm:if name="i2" axis="ch" ptType="node" func="cnt" op="gte" val="3"><dgm:layoutNode name="three"><dgm:shape type="rect"/></dgm:layoutNode></dgm:if>
			<dgm:if name="i3" axis="ch" ptType="node" func="cnt" op="gte" val="1"><dgm:layoutNode name="some"><dgm:shape type="rect"/></dgm:layoutNode></dgm:if>
			<dgm:else name="e"><dgm:layoutNode name="none"><dgm:shape type="rect"/></dgm:layoutNode></dgm:else></dgm:choose>`

		expect(branch(choose)).toEqual(["three"])
		expect(branch(choose, [{ id: "a" }])).toEqual(["some"])
		expect(branch(choose, [])).toEqual(["none"])
	})

	it.each([
		["cnt equ", 'axis="ch" ptType="node" func="cnt" op="equ" val="3"', "yes"],
		["cnt neq", 'axis="ch" ptType="node" func="cnt" op="neq" val="3"', "no"],
		["cnt lt", 'axis="ch" ptType="node" func="cnt" op="lt" val="4"', "yes"],
		["cnt lte", 'axis="ch" ptType="node" func="cnt" op="lte" val="2"', "no"],
		["cnt over descendants", 'axis="des" ptType="node" func="cnt" op="equ" val="6"', "yes"],
		["depth of the doc point is 0", 'func="depth" op="equ" val="0"', "yes"],
		["maxDepth below the doc point", 'func="maxDepth" op="equ" val="2"', "yes"],
		["var falls back to the default dir", 'func="var" arg="dir" op="equ" val="norm"', "yes"],
		["var of an unknown name compares as empty", 'func="var" arg="mystery" op="equ" val="1"', "no"]
	])("%s", (_name, attributes, expected) => {
		expect(branch(ifBranch(attributes))).toEqual([expected])
	})

	it("counts pos, revPos, posEven and posOdd within the enclosing forEach", () => {
		const shapes = (func: string, val: string) =>
			presented(
				run(
					data(TREE),
					layout(`<dgm:forEach name="f" axis="ch" ptType="node"><dgm:choose name="c"><dgm:if name="i" func="${func}" op="equ" val="${val}">
						${SHAPE}</dgm:if></dgm:choose></dgm:forEach>`),
					100,
					100
				)
			)

		expect(shapes("pos", "2")).toEqual(["b"])
		expect(shapes("revPos", "1")).toEqual(["c"])
		expect(shapes("posEven", "1")).toEqual(["b"])
		expect(shapes("posOdd", "1")).toEqual(["a", "c"])
	})

	it("reads depth at the iterated point", () => {
		const xml =
			layout(`<dgm:forEach name="f" axis="des" ptType="node"><dgm:choose name="c"><dgm:if name="i" func="depth" op="equ" val="2">
			${SHAPE}</dgm:if></dgm:choose></dgm:forEach>`)

		expect(presented(run(data(TREE), xml, 100, 100))).toEqual(["a1", "a2", "b1"])
	})

	it("reads a variable from the root's presentation point in every nested layout node", () => {
		const nested = layout(
			`<dgm:varLst><dgm:dir/></dgm:varLst><dgm:layoutNode name="inner">${ifBranch('func="var" arg="dir" op="equ" val="rev"')}</dgm:layoutNode>`
		)
		const reversed = [{ id: "p", prSet: 'presName="root" presAssocID="doc"', vars: '<dgm:dir val="rev"/>' }]

		expect(run(data(TREE), nested, 100, 100).shapes.map(s => s.name)).toEqual(["no"])
		expect(run(data(TREE, reversed), nested, 100, 100).shapes.map(s => s.name)).toEqual(["yes"])
	})

	it("compares boolean variables as 1 and 0", () => {
		const xml = layout(
			`<dgm:varLst><dgm:bulletEnabled val="1"/></dgm:varLst>${ifBranch('func="var" arg="bulletEnabled" op="equ" val="true"')}`
		)

		expect(run(data(TREE), xml, 100, 100).shapes.map(s => s.name)).toEqual(["yes"])
	})
})
