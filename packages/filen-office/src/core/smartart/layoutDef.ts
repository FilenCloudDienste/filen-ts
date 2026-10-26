import { D, drawingReader, type DrawingReader } from "../drawingml/reader"
import type { XmlDocument } from "../xml/index"
import { SmartArtError } from "./data"

// The layout definition (ECMA-376 §21.4.2) as a typed tree. Nothing is evaluated here: choose, forEach
// and the iterator attributes stay as written, for interp.ts to expand against a data model.

export type AlgorithmType = "composite" | "conn" | "cycle" | "hierChild" | "hierRoot" | "lin" | "pyra" | "snake" | "sp" | "tx" | "unknown"

export interface Algorithm {
	readonly type: AlgorithmType
	readonly params: ReadonlyMap<string, string>
}

// AG_IteratorAttributes (§21.4.2.14, L.4.15.6.3.17). Every attribute is a list: Office walks one step per
// entry, as nested iterations (MS-OI29500 §2.1.1618b). Missing entries take the defaults.
export interface IteratorStep {
	readonly axis: string
	readonly ptType: string
	readonly hideLastTrans: boolean
	readonly st: number
	readonly cnt: number
	readonly step: number
}

export interface Constraint {
	readonly type: string
	readonly for: "self" | "ch" | "des"
	readonly forName: string
	readonly ptType: string
	readonly refType: string
	readonly refFor: "self" | "ch" | "des"
	readonly refForName: string
	readonly refPtType: string
	readonly op: "none" | "equ" | "gte" | "lte"
	readonly val: number
	readonly fact: number
}

export interface Rule {
	readonly type: string
	readonly for: "self" | "ch" | "des"
	readonly forName: string
	readonly ptType: string
	readonly val: number
	readonly fact: number
	readonly max: number
}

export interface ShapeDef {
	readonly type: string
	readonly rot: number
	readonly hideGeom: boolean
	readonly zOrderOff: number
	readonly adj: readonly { readonly idx: number; readonly val: number }[]
}

// The parts a layoutNode, forEach, if or else may carry; the last of each kind seen wins when a
// branch is taken, like an assignment in document order.
export interface Body {
	readonly alg?: Algorithm | undefined
	readonly shape?: ShapeDef | undefined
	readonly presOf?: readonly IteratorStep[] | undefined
	readonly constraints?: readonly Constraint[] | undefined
	readonly rules?: readonly Rule[] | undefined
	readonly vars?: ReadonlyMap<string, string> | undefined
	readonly children: readonly Atom[]
}

export interface LayoutNodeDef extends Body {
	readonly kind: "layoutNode"
	readonly name: string
	readonly styleLbl?: string | undefined
	readonly chOrder: "b" | "t"
}

export interface ForEachDef extends Body {
	readonly kind: "forEach"
	readonly name: string
	readonly ref?: string | undefined
	readonly steps: readonly IteratorStep[]
}

export interface IfDef extends Body {
	readonly kind: "if"
	readonly steps: readonly IteratorStep[]
	readonly func: string
	readonly arg: string
	readonly op: string
	readonly val: string
}

export interface ElseDef extends Body {
	readonly kind: "else"
}

export interface ChooseDef {
	readonly kind: "choose"
	readonly branches: readonly IfDef[]
	readonly otherwise?: ElseDef | undefined
}

export type Atom = LayoutNodeDef | ForEachDef | ChooseDef

export interface LayoutDefinition {
	readonly uniqueId: string
	readonly root: LayoutNodeDef
	// forEach elements by name, for forEach@ref.
	readonly forEachByName: ReadonlyMap<string, ForEachDef>
}

const MAX_DEF_DEPTH = 256

function list(text: string | undefined): string[] {
	return text === undefined
		? []
		: text
				.trim()
				.split(/\s+/u)
				.filter(item => item !== "")
}

function toNumber(text: string | undefined, fallback: number): number {
	if (text === undefined) return fallback

	const trimmed = text.trim()

	if (trimmed === "INF") return Number.POSITIVE_INFINITY
	if (trimmed === "-INF") return Number.NEGATIVE_INFINITY
	if (trimmed === "NaN") return Number.NaN

	const value = Number(trimmed)

	return trimmed !== "" && !Number.isNaN(value) ? value : fallback
}

export function readSteps(reader: DrawingReader, node: number): IteratorStep[] {
	const axes = list(reader.attr(node, "axis"))
	const types = list(reader.attr(node, "ptType"))
	const hides = list(reader.attr(node, "hideLastTrans"))
	const sts = list(reader.attr(node, "st"))
	const cnts = list(reader.attr(node, "cnt"))
	const steps = list(reader.attr(node, "step"))
	const count = Math.max(axes.length, types.length, hides.length, sts.length, cnts.length, steps.length)
	const out: IteratorStep[] = []

	for (let i = 0; i < count; i++) {
		const hide = hides[i]

		out.push({
			axis: axes[i] ?? "none",
			ptType: types[i] ?? "all",
			hideLastTrans: hide === undefined ? true : hide === "1" || hide === "true",
			st: Math.trunc(toNumber(sts[i], 1)),
			cnt: Math.max(0, Math.trunc(toNumber(cnts[i], 0))),
			step: Math.trunc(toNumber(steps[i], 1))
		})
	}

	return out
}

function relationship(text: string | undefined): "self" | "ch" | "des" {
	return text === "ch" || text === "des" ? text : "self"
}

function operator(text: string | undefined): "none" | "equ" | "gte" | "lte" {
	return text === "equ" || text === "gte" || text === "lte" ? text : "none"
}

class DefReader {
	readonly forEachByName = new Map<string, ForEachDef>()

	readonly reader: DrawingReader

	constructor(reader: DrawingReader) {
		this.reader = reader
	}

	body(node: number, depth: number): Body {
		if (depth > MAX_DEF_DEPTH) throw new SmartArtError("tooDeep", "layout definition nested too deeply")

		const reader = this.reader
		const document = reader.document
		const children: Atom[] = []
		let alg: Algorithm | undefined
		let shape: ShapeDef | undefined
		let presOf: IteratorStep[] | undefined
		let constraints: Constraint[] | undefined
		let rules: Rule[] | undefined
		let vars: Map<string, string> | undefined

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (reader.group(child) !== D.Dgm) continue

			switch (document.localName(child)) {
				case "alg":
					alg = this.algorithm(child)
					break
				case "shape":
					shape = this.shape(child)
					break
				case "presOf":
					presOf = readSteps(reader, child)
					break
				case "constrLst":
					constraints = reader.children(child, D.Dgm, "constr").map(c => this.constraint(c))
					break
				case "ruleLst":
					rules = reader.children(child, D.Dgm, "rule").map(r => this.rule(r))
					break
				case "varLst":
					vars = new Map()

					for (let v = document.firstChildElement(child); v >= 0; v = document.nextSiblingElement(v)) {
						vars.set(document.localName(v), reader.attr(v, "val") ?? "")
					}

					break
				case "layoutNode":
					children.push(this.layoutNode(child, depth + 1))
					break
				case "forEach":
					children.push(this.forEach(child, depth + 1))
					break
				case "choose":
					children.push(this.choose(child, depth + 1))
					break
			}
		}

		return { alg, shape, presOf, constraints, rules, vars, children }
	}

	layoutNode(node: number, depth: number): LayoutNodeDef {
		const reader = this.reader

		return {
			kind: "layoutNode",
			name: reader.attr(node, "name") ?? "",
			styleLbl: reader.attr(node, "styleLbl"),
			chOrder: reader.attr(node, "chOrder") === "t" ? "t" : "b",
			...this.body(node, depth)
		}
	}

	forEach(node: number, depth: number): ForEachDef {
		const reader = this.reader
		const def: ForEachDef = {
			kind: "forEach",
			name: reader.attr(node, "name") ?? "",
			ref: reader.attr(node, "ref"),
			steps: readSteps(reader, node),
			...this.body(node, depth)
		}

		if (def.name !== "" && !this.forEachByName.has(def.name)) this.forEachByName.set(def.name, def)

		return def
	}

	choose(node: number, depth: number): ChooseDef {
		const reader = this.reader
		const branches: IfDef[] = []
		let otherwise: ElseDef | undefined

		for (const branch of reader.children(node, D.Dgm, "if")) {
			branches.push({
				kind: "if",
				steps: readSteps(reader, branch),
				func: reader.attr(branch, "func") ?? "",
				arg: reader.attr(branch, "arg") ?? "none",
				op: reader.attr(branch, "op") ?? "equ",
				val: reader.attr(branch, "val") ?? "",
				...this.body(branch, depth + 1)
			})
		}

		const other = reader.child(node, D.Dgm, "else")

		if (other >= 0) otherwise = { kind: "else", ...this.body(other, depth + 1) }

		return { kind: "choose", branches, otherwise }
	}

	algorithm(node: number): Algorithm {
		const reader = this.reader
		const params = new Map<string, string>()

		for (const param of reader.children(node, D.Dgm, "param")) {
			const type = reader.attr(param, "type")

			if (type !== undefined) params.set(type, reader.attr(param, "val") ?? "")
		}

		const type = reader.attr(node, "type") ?? "unknown"
		const known = ["composite", "conn", "cycle", "hierChild", "hierRoot", "lin", "pyra", "snake", "sp", "tx"]

		return { type: (known.includes(type) ? type : "unknown") as AlgorithmType, params }
	}

	shape(node: number): ShapeDef {
		const reader = this.reader

		return {
			type: reader.attr(node, "type") ?? "none",
			rot: toNumber(reader.attr(node, "rot"), 0),
			hideGeom: reader.bool(node, "hideGeom", false),
			zOrderOff: Math.trunc(toNumber(reader.attr(node, "zOrderOff"), 0)),
			adj: reader.children(reader.child(node, D.Dgm, "adjLst"), D.Dgm, "adj").map(adj => ({
				idx: Math.trunc(toNumber(reader.attr(adj, "idx"), 1)),
				val: toNumber(reader.attr(adj, "val"), 0)
			}))
		}
	}

	constraint(node: number): Constraint {
		const reader = this.reader

		return {
			type: reader.attr(node, "type") ?? "unknown",
			for: relationship(reader.attr(node, "for")),
			forName: reader.attr(node, "forName") ?? "",
			ptType: reader.attr(node, "ptType") ?? "all",
			refType: reader.attr(node, "refType") ?? "none",
			refFor: relationship(reader.attr(node, "refFor")),
			refForName: reader.attr(node, "refForName") ?? "",
			refPtType: reader.attr(node, "refPtType") ?? "all",
			op: operator(reader.attr(node, "op")),
			val: toNumber(reader.attr(node, "val"), 0),
			fact: toNumber(reader.attr(node, "fact"), 1)
		}
	}

	rule(node: number): Rule {
		const reader = this.reader

		return {
			type: reader.attr(node, "type") ?? "unknown",
			for: relationship(reader.attr(node, "for")),
			forName: reader.attr(node, "forName") ?? "",
			ptType: reader.attr(node, "ptType") ?? "all",
			val: toNumber(reader.attr(node, "val"), Number.NaN),
			fact: toNumber(reader.attr(node, "fact"), Number.NaN),
			max: toNumber(reader.attr(node, "max"), Number.NaN)
		}
	}
}

// Reads dgm:layoutDef; refuses without a root layoutNode.
export function parseLayoutDef(document: XmlDocument): LayoutDefinition {
	const reader = drawingReader(document)
	const root = document.documentElement()

	if (!reader.is(root, D.Dgm, "layoutDef")) throw new SmartArtError("malformed", "not a dgm:layoutDef")

	const node = reader.child(root, D.Dgm, "layoutNode")

	if (node < 0) throw new SmartArtError("malformed", "layoutDef without a layoutNode")

	const defs = new DefReader(reader)

	return { uniqueId: reader.attr(root, "uniqueId") ?? "", root: defs.layoutNode(node, 0), forEachByName: defs.forEachByName }
}
