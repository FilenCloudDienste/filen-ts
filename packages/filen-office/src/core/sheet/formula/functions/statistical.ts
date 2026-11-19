import { CellError, EmptyValue, FunctionArgumentType, SimpleRangeValue, type ImplementedFunctions } from "hyperformula"
import {
	ARRAY_ARGUMENTS,
	naError,
	numError,
	rawNumber,
	SheetFunctionPlugin,
	unwrap,
	valueError,
	type PluginAst,
	type PluginCall,
	type PluginScalar,
	type PluginState
} from "./plugin"
import { kurtosis, linearFit, mode, modes, rangeNumbers } from "./statistics"

// Statistical functions the engine lacks, as support.microsoft.com defines them.

const NUMBERS = { parameters: [{ argumentType: FunctionArgumentType.ANY }], repeatLastArgs: 1, ...ARRAY_ARGUMENTS }
const RANKS = {
	parameters: [
		{ argumentType: FunctionArgumentType.NUMBER },
		{ argumentType: FunctionArgumentType.RANGE },
		{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 0 }
	]
}
const FORECASTS = {
	parameters: [
		{ argumentType: FunctionArgumentType.NUMBER },
		{ argumentType: FunctionArgumentType.RANGE },
		{ argumentType: FunctionArgumentType.RANGE }
	],
	...ARRAY_ARGUMENTS
}

// Least squares over columns of predictors (each row one observation), with or without an intercept: the
// coefficients [b, m1, m2, ...] (b 0 without one), or #NUM! when the predictors are not independent. With an intercept
// the predictors and ys are centred on their means first, so an offset (dates) cannot cancel the spread away. The
// normal equations are scaled to unit diagonal before solving, so whether predictors are independent does not depend
// on the units of any of them.
function leastSquares(ys: readonly number[], xs: readonly (readonly number[])[], intercept: boolean): number[] | CellError {
	const k = xs[0]?.length ?? 0
	const n = ys.length
	const xMeans = new Array<number>(k).fill(0)
	let yMean = 0

	if (intercept && n > 0) {
		ys.forEach((y, row) => {
			const observed = xs[row]

			yMean += y

			for (let j = 0; j < k; j++) xMeans[j] = (xMeans[j] ?? 0) + (observed?.[j] ?? 0)
		})

		yMean /= n

		for (let j = 0; j < k; j++) xMeans[j] = (xMeans[j] ?? 0) / n
	}

	// The normal equations, augmented: [XᵀX | Xᵀy].
	const matrix = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0))
	const line = new Array<number>(k).fill(0)

	ys.forEach((y, row) => {
		const observed = xs[row]
		const target = y - yMean

		for (let j = 0; j < k; j++) line[j] = (observed?.[j] ?? 0) - (xMeans[j] ?? 0)

		for (let i = 0; i < k; i++) {
			const equation = matrix[i] as number[]
			const value = line[i] ?? 0

			for (let j = 0; j < k; j++) equation[j] = (equation[j] ?? 0) + value * (line[j] ?? 0)

			equation[k] = (equation[k] ?? 0) + value * target
		}
	})

	// Each equation and unknown divided by the square root of its column's sum of squares (a constant column, or an
	// empty one, is no predictor), so every diagonal entry is 1 whatever the units of each column.
	const roots = matrix.map((equation, index) => Math.sqrt(equation[index] ?? 0))

	if (!roots.every(root => root > 0 && Number.isFinite(root))) return numError()

	matrix.forEach((equation, i) => {
		const root = roots[i] ?? 1

		for (let j = 0; j < k; j++) equation[j] = (equation[j] ?? 0) / (root * (roots[j] ?? 1))

		equation[k] = (equation[k] ?? 0) / root
	})

	// Gauss-Jordan elimination down the diagonal (the matrix is symmetric and positive semi-definite, which needs no row
	// exchanges). A pivot is then 1 - R² of its column on the columns before it, free of units and of the order of the
	// rows: next to nothing when the column is a combination of them.
	for (let column = 0; column < k; column++) {
		const top = matrix[column] as number[]
		const pivot = top[column] ?? 0

		if (!(pivot > 1e-12)) return numError()

		for (let row = 0; row < k; row++) {
			if (row === column) continue

			const equation = matrix[row] as number[]
			const factor = (equation[column] ?? 0) / pivot

			if (factor === 0) continue

			for (let j = column; j <= k; j++) equation[j] = (equation[j] ?? 0) - factor * (top[j] ?? 0)
		}
	}

	// Back to each column's own units.
	const slopes = matrix.map((equation, index) => (equation[k] ?? 0) / (equation[index] ?? 1) / (roots[index] ?? 1))

	if (!intercept) return [0, ...slopes]

	let constant = yMean

	for (let j = 0; j < k; j++) constant -= (slopes[j] ?? 0) * (xMeans[j] ?? 0)

	return [constant, ...slopes]
}

export class StatisticalFunctions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		RANK: { method: "rankEq", ...RANKS },
		"RANK.EQ": { method: "rankEq", ...RANKS },
		"RANK.AVG": { method: "rankAvg", ...RANKS },
		FORECAST: { method: "forecast", ...FORECASTS },
		"FORECAST.LINEAR": { method: "forecast", ...FORECASTS },
		TREND: {
			method: "trend",
			parameters: [
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.RANGE, optionalArg: true },
				{ argumentType: FunctionArgumentType.RANGE, optionalArg: true },
				{ argumentType: FunctionArgumentType.BOOLEAN, defaultValue: true }
			],
			...ARRAY_ARGUMENTS
		},
		FREQUENCY: {
			method: "frequency",
			parameters: [{ argumentType: FunctionArgumentType.RANGE }, { argumentType: FunctionArgumentType.RANGE }],
			...ARRAY_ARGUMENTS
		},
		MODE: { method: "modeSingle", ...NUMBERS },
		"MODE.SNGL": { method: "modeSingle", ...NUMBERS },
		"MODE.MULT": { method: "modeMultiple", ...NUMBERS },
		KURT: { method: "kurt", ...NUMBERS }
	}

	// The numbers of the arguments of MODE and KURT (support.microsoft.com): in a range, array or reference only
	// numbers count; typed directly, logical values and text that reads as a number count too, other text is
	// #VALUE!. Errors are raised.
	private numbers(args: readonly PluginAst[], state: PluginState): number[] | CellError {
		const out: number[] = []

		for (const arg of args) {
			const node = unwrap(arg)
			const value = this.evaluateAst(node, state)

			if (value instanceof SimpleRangeValue) {
				const error = rangeNumbers(value.data, out)

				if (error !== null) return error

				continue
			}

			if (value instanceof CellError) return value
			if (value === EmptyValue) continue

			const number = rawNumber(value)

			if (number !== undefined) {
				out.push(number)
				continue
			}

			if (node.type === ("CELL_REFERENCE" as PluginAst["type"])) continue

			if (typeof value === "boolean") out.push(value ? 1 : 0)
			else {
				const read = this.numberOf(value)

				if (read instanceof CellError) return read

				out.push(read)
			}
		}

		return out
	}

	modeSingle(ast: PluginCall, state: PluginState): unknown {
		const numbers = this.numbers(ast.args, state)

		return numbers instanceof CellError ? numbers : mode(numbers)
	}

	// MODE.MULT: every most frequent number, as a vertical array.
	modeMultiple(ast: PluginCall, state: PluginState): unknown {
		const numbers = this.numbers(ast.args, state)

		if (numbers instanceof CellError) return numbers

		const found = modes(numbers)

		return found instanceof CellError ? found : SimpleRangeValue.onlyNumbers(found.map(value => [value]))
	}

	kurt(ast: PluginCall, state: PluginState): unknown {
		const numbers = this.numbers(ast.args, state)

		return numbers instanceof CellError ? numbers : kurtosis(numbers)
	}

	private rank(ast: PluginCall, state: PluginState, name: string, average: boolean): unknown {
		return this.runFunction(ast.args, state, this.metadata(name), (number: number, ref: SimpleRangeValue, order: number) => {
			const numbers: number[] = []
			const error = rangeNumbers(ref.data, numbers)

			if (error !== null) return error

			let before = 0
			let ties = 0

			for (const value of numbers) {
				if (value === number) ties++
				else if (order === 0 ? value > number : value < number) before++
			}

			if (ties === 0) return naError()

			return average ? before + (ties + 1) / 2 : before + 1
		})
	}

	// RANK and RANK.EQ: the number's place among the numbers of ref, ties sharing the best; order 0 (or omitted)
	// descending.
	rankEq(ast: PluginCall, state: PluginState): unknown {
		return this.rank(ast, state, ast.procedureName.toUpperCase() === "RANK" ? "RANK" : "RANK.EQ", false)
	}

	// RANK.AVG: ties share the average of their places.
	rankAvg(ast: PluginCall, state: PluginState): unknown {
		return this.rank(ast, state, "RANK.AVG", true)
	}

	// FORECAST and FORECAST.LINEAR(x, known_ys, known_xs): the linear regression's value at x.
	forecast(ast: PluginCall, state: PluginState): unknown {
		const name = ast.procedureName.toUpperCase().endsWith("LINEAR") ? "FORECAST.LINEAR" : "FORECAST"

		return this.runFunction(ast.args, state, this.metadata(name), (x: number, ys: SimpleRangeValue, xs: SimpleRangeValue) => {
			const fit = linearFit(ys, xs)

			if (fit instanceof CellError) return fit

			return fit.yMean + fit.slope * (x - fit.xMean)
		})
	}

	// TREND(known_ys, [known_xs], [new_xs], [const]): the least-squares line (or plane, with several predictors) at
	// new_xs, as an array of new_xs's shape. known_xs defaults to 1, 2, 3, ...; new_xs to known_xs.
	trend(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("TREND"),
			(knownYs: SimpleRangeValue, knownXs: SimpleRangeValue | undefined, newXs: SimpleRangeValue | undefined, intercept: boolean) => {
				const yRows = knownYs.data
				const ys: number[] = []
				const yError = rangeNumbers(yRows, ys)

				if (yError !== null) return yError
				if (ys.length !== yRows.length * (yRows[0]?.length ?? 0)) return valueError()

				const column = knownYs.width() === 1
				const n = ys.length
				const xRows = knownXs?.data ?? (column ? ys.map((_, index) => [index + 1]) : [ys.map((_, index) => index + 1)])
				// Observations by predictor: one predictor over the same shape as known_ys, else one per column (known_ys
				// a column) or per row (known_ys a row).
				const observations = (rows: readonly (readonly PluginScalar[])[], one: boolean): number[][] | CellError => {
					const numbers: number[] = []
					const error = rangeNumbers(rows, numbers)

					if (error !== null) return error
					if (numbers.length !== rows.length * (rows[0]?.length ?? 0)) return valueError()
					if (one) return numbers.map(value => [value])

					const byColumn = column
					const count = byColumn ? rows.length : (rows[0]?.length ?? 0)
					const width = byColumn ? (rows[0]?.length ?? 0) : rows.length

					return Array.from({ length: count }, (_, at) =>
						Array.from({ length: width }, (__, k) => rawNumber((byColumn ? rows[at]?.[k] : rows[k]?.[at]) ?? EmptyValue) ?? 0)
					)
				}
				const xCount = xRows.length * (xRows[0]?.length ?? 0)
				const single = xCount === n
				const known = observations(xRows, single)

				if (known instanceof CellError) return known
				if (known.length !== n) return naError()

				const coefficients = leastSquares(ys, known, intercept)

				if (coefficients instanceof CellError) return coefficients

				const targetRows = newXs?.data ?? xRows
				const k = known[0]?.length ?? 1
				const predict = (values: readonly number[]): number =>
					values.reduce((total, value, index) => total + value * (coefficients[index + 1] ?? 0), coefficients[0] ?? 0)

				if (k === 1) {
					const out: number[][] = []

					for (const row of targetRows) {
						const line: number[] = []

						for (const value of row) {
							const number = rawNumber(value)

							if (number === undefined) return valueError()

							line.push(predict([number]))
						}

						out.push(line)
					}

					return SimpleRangeValue.onlyNumbers(out)
				}

				const targets = observations(targetRows, false)

				if (targets instanceof CellError) return targets

				const results = targets.map(predict)

				return SimpleRangeValue.onlyNumbers(column ? results.map(value => [value]) : [results])
			}
		)
	}

	// FREQUENCY(data_array, bins_array): how many values fall at or below each bin and above the one before (bins in
	// their order of value, counts in the bins' own order), then how many are above every bin; a vertical array.
	frequency(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("FREQUENCY"), (data: SimpleRangeValue, bins: SimpleRangeValue) => {
			const values: number[] = []
			const limits: number[] = []
			const error = rangeNumbers(data.data, values) ?? rangeNumbers(bins.data, limits)

			if (error !== null) return error

			const order = limits.map((_, index) => index).sort((a, z) => (limits[a] ?? 0) - (limits[z] ?? 0))
			const counts = new Array<number>(limits.length + 1).fill(0)

			for (const value of values) {
				let low = 0
				let high = order.length

				// The first bin, in value order, at or above the value.
				while (low < high) {
					const mid = (low + high) >> 1

					if ((limits[order[mid] ?? 0] ?? 0) >= value) high = mid
					else low = mid + 1
				}

				const target = low < order.length ? (order[low] ?? limits.length) : limits.length

				counts[target] = (counts[target] ?? 0) + 1
			}

			return SimpleRangeValue.onlyNumbers(counts.map(count => [count]))
		})
	}
}
