import { describe, expect, it } from "vitest"
import { DEFAULT_SMARTART_BUDGETS, SmartArtError, type SmartArtBudgets } from "../core/smartart/data"
import type { DiagramLayout, LayoutNode } from "../core/smartart/interp"
import { budget, cpuMs } from "./timing"
import { data, layout, model, MM, run, type PointSpec } from "./smartartFixtures"

// Hostile and random layout definitions and data models: every SmartArt budget (plan §1.12: points, layout nodes,
// forEach nesting, constraint passes, rule steps) either refuses with a typed SmartArtError or bounds the work, and
// whatever lays out has finite boxes.

function finite(result: DiagramLayout): boolean {
	const stack: LayoutNode[] = [result.root]

	while (stack.length > 0) {
		const node = stack.pop() as LayoutNode
		const { x, y, w, h } = node.box

		if (![x, y, w, h].every(Number.isFinite)) return false

		stack.push(...node.children)
	}

	return result.shapes.every(s => [s.box.x, s.box.y, s.box.w, s.box.h].every(Number.isFinite))
}

function nodes(count: number, depth = 1): PointSpec[] {
	const out: PointSpec[] = []

	for (let i = 0; i < count; i++)
		out.push({ id: `n${i}`, text: `Node ${i}`, parent: depth > 1 && i > 0 ? `n${Math.floor((i - 1) / 3)}` : undefined })

	return out
}

describe("SmartArt budgets", () => {
	it("refuses a data model with more points than the budget", () => {
		expect(() => model(data(nodes(2000)))).toThrow(expect.objectContaining({ reason: "tooLarge" }))
	})

	it("refuses an expansion past the layout node budget, however the forEach multiplies", () => {
		// Each forEach level iterates every descendant again: 30 points nested 4 deep is 30^4 layout nodes.
		let body = '<dgm:layoutNode name="leaf"><dgm:shape type="rect"/></dgm:layoutNode>'

		for (let i = 0; i < 4; i++) body = `<dgm:forEach name="f${i}" axis="root des" ptType="all all">${body}</dgm:forEach>`

		const start = cpuMs()

		expect(() => run(data(nodes(30)), layout(body), MM, MM)).toThrow(expect.objectContaining({ reason: "tooLarge" }))
		expect(cpuMs() - start).toBeLessThan(budget(2000))
	})

	it("refuses forEach nesting deeper than the budget", () => {
		let body = '<dgm:layoutNode name="leaf"/>'

		for (let i = 0; i < 40; i++) body = `<dgm:forEach name="f${i}" axis="self">${body}</dgm:forEach>`

		expect(() => run(data(nodes(3)), layout(body), MM, MM)).toThrow(expect.objectContaining({ reason: "tooDeep" }))
	})

	it("ends a chain of constraints that never resolves within the pass budget", () => {
		// a.w reads b.w, b.w reads c.w, … and the last reads the first: nothing is ever known.
		const names = Array.from({ length: 200 }, (_, i) => `c${i}`)
		const constraints = names
			.map(
				(name, i) =>
					`<dgm:constr type="w" for="ch" forName="${name}" refType="w" refFor="ch" refForName="${names[(i + 1) % names.length]}"/>`
			)
			.join("")
		const children = names.map(name => `<dgm:layoutNode name="${name}"><dgm:shape type="rect"/></dgm:layoutNode>`).join("")
		const result = run(
			data(nodes(3)),
			layout(`<dgm:alg type="composite"/><dgm:constrLst>${constraints}</dgm:constrLst>${children}`),
			MM,
			MM
		)

		expect(finite(result)).toBe(true)
	})

	it("stops relaxing rules at the rule step budget", () => {
		const xml =
			layout(`<dgm:alg type="lin"/><dgm:constrLst><dgm:constr type="primFontSz" for="ch" forName="t" val="200"/></dgm:constrLst>
			<dgm:ruleLst><dgm:rule type="w" for="ch" forName="t" val="INF"/><dgm:rule type="h" for="ch" forName="t" val="INF"/>
			<dgm:rule type="primFontSz" for="ch" forName="t" val="0.5"/></dgm:ruleLst>
			<dgm:forEach name="f" axis="ch" ptType="node"><dgm:layoutNode name="t"><dgm:alg type="tx"/><dgm:shape type="rect"/>
			<dgm:presOf axis="self"/><dgm:ruleLst><dgm:rule type="w" val="0"/><dgm:rule type="h" fact="2"/></dgm:ruleLst></dgm:layoutNode></dgm:forEach>`)

		for (const maxRuleSteps of [0, 1, 7, 200]) {
			const budgets: SmartArtBudgets = { ...DEFAULT_SMARTART_BUDGETS, maxRuleSteps }
			const result = run(data(nodes(30)), xml, 10 * MM, 10 * MM, { budgets })

			expect(result.ruleSteps).toBeLessThanOrEqual(maxRuleSteps)
			expect(finite(result)).toBe(true)
		}
	})
})

// A small deterministic generator (mulberry32): the same seeds give the same cases on every run.
function random(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = state

		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const ALGS = ["composite", "lin", "snake", "tx", "sp", "cycle", "hierRoot", "conn", "pyra", "bogus"]
const TYPES = ["w", "h", "l", "t", "r", "b", "ctrX", "ctrY", "wOff", "lOff", "sp", "primFontSz", "secFontSz", "tMarg", "userA", "connDist"]
const RELS = ["self", "ch", "des"]
const OPS = ["none", "equ", "lte", "gte"]
const VALUES = ["0", "1", "-5", "40", "INF", "-INF", "NaN", "1e308", "-1e308", "0.5"]
const AXES = ["ch", "des", "self", "par", "root", "followSib", "precedSib", "follow", "preced", "ancst", "desOrSelf", "none", "ch ch"]
const PARAMS = [
	["linDir", ["fromL", "fromR", "fromT", "fromB"]],
	["flowDir", ["row", "col"]],
	["grDir", ["tL", "tR", "bL", "bR"]],
	["contDir", ["sameDir", "revDir"]],
	["bkpt", ["endCnv", "bal", "fixed"]],
	["bkPtFixedVal", ["0", "-3", "1", "1000"]],
	["off", ["ctr", "off"]]
] as const

function pick<T>(next: () => number, list: readonly T[]): T {
	return list[Math.floor(next() * list.length)] as T
}

function generate(next: () => number, names: readonly string[], depth: number): string {
	let body = ""
	const alg = pick(next, ALGS)
	let params = ""

	for (const [name, values] of PARAMS) if (next() < 0.3) params += `<dgm:param type="${name}" val="${pick(next, values)}"/>`

	body += `<dgm:alg type="${alg}">${params}</dgm:alg><dgm:shape type="${pick(next, ["rect", "none", "conn", "ellipse"])}" rot="${pick(next, ["0", "90", "-45"])}" zOrderOff="${pick(next, ["0", "-3", "5"])}"/>`
	body += `<dgm:presOf axis="${pick(next, AXES)}" ptType="${pick(next, ["all", "node", "sibTrans"])}"/>`

	let constraints = ""

	for (let i = Math.floor(next() * 8); i > 0; i--) {
		const ref = next() < 0.6 ? ` refType="${pick(next, TYPES)}" refFor="${pick(next, RELS)}" refForName="${pick(next, names)}"` : ""

		constraints += `<dgm:constr type="${pick(next, TYPES)}" for="${pick(next, RELS)}" forName="${next() < 0.3 ? "" : pick(next, names)}" op="${pick(next, OPS)}" val="${pick(next, VALUES)}" fact="${pick(next, VALUES)}"${ref}/>`
	}

	let rules = ""

	for (let i = Math.floor(next() * 3); i > 0; i--) {
		rules += `<dgm:rule type="${pick(next, TYPES)}" for="${pick(next, RELS)}" forName="${next() < 0.5 ? "" : pick(next, names)}" val="${pick(next, VALUES)}" fact="${pick(next, VALUES)}" max="${pick(next, VALUES)}"/>`
	}

	body += `<dgm:constrLst>${constraints}</dgm:constrLst><dgm:ruleLst>${rules}</dgm:ruleLst>`

	if (depth < 4) {
		for (let i = 1 + Math.floor(next() * 3); i > 0; i--) {
			const child = `<dgm:layoutNode name="${pick(next, names)}">${generate(next, names, depth + 1)}</dgm:layoutNode>`
			const roll = next()

			if (roll < 0.4)
				body += `<dgm:forEach name="f${depth}${i}" axis="${pick(next, AXES)}" ptType="${pick(next, ["all", "node", "sibTrans"])}" st="${pick(next, ["1", "-1", "2"])}" step="${pick(next, ["1", "-1", "2"])}">${child}</dgm:forEach>`
			else if (roll < 0.6)
				body += `<dgm:choose name="c${depth}${i}"><dgm:if name="i" axis="ch" ptType="node" func="${pick(next, ["cnt", "pos", "revPos", "depth", "maxDepth", "var", "posEven"])}" arg="dir" op="${pick(next, ["equ", "gt", "lte", "neq"])}" val="${pick(next, ["1", "2", "norm"])}">${child}</dgm:if><dgm:else name="e">${child}</dgm:else></dgm:choose>`
			else body += child
		}
	}

	return body
}

describe("SmartArt layout of random definitions", () => {
	it("refuses with a typed reason or lays out finite boxes within budget, for 300 random definitions", { timeout: 120_000 }, () => {
		const names = ["a", "b", "c", "node", "sibTrans", "text"]
		const reasons = new Map<string, number>()
		let worst = 0

		for (let seed = 1; seed <= 300; seed++) {
			const next = random(seed)
			const xml = layout(generate(next, names, 0))
			const count = 1 + Math.floor(next() * 12)
			const pres = Array.from({ length: 4 }, (_, i) => ({
				id: `p${i}`,
				prSet: `presName="${pick(next, names)}" presAssocID="n${i}" custScaleX="${pick(next, ["50000", "200000", "-100000", "0"])}" custLinFactNeighborY="${pick(next, ["0", "900000", "-90000"])}"`
			}))
			const start = cpuMs()

			try {
				const result = run(data(nodes(count, 2), pres), xml, pick(next, [0, 1, 100 * MM, 1e9]), pick(next, [0, 50 * MM, 1e9]))

				expect(finite(result), `seed ${seed}`).toBe(true)
				expect(result.ruleSteps).toBeLessThanOrEqual(DEFAULT_SMARTART_BUDGETS.maxRuleSteps)
			} catch (error) {
				if (!(error instanceof SmartArtError)) throw new Error(`seed ${seed}: ${String(error)}`)

				reasons.set(error.reason, (reasons.get(error.reason) ?? 0) + 1)
			}

			worst = Math.max(worst, cpuMs() - start)
		}

		expect(worst).toBeLessThan(budget(1000))
	})
})
