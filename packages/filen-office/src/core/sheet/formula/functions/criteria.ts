import {
	CellError,
	EmptyValue,
	ErrorType,
	FunctionArgumentType,
	SimpleRangeValue,
	type FunctionPlugin,
	type ImplementedFunctions
} from "hyperformula"
import { CRITERION_FUNCTION } from "../../functions/engineNames"
import { divError, rawNumber, SheetFunctionPlugin, valueError, type PluginCall, type PluginScalar, type PluginState } from "./plugin"

// Excel's error texts, as a criterion names an error.
const ERROR_TEXT: Readonly<Partial<Record<ErrorType, string>>> = {
	[ErrorType.DIV_BY_ZERO]: "#DIV/0!",
	[ErrorType.NAME]: "#NAME?",
	[ErrorType.VALUE]: "#VALUE!",
	[ErrorType.NUM]: "#NUM!",
	[ErrorType.NA]: "#N/A",
	[ErrorType.REF]: "#REF!",
	[ErrorType.SPILL]: "#SPILL!"
}

type Helper = FunctionPlugin["arithmeticHelper"]
type Interpreter = ConstructorParameters<typeof FunctionPlugin>[0]
type CriterionLambda = ReturnType<Helper["eqMatcherFunction"]>

// The engine's criterion parser, shared by COUNTIF(S), SUMIF(S), AVERAGEIF(S), MAXIFS, MINIFS and the D-functions.
interface CriterionBuilder {
	fromCellValue(raw: unknown, helper: Helper): { readonly raw: unknown; readonly lambda: CriterionLambda } | undefined
	readonly trueString: string
	readonly falseString: string
}

const OPERATORS = /[<>=]/
const COMPARISON = /^([<>=]+)(.+)$/s
const TEXT_ORDER: Readonly<Record<string, (order: number) => boolean>> = {
	">": order => order > 0,
	">=": order => order >= 0,
	"<": order => order < 0,
	"<=": order => order <= 0
}

// Where the engine's criteria differ from Excel's:
// - <, <=, > and >= with text compare it with text cells, without case through the engine's collation, and match
//   no number, boolean, empty cell or error (OpenDocument part 4, 4.11.8 and 6.4.9); wildcards are literal there.
//   The engine gave #VALUE!;
// - an operator only after the start ("a>b", "x=5") is part of the text to equal (the engine read the operator
//   wherever it stood).
function adjustCriteria(builder: CriterionBuilder): void {
	const parse = builder.fromCellValue.bind(builder)

	builder.fromCellValue = (raw, helper) => {
		if (typeof raw === "string" && raw !== "" && !OPERATORS.test(raw.charAt(0)) && OPERATORS.test(raw))
			return { raw, lambda: helper.eqMatcherFunction(raw) }

		const built = parse(raw, helper)

		if (built !== undefined || typeof raw !== "string") return built

		const match = COMPARISON.exec(raw)
		const holds = match === null ? undefined : TEXT_ORDER[match[1] ?? ""]
		const operand = match?.[2]

		if (holds === undefined || operand === undefined) return undefined

		const lower = operand.toLowerCase()

		if (lower === builder.trueString || lower === builder.falseString) return undefined

		const helperCompare = helper as unknown as { stringCmp(left: string, right: string): number }

		return { raw, lambda: value => typeof value === "string" && holds(helperCompare.stringCmp(value, operand)) }
	}
}

const adjustedEngines = new WeakSet<object>()

// The engine sets its criterion parser after it builds its plugins: it is adjusted as it is set, once per engine.
function adjustCriteriaOf(interpreter: Interpreter): void {
	if (adjustedEngines.has(interpreter)) return

	adjustedEngines.add(interpreter)

	const target = interpreter as unknown as { criterionBuilder?: CriterionBuilder }

	if (target.criterionBuilder !== undefined) {
		adjustCriteria(target.criterionBuilder)

		return
	}

	Object.defineProperty(target, "criterionBuilder", {
		configurable: true,
		enumerable: true,
		set(builder: CriterionBuilder) {
			adjustCriteria(builder)
			Object.defineProperty(target, "criterionBuilder", { configurable: true, enumerable: true, writable: true, value: builder })
		}
	})
}

// A condition of COUNTIFS and its kind: its range's cells and its criterion's test of one.
interface Test {
	readonly rows: readonly (readonly PluginScalar[])[]
	readonly lambda: EngineLambda
}

type EngineLambda = NonNullable<ReturnType<Interpreter["criterionBuilder"]["fromCellValue"]>>["lambda"]

// value_range (or sum_range, …), then criteria_range, criteria pairs.
const IFS_PARAMETERS = [
	{ argumentType: FunctionArgumentType.RANGE },
	{ argumentType: FunctionArgumentType.RANGE },
	{ argumentType: FunctionArgumentType.NOERROR }
]

// The criteria of COUNTIF and its kind, as Excel reads them.
export class CriteriaFunctions extends SheetFunctionPlugin {
	constructor(interpreter: Interpreter) {
		super(interpreter)
		adjustCriteriaOf(interpreter)
	}

	static override implementedFunctions: ImplementedFunctions = {
		[CRITERION_FUNCTION]: {
			method: "criterion",
			parameters: [{ argumentType: FunctionArgumentType.ANY, optionalArg: true }]
		},
		COUNTIF: {
			method: "countif",
			parameters: [{ argumentType: FunctionArgumentType.RANGE }, { argumentType: FunctionArgumentType.NOERROR }]
		},
		COUNTIFS: {
			method: "countifs",
			parameters: [{ argumentType: FunctionArgumentType.RANGE }, { argumentType: FunctionArgumentType.NOERROR }],
			repeatLastArgs: 2
		},
		SUMIF: {
			method: "sumif",
			parameters: [
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.NOERROR },
				{ argumentType: FunctionArgumentType.RANGE, optionalArg: true }
			]
		},
		SUMIFS: { method: "sumifs", parameters: IFS_PARAMETERS, repeatLastArgs: 2 },
		AVERAGEIF: {
			method: "averageif",
			parameters: [
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.NOERROR },
				{ argumentType: FunctionArgumentType.RANGE, optionalArg: true }
			]
		},
		AVERAGEIFS: { method: "averageifs", parameters: IFS_PARAMETERS, repeatLastArgs: 2 },
		MAXIFS: { method: "maxifs", parameters: IFS_PARAMETERS, repeatLastArgs: 2 },
		MINIFS: { method: "minifs", parameters: IFS_PARAMETERS, repeatLastArgs: 2 }
	}

	// The engine's own COUNTIF and its kind keep, on every range they read, a result per criterion that each larger
	// range sharing its top-left cell builds on: a running COUNTIF($A$1:A2,A2) down a column holds n² of them. These
	// read each range's cells once per call and keep nothing.

	// The conditions (range, criterion pairs) as tests over ranges of `values`' size, or the error they give: ranges of
	// another size #VALUE!, a criterion the engine cannot read #VALUE!.
	private tests(values: SimpleRangeValue, conditions: readonly (SimpleRangeValue | PluginScalar)[]): Test[] | CellError {
		const height = values.height()
		const width = values.width()
		const tests: Test[] = []

		for (let index = 0; index < conditions.length; index += 2) {
			const range = conditions[index]
			const criterion = conditions[index + 1]

			if (!(range instanceof SimpleRangeValue) || criterion === undefined || criterion instanceof SimpleRangeValue)
				return valueError()
			if (range.height() !== height || range.width() !== width) return valueError()
			if (criterion instanceof CellError) return criterion

			const raw = typeof criterion === "string" || typeof criterion === "boolean" ? criterion : (rawNumber(criterion) ?? 0)
			const built = this.interpreter.criterionBuilder.fromCellValue(raw, this.arithmeticHelper)

			if (built === undefined) return valueError()

			tests.push({ rows: range.data, lambda: built.lambda })
		}

		return tests
	}

	// Calls `visit` with each cell of `values` where every condition's range meets its criterion, row by row, until it
	// gives an error, which is the result; else undefined. The conditions' error first.
	private matching(
		values: SimpleRangeValue,
		conditions: readonly (SimpleRangeValue | PluginScalar)[],
		visit: (value: PluginScalar) => CellError | undefined
	): CellError | undefined {
		const tests = this.tests(values, conditions)

		if (tests instanceof CellError) return tests

		const height = values.height()
		const width = values.width()
		const rows = values.data

		for (let row = 0; row < height; row++) {
			const line = rows[row]

			for (let col = 0; col < width; col++) {
				let met = true

				for (const test of tests) {
					const value = test.rows[row]?.[col] ?? EmptyValue

					if (!test.lambda(typeof value === "object" && !(value instanceof CellError) ? value.val : value)) {
						met = false

						break
					}
				}

				if (!met) continue

				const error = visit(line?.[col] ?? EmptyValue)

				if (error !== undefined) return error
			}
		}

		return undefined
	}

	// The number of cells meeting the criteria ("COUNTIF function", "COUNTIFS function").
	private counted(values: SimpleRangeValue, conditions: readonly (SimpleRangeValue | PluginScalar)[]): number | CellError {
		let count = 0

		return (
			this.matching(values, conditions, () => {
				count++

				return undefined
			}) ?? count
		)
	}

	// The sum of the numbers among the cells meeting the criteria, the first error among them its result ("SUMIF
	// function": text, logical values and empty cells are left out).
	private summed(values: SimpleRangeValue, conditions: readonly (SimpleRangeValue | PluginScalar)[]): number | CellError {
		let total = 0

		return (
			this.matching(values, conditions, value => {
				if (value instanceof CellError) return value

				const number = rawNumber(value)

				if (number !== undefined) total = this.arithmeticHelper.addWithEpsilonRaw(total, number)

				return undefined
			}) ?? total
		)
	}

	// The mean of the numbers among the cells meeting the criteria, #DIV/0! when there are none ("AVERAGEIF function",
	// "AVERAGEIFS function": empty and non-numeric cells are left out).
	private averaged(values: SimpleRangeValue, conditions: readonly (SimpleRangeValue | PluginScalar)[]): number | CellError {
		let total = 0
		let count = 0
		const error = this.matching(values, conditions, value => {
			if (value instanceof CellError) return value

			const number = rawNumber(value)

			if (number !== undefined) {
				total += number
				count++
			}

			return undefined
		})

		return error ?? (count === 0 ? divError() : total / count)
	}

	// The largest (smallest) number among the cells meeting the criteria, 0 when there is none ("MAXIFS function",
	// "MINIFS function").
	private extreme(values: SimpleRangeValue, conditions: readonly (SimpleRangeValue | PluginScalar)[], max: boolean): number | CellError {
		let best: number | undefined
		const error = this.matching(values, conditions, value => {
			if (value instanceof CellError) return value

			const number = rawNumber(value)

			if (number !== undefined && (best === undefined || (max ? number > best : number < best))) best = number

			return undefined
		})

		return error ?? best ?? 0
	}

	countif(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("COUNTIF"), (range: SimpleRangeValue, criterion: PluginScalar) =>
			this.counted(range, [range, criterion])
		)
	}

	countifs(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("COUNTIFS"), (...conditions: (SimpleRangeValue | PluginScalar)[]) => {
			const [first] = conditions

			return first instanceof SimpleRangeValue ? this.counted(first, conditions) : valueError()
		})
	}

	sumif(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("SUMIF"),
			(range: SimpleRangeValue, criterion: PluginScalar, values: SimpleRangeValue | undefined) =>
				this.summed(values ?? range, [range, criterion])
		)
	}

	sumifs(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("SUMIFS"),
			(values: SimpleRangeValue, ...conditions: (SimpleRangeValue | PluginScalar)[]) => this.summed(values, conditions)
		)
	}

	averageif(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("AVERAGEIF"),
			(range: SimpleRangeValue, criterion: PluginScalar, values: SimpleRangeValue | undefined) =>
				this.averaged(values ?? range, [range, criterion])
		)
	}

	// AVERAGEIFS(average_range, criteria_range1, criteria1, ...): criteria are read as the engine reads them for SUMIFS.
	averageifs(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("AVERAGEIFS"),
			(values: SimpleRangeValue, ...conditions: (SimpleRangeValue | PluginScalar)[]) => this.averaged(values, conditions)
		)
	}

	maxifs(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("MAXIFS"),
			(values: SimpleRangeValue, ...conditions: (SimpleRangeValue | PluginScalar)[]) => this.extreme(values, conditions, true)
		)
	}

	minifs(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("MINIFS"),
			(values: SimpleRangeValue, ...conditions: (SimpleRangeValue | PluginScalar)[]) => this.extreme(values, conditions, false)
		)
	}

	// A criteria argument as written, an empty cell (or none given) as 0: "If the criteria argument is a reference to
	// an empty cell, the COUNTIFS function treats the empty cell as a 0 value" (support.microsoft.com, and the same
	// for SUMIF, SUMIFS, AVERAGEIF and AVERAGEIFS).
	criterion(ast: PluginCall, state: PluginState): unknown {
		const [arg] = ast.args

		if (arg === undefined) return 0

		const value = this.evaluateAst(arg, state)

		if (value instanceof SimpleRangeValue) return value
		// An error matches cells holding that error (COUNTIF(A:A,#N/A) counts them): its text as the criterion.
		if (value instanceof CellError) return ERROR_TEXT[value.type] ?? value

		return value === EmptyValue ? 0 : value
	}
}
