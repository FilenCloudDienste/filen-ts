import { CellError, EmptyValue, FunctionArgumentType, SimpleRangeValue, type ImplementedFunctions } from "hyperformula"
import { CALL_FUNCTION } from "../../functions/engineNames"
import { MAX_ARRAY_CELLS } from "../../refs/formulaRefs"
import {
	calcError,
	EvaluationSuspended,
	naError,
	numError,
	SheetFunctionPlugin,
	unwrap,
	valueError,
	type PluginAst,
	type PluginCall,
	type PluginScalar,
	type PluginState,
	type PluginValue
} from "./plugin"

// LET, LAMBDA and the functions that call a LAMBDA (MAP, REDUCE, SCAN, BYROW, BYCOL, MAKEARRAY, ISOMITTED), as
// support.microsoft.com defines them. A file stores the names these bind with the "_xlpm." prefix; the engine parses
// such a name as a defined name, which is looked up here first while the call that binds it is evaluated. A call of a
// bound LAMBDA (f(1), LAMBDA(x,x)(1)) reaches the engine as FILEN.CALL(f,1) (refs/formulaRefs.ts engineFormula).

// The prefix a file stores LET and LAMBDA names under ([MS-XLSX] 2.2.2: _xlpm.).
const PARAMETER = "_XLPM."

// An argument left out of a call (f(1,)), which ISOMITTED tells apart; read as an empty value.
const OMITTED = Symbol("omitted")

// A LAMBDA: its parameters (upper case, with the prefix), its calculation, and the names in scope where it was
// written (lexical scope: a name bound after it is not seen by it).
// A function named in a LAMBDA's place (BYROW(A1:B3,SUM)), which a file stores as _xleta.SUM: called with any number
// of values (eta).
export class Lambda {
	readonly params: readonly string[]
	readonly body: PluginAst
	readonly scope: Scope | null
	readonly eta: string | null
	// What it was written in, the same each time it is read (its syntax tree, or the defined name's cell whose tree
	// the engine may give anew): what tells calls apart (callKey).
	readonly origin: object

	constructor(params: readonly string[], body: PluginAst, scope: Scope | null, eta: string | null = null, origin: object = body) {
		this.params = params
		this.body = body
		this.scope = scope
		this.eta = eta
		this.origin = origin
	}

	// Whether it takes `count` values.
	takes(count: number): boolean {
		return this.eta !== null || this.params.length === count
	}
}

// The prefix a file stores a function named in a LAMBDA's place under.
const ETA = "_XLETA."

export type Bound = PluginValue | Lambda | typeof OMITTED

export interface Scope {
	readonly name: string
	readonly value: Bound
	readonly parent: Scope | null
}

// The names bound while a LET or a LAMBDA's calculation is evaluated (calculation is synchronous).
let scope: Scope | null = null

// LAMBDAs being calculated, one inside another, on the JavaScript stack.
let depth = 0

// Recursion (support.microsoft.com "LAMBDA function": "Excel can return a #NUM! error if there are too many recursive
// calls", with no number given). LAMBDA calls one inside another do not grow the JavaScript stack without end: once
// SUSPEND_AT expressions are being evaluated inside one another, the next call that is not known yet is set aside
// (Suspended, unwinding the stack) and calculated first from the bottom of the stack (drive), with its result kept for
// when the calls above it are calculated again. Calls are pure, so calculating one again gives what it gave. Every
// limit is counted, not a stack overflow, so a workbook calculates the same on every JavaScript engine:
// - MAX_LEVELS calls one inside another: the app's own number (Excel documents none), enough for recursion over a
//   cell's text (32,767 characters is past it: such recursion is #NUM!) or a list of a thousand rows;
// - MAX_NESTING expressions inside one another on the stack (a call that may not be set aside recurses there): under
//   the smallest stack the core runs on (a WebKit worker, about 240);
// - LAMBDA_STEPS expressions evaluated by one outermost call once it set a call aside: a bound on one cell's work,
//   the same whatever else recalculates with it.
// Past any of them: #NUM!. A call whose calculation may draw a random number (RAND, RANDBETWEEN, RANDARRAY, through
// the LAMBDAs and defined names it reads too: reachesVolatile) is never set aside nor its result kept, so each call
// draws its own as in Excel: it recurses on the stack, up to MAX_NESTING. The other volatile functions (NOW, TODAY,
// OFFSET, INDIRECT, CELL, INFO) give the same value for the same arguments within a calculation, so their calls are.
let nesting = 0
export const MAX_NESTING = 128
const SUSPEND_AT = 48
export const MAX_LEVELS = 1_024
export const LAMBDA_STEPS = 20_000

// LAMBDA calls one inside another, counted across those set aside.
let level = 0

// A call set aside, to calculate from the bottom of the stack: its key (callKey) and its level.
interface Pending {
	readonly lambda: Lambda
	readonly values: readonly Bound[]
	readonly key: string | null
	readonly level: number
}

// Thrown to unwind the stack to the drive under way (plugin.ts lets it through the functions it guards).
class Suspended extends EvaluationSuspended {
	readonly call: Pending

	constructor(call: Pending) {
		super()
		this.call = call
	}
}

// A call's result kept by its drive, with what it was called with (a key may be shared: sameCall tells them apart).
interface Known {
	readonly lambda: Lambda
	readonly values: readonly Bound[]
	readonly value: PluginValue
}

// The drive under way: the results of the calls set aside, by key; whether one was set aside, and the steps it may
// still take from then on (LAMBDA_STEPS).
let driving: { readonly results: Map<string, Known[]>; suspended: boolean; steps: number } | null = null

// Keys finding calls by what they calculate: a LAMBDA's calculation (its syntax tree), the names in its scope and the
// values it is called with, an array by a hash of its values (sameCall confirms a match). Null for a value of a kind
// not known here.
const astIds = new WeakMap<object, number>()
const lambdaKeys = new WeakMap<Lambda, string | null>()
const arrayKeys = new WeakMap<object, string | null>()

let nextAstId = 1

function astId(ast: object): number {
	const known = astIds.get(ast)

	if (known !== undefined) return known

	const id = nextAstId++

	astIds.set(ast, id)

	return id
}

function valueKey(value: Bound): string | null {
	if (value === OMITTED) return "o"
	if (value === EmptyValue) return "e"
	if (typeof value === "number") return `n${String(value)}`
	if (typeof value === "boolean") return value ? "t" : "f"
	if (typeof value === "string")
		return value.length <= SAMPLED ? `s${String(value.length)}:${value}` : `S${String(value.length)}:${sampledHash(value)}`
	if (value instanceof Lambda) return lambdaKey(value)
	if (value instanceof CellError) return `x${value.type}:${value.message ?? ""}`
	if (value instanceof SimpleRangeValue) {
		const range = value.range

		if (range !== undefined) return `r${range.sheet},${range.start.row},${range.start.col},${range.end.row},${range.end.col}`

		return arrayKey(value)
	}

	if (typeof value === "object" && "val" in value) return `v${value.constructor.name}${String(value.val)}`

	return null
}

// Keys read a long text or a large array in samples, so a key costs the same however large its value: its length (or
// size) and an FNV-1a hash of SAMPLED characters (cells) at each end and SAMPLED spread between. Keys only find
// candidates: sameCall compares the values whole before a result is taken.
const SAMPLED = 64

function fnv(hash: number, text: string): number {
	let next = hash

	for (let i = 0; i < text.length; i++) next = Math.imul(next ^ text.charCodeAt(i), 0x01000193)

	return Math.imul(next ^ 0x2c, 0x01000193)
}

// Hashes of long texts already sampled (a list's texts are keyed again each call that drops one), up to SAMPLED_KEPT,
// for one drive (it lets them go as it ends, keeping no text alive); the engine's own string hash makes finding one
// cheap.
const sampledHashes = new Map<string, string>()
const SAMPLED_KEPT = 4_096

function sampledHash(text: string): string {
	const known = sampledHashes.get(text)

	if (known !== undefined) return known
	if (sampledHashes.size >= SAMPLED_KEPT) sampledHashes.clear()

	const hash = sampleHash(text)

	sampledHashes.set(text, hash)

	return hash
}

function sampleHash(text: string): string {
	const step = Math.max(1, Math.floor((text.length - 2 * SAMPLED) / SAMPLED))
	let hash = fnv(fnv(0x811c9dc5, text.slice(0, SAMPLED)), text.slice(-SAMPLED))

	for (let at = SAMPLED; at < text.length - SAMPLED; at += step) hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193)

	return (hash >>> 0).toString(36)
}

// An array's size and a hash of its cells' keys (SAMPLED of them at each end and between in a large one), once per
// array.
function arrayKey(value: SimpleRangeValue): string | null {
	const known = arrayKeys.get(value)

	if (known !== undefined) return known

	const width = value.width()
	const count = value.height() * width
	const data = value.data
	const step = count <= 3 * SAMPLED ? 1 : Math.max(1, Math.floor((count - 2 * SAMPLED) / SAMPLED))
	let hash = 0x811c9dc5
	let key: string | null = `a${String(value.height())}x${String(width)}`

	for (
		let at = 0;
		at < count && key !== null;
		at = at < SAMPLED || at >= count - SAMPLED ? at + 1 : Math.min(at + step, count - SAMPLED)
	) {
		const part = valueKey(data[Math.floor(at / width)]?.[at % width] ?? EmptyValue)

		if (part === null) key = null
		else hash = fnv(hash, part)
	}

	if (key !== null) key = `${key}#${(hash >>> 0).toString(36)}`

	arrayKeys.set(value, key)

	return key
}

// Whether two values are the same, an array cell by cell.
function sameBound(a: Bound, b: Bound): boolean {
	if (a === b) return true
	if (a instanceof Lambda || b instanceof Lambda) return a instanceof Lambda && b instanceof Lambda && sameLambda(a, b)
	if (a instanceof CellError || b instanceof CellError)
		return a instanceof CellError && b instanceof CellError && a.type === b.type && a.message === b.message
	if (a instanceof SimpleRangeValue || b instanceof SimpleRangeValue) {
		if (!(a instanceof SimpleRangeValue && b instanceof SimpleRangeValue)) return false

		const ra = a.range
		const rb = b.range

		if (ra !== undefined || rb !== undefined)
			return (
				ra !== undefined &&
				rb !== undefined &&
				ra.sheet === rb.sheet &&
				ra.start.row === rb.start.row &&
				ra.start.col === rb.start.col &&
				ra.end.row === rb.end.row &&
				ra.end.col === rb.end.col
			)
		if (a.height() !== b.height() || a.width() !== b.width()) return false

		const da = a.data
		const db = b.data

		return da.every((row, r) => row.every((cell, c) => sameBound(cell, db[r]?.[c] ?? EmptyValue)))
	}

	if (typeof a === "object" && typeof b === "object" && a !== null && b !== null && "val" in a && "val" in b)
		return a.constructor === b.constructor && a.val === b.val

	return false
}

function sameLambda(a: Lambda, b: Lambda): boolean {
	if (a === b) return true
	if (a.origin !== b.origin || a.eta !== b.eta || a.params.join(",") !== b.params.join(",")) return false

	let x = a.scope
	let y = b.scope

	for (; x !== null && y !== null; x = x.parent, y = y.parent) if (x.name !== y.name || !sameBound(x.value, y.value)) return false

	return x === null && y === null
}

// Whether a call kept is the one asked for.
function sameCall(known: Known, lambda: Lambda, values: readonly Bound[]): boolean {
	return (
		sameLambda(known.lambda, lambda) &&
		known.values.length === values.length &&
		known.values.every((value, index) => sameBound(value, values[index] as Bound))
	)
}

function lambdaKey(lambda: Lambda): string | null {
	const known = lambdaKeys.get(lambda)

	if (known !== undefined) return known

	let key: string | null = `L${String(astId(lambda.origin))}${lambda.eta ?? ""}(${lambda.params.join(",")})`

	for (let at = lambda.scope; at !== null && key !== null; at = at.parent) {
		const value = valueKey(at.value)

		key = value === null ? null : `${key}${at.name}=${value};`
	}

	lambdaKeys.set(lambda, key)

	return key
}

function callKey(lambda: Lambda, values: readonly Bound[]): string | null {
	let key = lambdaKey(lambda)

	for (const value of values) {
		if (key === null) return null

		const part = valueKey(value)

		key = part === null ? null : `${key}|${part}`
	}

	return key
}

function lookup(name: string): Bound | undefined {
	for (let at = scope; at !== null; at = at.parent) if (at.name === name) return at.value

	return undefined
}

function within<T>(inner: Scope | null, work: () => T): T {
	const previous = scope

	scope = inner

	try {
		return work()
	} finally {
		scope = previous
	}
}

// The bound name an argument is (upper case), or null.
function nameOf(ast: PluginAst): string | null {
	const node = unwrap(ast)

	return node.type === ("NAMED_EXPRESSION" as PluginAst["type"]) && "expressionName" in node ? node.expressionName.toUpperCase() : null
}

function isCall(ast: PluginAst, name: string): ast is PluginAst & PluginCall {
	return ast.type === ("FUNCTION_CALL" as PluginAst["type"]) && "procedureName" in ast && ast.procedureName.toUpperCase() === name
}

const installed = new WeakSet<object>()

// Whether a syntax tree reaches a volatile function, and whether a LAMBDA's calls are pure (LambdaFunctions.pure).
const volatileAsts = new WeakMap<object, boolean>()
const pureLambdas = new WeakMap<Lambda, boolean>()

// The functions that draw a new value each time they are called, even with the same arguments in one calculation
// (support.microsoft.com "RAND function", "RANDBETWEEN function", "RANDARRAY function").
const DRAWING = new Set(["RAND", "RANDBETWEEN", "RANDARRAY"])

function volatileFunction(name: string): boolean {
	return DRAWING.has(name.replace(/^(?:_XLFN\.|_XLWS\.|_XLETA\.)+/i, "").toUpperCase())
}

// IF(condition, value_if_true, [value_if_false]) with only the branch the condition takes calculated (an empty one 0, a
// missing one FALSE), as it is: an array or range it gives is the result. Undefined where the engine's own IF is
// wanted: a condition that is an array (each of its values takes its own branch).
function ifBranch(ast: PluginCall, state: PluginState, evaluate: Evaluate): PluginValue | undefined {
	const [test, yes, no] = ast.args

	if (test === undefined || yes === undefined || ast.args.length > 3) return undefined

	const condition = evaluate(test, state)
	let taken: boolean

	if (condition instanceof CellError) return condition
	if (typeof condition === "boolean") taken = condition
	else if (typeof condition === "number") taken = condition !== 0
	else if (condition === EmptyValue) taken = false
	else if (typeof condition === "string") {
		const upper = condition.toUpperCase()

		// As the engine's IF reads text: empty text is FALSE.
		if (upper !== "TRUE" && upper !== "FALSE" && upper !== "") return valueError()

		taken = upper === "TRUE"
	} else if (typeof condition === "object" && "val" in condition) taken = condition.val !== 0
	else return undefined

	const branch = taken ? yes : no

	if (branch === undefined) return false
	if (branch.type === ("EMPTY" as PluginAst["type"])) return 0

	return evaluate(branch, state)
}

type Evaluate = (ast: PluginAst, state: PluginState) => PluginValue

// The engine's interpreter reads a bound name as its value, before the defined names.
function install(interpreter: object): void {
	if (installed.has(interpreter)) return

	installed.add(interpreter)

	const host = interpreter as { evaluateAstWithoutPostprocessing: Evaluate }
	const evaluate = host.evaluateAstWithoutPostprocessing.bind(interpreter)

	host.evaluateAstWithoutPostprocessing = (ast, state) => {
		if (scope !== null && ast.type === ("NAMED_EXPRESSION" as PluginAst["type"]) && "expressionName" in ast) {
			const bound = lookup(ast.expressionName.toUpperCase())

			if (bound === OMITTED) return EmptyValue
			// A LAMBDA read as a value: Excel's #CALC!.
			if (bound instanceof Lambda) return calcError()
			if (bound !== undefined) return bound
		}

		if (depth === 0) return evaluate(ast, state)
		if (nesting >= MAX_NESTING) return numError()
		// Inside a LAMBDA, IF calculates the branch it takes alone, as Excel does: the engine's IF calculates both, so a
		// recursion's last call would go on calling itself in the branch not taken.
		if (isCall(ast, "IF")) {
			const taken = ifBranch(ast, state, (node, at) => (interpreter as { evaluateAst: Evaluate }).evaluateAst(node, at))

			if (taken !== undefined) return taken
		}

		// Recursion set aside has its budget of steps.
		if (driving?.suspended === true && driving.steps-- <= 0) return numError()

		nesting++

		try {
			return evaluate(ast, state)
		} finally {
			nesting--
		}
	}
}

// Arguments evaluated here, as each call needs them; their references are still the formula's dependencies (the
// engine's doesNotNeedArgumentsToBeComputed would drop those).
const LAZY = { vectorizationForbidden: true } as const
const ANY = { argumentType: FunctionArgumentType.ANY } as const

// The element at (row, col) of a value, a single value at every position.
function at(value: PluginValue, row: number, col: number): PluginScalar {
	if (!(value instanceof SimpleRangeValue)) return value

	return value.data[row]?.[col] ?? EmptyValue
}

function sizeOf(value: PluginValue): [number, number] {
	return value instanceof SimpleRangeValue ? [value.height(), value.width()] : [1, 1]
}

function result(rows: PluginScalar[][]): PluginValue {
	return rows.length === 1 && rows[0]?.length === 1 ? (rows[0][0] ?? EmptyValue) : SimpleRangeValue.onlyValues(rows)
}

export class LambdaFunctions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		LET: { method: "let", parameters: [ANY], repeatLastArgs: 1, ...LAZY },
		LAMBDA: { method: "lambda", parameters: [ANY], repeatLastArgs: 1, ...LAZY },
		[CALL_FUNCTION]: { method: "call", parameters: [ANY], repeatLastArgs: 1, ...LAZY },
		ISOMITTED: { method: "isomitted", parameters: [ANY], ...LAZY },
		MAP: { method: "map", parameters: [ANY], repeatLastArgs: 1, ...LAZY },
		REDUCE: { method: "reduce", parameters: [ANY], repeatLastArgs: 1, ...LAZY },
		SCAN: { method: "scan", parameters: [ANY], repeatLastArgs: 1, ...LAZY },
		BYROW: { method: "byrow", parameters: [ANY], repeatLastArgs: 1, ...LAZY },
		BYCOL: { method: "bycol", parameters: [ANY], repeatLastArgs: 1, ...LAZY },
		MAKEARRAY: { method: "makearray", parameters: [ANY], repeatLastArgs: 1, ...LAZY }
	}

	constructor(interpreter: ConstructorParameters<typeof SheetFunctionPlugin>[0]) {
		super(interpreter)
		install(interpreter)
	}

	// What an argument evaluates to, a LAMBDA (written there, or a name holding one) kept as one.
	protected bound(ast: PluginAst, state: PluginState): Bound {
		const node = unwrap(ast)

		if (isCall(node, "LAMBDA")) return this.closure(node)

		const name = nameOf(node)

		if (name !== null) {
			const value = lookup(name)

			if (value instanceof Lambda) return value
			if (value === undefined && name.startsWith(ETA) && name.length > ETA.length)
				return new Lambda([], node, null, name.slice(ETA.length))
			if (value === undefined && !name.startsWith(PARAMETER)) {
				const named = this.namedLambda(name, state)

				if (named !== null) return named
			}
		}

		return this.evaluateAst(node, state)
	}

	// The LAMBDA a defined name holds (Excel's Name Manager: =LAMBDA(x,x+1) named MyFn, called as MyFn(1)), the
	// formula's sheet's own scope first; null when the name holds none. It sees no LET or LAMBDA names of the call.
	private namedLambda(name: string, state: PluginState): Lambda | CellError | null {
		const graph = this.dependencyGraph
		const named = graph.namedExpressions.nearestNamedExpression(name, state.formulaAddress.sheet)

		if (named === undefined) return null

		const vertex = graph.addressMapping.getCell(named.address) as { getFormula?: (service: unknown) => PluginAst } | undefined
		const formula = typeof vertex?.getFormula === "function" ? unwrap(vertex.getFormula(graph.lazilyTransformingAstService)) : null

		if (formula === null || !isCall(formula, "LAMBDA")) return null

		return within(null, () => this.closure(formula, vertex as object))
	}

	// Whether a call of `lambda` with `values` calculates without a volatile function: its calculation, the names it
	// was written among and the LAMBDAs it is given reach none.
	private pure(lambda: Lambda, values: readonly Bound[], state: PluginState): boolean {
		return this.pureLambda(lambda, state) && values.every(value => !(value instanceof Lambda) || this.pureLambda(value, state))
	}

	private pureLambda(lambda: Lambda, state: PluginState): boolean {
		const known = pureLambdas.get(lambda)

		if (known !== undefined) return known

		let pure = (lambda.eta === null || !volatileFunction(lambda.eta)) && !this.reachesVolatile(lambda.body, state, new Set())

		for (let at = lambda.scope; at !== null && pure; at = at.parent)
			if (at.value instanceof Lambda) pure = this.pureLambda(at.value, state)

		pureLambdas.set(lambda, pure)

		return pure
	}

	// Whether a syntax tree calls a volatile function, itself or through a defined name it reads (a named LAMBDA, a
	// name standing for OFFSET(...)). `seen`: the names' trees on the way, read once.
	private reachesVolatile(ast: unknown, state: PluginState, seen: Set<object>): boolean {
		if (typeof ast !== "object" || ast === null) return false
		if (Array.isArray(ast)) return ast.some(item => this.reachesVolatile(item, state, seen))

		const node = ast as { readonly type?: unknown; readonly procedureName?: unknown; readonly expressionName?: unknown }

		if (typeof node.type !== "string") return false

		const known = volatileAsts.get(ast)

		if (known !== undefined) return known

		let reaches = typeof node.procedureName === "string" && volatileFunction(node.procedureName.toUpperCase())

		if (!reaches && typeof node.expressionName === "string" && !node.expressionName.toUpperCase().startsWith(PARAMETER)) {
			const graph = this.dependencyGraph
			const named = graph.namedExpressions.nearestNamedExpression(node.expressionName, state.formulaAddress.sheet)
			const vertex =
				named === undefined
					? undefined
					: (graph.addressMapping.getCell(named.address) as { getFormula?: (service: unknown) => PluginAst } | undefined)

			if (vertex !== undefined && !seen.has(vertex)) {
				seen.add(vertex)
				reaches =
					typeof vertex.getFormula === "function" &&
					this.reachesVolatile(vertex.getFormula(graph.lazilyTransformingAstService), state, seen)
			}
		}

		for (const [field, value] of Object.entries(node)) {
			if (reaches) break
			if (field !== "reference" && typeof value === "object") reaches = this.reachesVolatile(value, state, seen)
		}

		volatileAsts.set(ast, reaches)

		return reaches
	}

	// LAMBDA([parameter, ...], calculation) as a value: its parameters must be names (#VALUE! otherwise).
	private closure(call: PluginCall, origin?: object): Lambda | CellError {
		const args = call.args

		if (args.length === 0 || args.length > 254) return valueError()

		const params: string[] = []

		for (const arg of args.slice(0, -1)) {
			const name = nameOf(arg)

			if (name === null || !name.startsWith(PARAMETER) || params.includes(name)) return valueError()

			params.push(name)
		}

		const body = args[args.length - 1] as PluginAst

		return new Lambda(params, body, scope, null, origin ?? body)
	}

	// A LAMBDA called with values (OMITTED for an argument left out): #VALUE! for the wrong number of them.
	protected apply(lambda: Lambda, values: readonly Bound[], state: PluginState): PluginValue {
		if (!lambda.takes(values.length)) return valueError()
		if (level >= MAX_LEVELS) return numError()
		// The outermost call: driven, so that recursion goes on a stack of its own.
		if (driving === null) return this.drive({ lambda, values, key: null, level: level + 1 }, state)

		const key = nesting >= SUSPEND_AT && this.pure(lambda, values, state) ? callKey(lambda, values) : null

		if (key !== null) {
			const known = driving.results.get(key)?.find(entry => sameCall(entry, lambda, values))

			if (known !== undefined) return known.value

			throw new Suspended({ lambda, values, key, level: level + 1 })
		}

		return this.invoke(lambda, values, state)
	}

	// Calculates `first` and every call set aside under it, from the bottom of the stack: a call set aside is
	// calculated before the one it was called from, which is then calculated again, finding its result.
	private drive(first: Pending, state: PluginState): PluginValue {
		const own = { results: new Map<string, Known[]>(), suspended: false, steps: LAMBDA_STEPS }
		const pending: Pending[] = [first]
		const before = { nesting, level }

		driving = own

		try {
			for (;;) {
				const top = pending.at(-1) as Pending

				nesting = 0
				level = top.level - 1

				try {
					const value = this.invoke(top.lambda, top.values, state)

					pending.pop()

					if (pending.length === 0) return value
					if (top.key !== null) {
						const entries = own.results.get(top.key)
						const known: Known = { lambda: top.lambda, values: top.values, value }

						if (entries === undefined) own.results.set(top.key, [known])
						else entries.push(known)
					}
				} catch (error) {
					if (!(error instanceof Suspended)) throw error

					// The budget spent, or the call no nearer an end: #NUM!.
					if (own.steps <= 0) return numError()

					own.suspended = true
					pending.push(error.call)
				}
			}
		} finally {
			driving = null
			sampledHashes.clear()
			nesting = before.nesting
			level = before.level
		}
	}

	// A call calculated here, on the JavaScript stack.
	private invoke(lambda: Lambda, values: readonly Bound[], state: PluginState): PluginValue {
		let inner = lambda.scope
		let body = lambda.body

		if (lambda.eta !== null) {
			// The function called on names bound to the values.
			const args = values.map((value, index) => {
				const name = `${PARAMETER}\u0001${String(index)}`

				inner = { name, value, parent: inner }

				return { type: "NAMED_EXPRESSION", expressionName: name } as unknown as PluginAst
			})

			body = { type: "FUNCTION_CALL", procedureName: lambda.eta, args } as unknown as PluginAst
		} else
			lambda.params.forEach((name, index) => {
				inner = { name, value: values[index] as Bound, parent: inner }
			})

		depth++
		level++

		try {
			return within(inner, () => this.evaluateAst(body, state))
		} finally {
			depth--
			level--
		}
	}

	// The LAMBDA a helper is given last, or the error it gives without one (#CALC!, "BYROW function").
	protected lambdaArgument(ast: PluginAst | undefined, state: PluginState): Lambda | CellError {
		if (ast === undefined) return calcError()

		const value = this.bound(ast, state)

		if (value instanceof Lambda) return value

		return value instanceof CellError ? value : calcError()
	}

	// LET(name1, value1, [name2, value2, ...], calculation): each name in scope from the next argument on.
	let(ast: PluginCall, state: PluginState): unknown {
		const args = ast.args

		if (args.length < 3 || args.length % 2 === 0) return valueError()

		let inner = scope

		for (let index = 0; index < args.length - 1; index += 2) {
			const name = nameOf(args[index] as PluginAst)

			if (name === null || !name.startsWith(PARAMETER)) return valueError()

			const value = within(inner, () => this.bound(args[index + 1] as PluginAst, state))

			inner = { name, value, parent: inner }
		}

		return within(inner, () => this.evaluateAst(args[args.length - 1] as PluginAst, state))
	}

	// A LAMBDA not called: #CALC! ("LAMBDA function").
	lambda(ast: PluginCall): unknown {
		const made = this.closure(ast)

		return made instanceof CellError ? made : calcError()
	}

	// FILEN.CALL(lambda, value1, ...): the LAMBDA called with the values; an empty argument is omitted.
	call(ast: PluginCall, state: PluginState): unknown {
		const [target, ...rest] = ast.args

		if (target === undefined) return valueError()

		const lambda = this.bound(target, state)

		if (!(lambda instanceof Lambda)) return lambda instanceof CellError ? lambda : valueError()

		const values = rest.map(arg => (arg.type === ("EMPTY" as PluginAst["type"]) ? OMITTED : this.bound(arg, state)))

		return this.apply(lambda, values, state)
	}

	// ISOMITTED(argument): whether a LAMBDA's parameter was left out of its call.
	isomitted(ast: PluginCall): unknown {
		if (ast.args.length !== 1) return valueError()

		const name = nameOf(ast.args[0] as PluginAst)

		return name !== null && lookup(name) === OMITTED
	}

	// The values of the arrays a helper maps, each evaluated once.
	private arrays(args: readonly PluginAst[], state: PluginState): PluginValue[] | CellError {
		const out: PluginValue[] = []

		for (const arg of args) {
			const value = this.bound(arg, state)

			if (value instanceof Lambda || value === OMITTED) return valueError()
			if (value instanceof CellError) return value

			out.push(value)
		}

		return out
	}

	// One value a LAMBDA gives for one element: a single value, or #CALC! for an array.
	private single(value: PluginValue): PluginScalar {
		if (!(value instanceof SimpleRangeValue)) return value

		return value.width() === 1 && value.height() === 1 ? (value.data[0]?.[0] ?? EmptyValue) : calcError()
	}

	// MAP(array1, [array2, ...], lambda): the LAMBDA of each position's values; the arrays as large as the largest,
	// a position one lacks #N/A (as Excel's array arithmetic pads).
	map(ast: PluginCall, state: PluginState): unknown {
		const args = ast.args

		if (args.length < 2) return valueError()

		const lambda = this.lambdaArgument(args[args.length - 1], state)

		if (lambda instanceof CellError) return lambda

		const arrays = this.arrays(args.slice(0, -1), state)

		if (arrays instanceof CellError) return arrays
		if (!lambda.takes(arrays.length)) return valueError()

		const sizes = arrays.map(sizeOf)
		const height = Math.max(...sizes.map(size => size[0]))
		const width = Math.max(...sizes.map(size => size[1]))

		if (height * width > MAX_ARRAY_CELLS) return valueError()

		const rows: PluginScalar[][] = []

		for (let row = 0; row < height; row++) {
			const line: PluginScalar[] = []

			for (let col = 0; col < width; col++) {
				const values = arrays.map((array, index) => {
					const [h, w] = sizes[index] as [number, number]

					if (h === 1 && w === 1) return at(array, 0, 0)

					return row < h && col < w ? at(array, row, col) : naError()
				})

				line.push(this.single(this.apply(lambda, values, state)))
			}

			rows.push(line)
		}

		return result(rows)
	}

	// REDUCE([initial_value], array, lambda(accumulator, value)) and SCAN: the accumulator over the array row by row;
	// without an initial value, the first value starts it.
	private fold(ast: PluginCall, state: PluginState, keep: boolean): unknown {
		const args = ast.args

		if (args.length !== 2 && args.length !== 3) return valueError()

		const lambda = this.lambdaArgument(args[args.length - 1], state)

		if (lambda instanceof CellError) return lambda
		if (!lambda.takes(2)) return valueError()

		const initialAst = args.length === 3 ? args[0] : undefined
		const arrayValue = this.arrays([args[args.length - 2] as PluginAst], state)

		if (arrayValue instanceof CellError) return arrayValue

		const array = arrayValue[0] as PluginValue
		const [height, width] = sizeOf(array)
		let accumulator: Bound | undefined =
			initialAst === undefined || initialAst.type === ("EMPTY" as PluginAst["type"]) ? undefined : this.bound(initialAst, state)

		if (accumulator instanceof Lambda) return valueError()

		const rows: PluginScalar[][] = []

		for (let row = 0; row < height; row++) {
			const line: PluginScalar[] = []

			for (let col = 0; col < width; col++) {
				const value = at(array, row, col)

				accumulator = accumulator === undefined ? value : this.apply(lambda, [accumulator, value], state)

				if (keep) line.push(this.single(accumulator as PluginValue))
			}

			if (keep) rows.push(line)
		}

		if (keep) return result(rows)

		return accumulator === undefined ? 0 : accumulator
	}

	reduce(ast: PluginCall, state: PluginState): unknown {
		return this.fold(ast, state, false)
	}

	scan(ast: PluginCall, state: PluginState): unknown {
		return this.fold(ast, state, true)
	}

	// BYROW(array, lambda(row)) and BYCOL: one value per row (column); an array from the LAMBDA is #CALC!.
	private by(ast: PluginCall, state: PluginState, rows: boolean): unknown {
		const args = ast.args

		if (args.length === 1) return calcError()
		if (args.length !== 2) return valueError()

		const lambda = this.lambdaArgument(args[1], state)

		if (lambda instanceof CellError) return lambda
		if (!lambda.takes(1)) return valueError()

		const arrayValue = this.arrays([args[0] as PluginAst], state)

		if (arrayValue instanceof CellError) return arrayValue

		const array = arrayValue[0] as PluginValue
		const [height, width] = sizeOf(array)
		const data: PluginScalar[][] = array instanceof SimpleRangeValue ? array.data : [[array]]
		const out: PluginScalar[] = []

		for (let index = 0; index < (rows ? height : width); index++) {
			const slice: PluginScalar[][] = rows ? [[...(data[index] ?? [])]] : data.map(line => [line[index] ?? EmptyValue])

			out.push(this.single(this.apply(lambda, [result(slice)], state)))
		}

		return result(rows ? out.map(value => [value]) : [out])
	}

	byrow(ast: PluginCall, state: PluginState): unknown {
		return this.by(ast, state, true)
	}

	bycol(ast: PluginCall, state: PluginState): unknown {
		return this.by(ast, state, false)
	}

	// MAKEARRAY(rows, cols, lambda(row, col)): the LAMBDA of each 1-based position; rows or cols below 1 or not a
	// number is #VALUE!.
	makearray(ast: PluginCall, state: PluginState): unknown {
		const args = ast.args

		if (args.length !== 3) return valueError()

		const lambda = this.lambdaArgument(args[2], state)

		if (lambda instanceof CellError) return lambda
		if (!lambda.takes(2)) return valueError()

		const counts: number[] = []

		for (const arg of args.slice(0, 2)) {
			const value = this.evaluateAst(arg as PluginAst, state)

			if (value instanceof SimpleRangeValue) return valueError()
			if (value instanceof CellError) return value
			if (typeof value === "string" || typeof value === "boolean" || value === EmptyValue) return valueError()

			const number = this.numberOf(value)

			if (number instanceof CellError) return number

			const count = Math.trunc(number)

			if (!(count >= 1)) return valueError()

			counts.push(count)
		}

		const [height = 1, width = 1] = counts

		if (height * width > MAX_ARRAY_CELLS) return valueError()

		const rows: PluginScalar[][] = []

		for (let row = 1; row <= height; row++) {
			const line: PluginScalar[] = []

			for (let col = 1; col <= width; col++) line.push(this.single(this.apply(lambda, [row, col], state)))

			rows.push(line)
		}

		return result(rows)
	}
}
