import { CellError, FunctionArgumentType, SimpleRangeValue, type ImplementedFunctions } from "hyperformula"
import { MAX_ARRAY_CELLS } from "../../refs/formulaRefs"
import {
	naError,
	numError,
	rawNumber,
	refError,
	SheetFunctionPlugin,
	valueError,
	type PluginCall,
	type PluginScalar,
	type PluginState
} from "./plugin"
import { given } from "./shape"

// Matrix and regression functions as support.microsoft.com defines them: MDETERM, MINVERSE, MUNIT, LINEST, LOGEST
// and GROWTH.

// Every value of a range or array as a number, row by row; an empty cell, text or a logical value is #VALUE!, an
// error raised.
function allNumbers(value: SimpleRangeValue): Float64Array | CellError {
	const out = new Float64Array(value.width() * value.height())
	let index = 0

	for (const row of value.data)
		for (const cell of row) {
			if (cell instanceof CellError) return cell

			const number = rawNumber(cell)

			if (number === undefined) return valueError()

			out[index++] = number
		}

	return out
}

// A square matrix, row by row, and its size; #VALUE! for one not square or not all numbers.
function squareMatrix(value: SimpleRangeValue): { readonly cells: Float64Array; readonly size: number } | CellError {
	if (value.width() !== value.height()) return valueError()

	const cells = allNumbers(value)

	return cells instanceof CellError ? cells : { cells, size: value.width() }
}

// The determinant by LU decomposition with partial pivoting (the matrix is overwritten).
export function determinant(cells: Float64Array, size: number): number {
	let det = 1

	for (let col = 0; col < size; col++) {
		let pivot = col

		for (let row = col + 1; row < size; row++)
			if (Math.abs(cells[row * size + col] as number) > Math.abs(cells[pivot * size + col] as number)) pivot = row

		const top = cells[pivot * size + col] as number

		if (top === 0) return 0

		if (pivot !== col) {
			for (let k = 0; k < size; k++) {
				const swap = cells[col * size + k] as number

				cells[col * size + k] = cells[pivot * size + k] as number
				cells[pivot * size + k] = swap
			}

			det = -det
		}

		det *= top

		for (let row = col + 1; row < size; row++) {
			const factor = (cells[row * size + col] as number) / top

			if (factor === 0) continue

			for (let k = col + 1; k < size; k++)
				cells[row * size + k] = (cells[row * size + k] as number) - factor * (cells[col * size + k] as number)
		}
	}

	return det
}

// The inverse by Gauss-Jordan elimination with partial pivoting, or null for a singular matrix (a pivot of 0). The
// matrix is overwritten.
export function inverse(cells: Float64Array, size: number): Float64Array | null {
	const out = new Float64Array(size * size)

	for (let i = 0; i < size; i++) out[i * size + i] = 1

	const swapRows = (matrix: Float64Array, a: number, b: number): void => {
		for (let k = 0; k < size; k++) {
			const swap = matrix[a * size + k] as number

			matrix[a * size + k] = matrix[b * size + k] as number
			matrix[b * size + k] = swap
		}
	}

	for (let col = 0; col < size; col++) {
		let pivot = col

		for (let row = col + 1; row < size; row++)
			if (Math.abs(cells[row * size + col] as number) > Math.abs(cells[pivot * size + col] as number)) pivot = row

		if (cells[pivot * size + col] === 0) return null

		if (pivot !== col) {
			swapRows(cells, pivot, col)
			swapRows(out, pivot, col)
		}

		const top = cells[col * size + col] as number

		for (let k = 0; k < size; k++) {
			cells[col * size + k] = (cells[col * size + k] as number) / top
			out[col * size + k] = (out[col * size + k] as number) / top
		}

		for (let row = 0; row < size; row++) {
			const factor = cells[row * size + col] as number

			if (row === col || factor === 0) continue

			for (let k = 0; k < size; k++) {
				cells[row * size + k] = (cells[row * size + k] as number) - factor * (cells[col * size + k] as number)
				out[row * size + k] = (out[row * size + k] as number) - factor * (out[col * size + k] as number)
			}
		}
	}

	return out
}

function dot(a: Float64Array, b: Float64Array): number {
	let sum = 0

	for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number)

	return sum
}

// A least-squares fit of y on columns of predictors, with or without a constant.
export interface Fit {
	// Each predictor's coefficient, in their order (0 for one left out as redundant).
	readonly slopes: Float64Array
	readonly constant: number
	// Whether each predictor is in the model (false: a linear combination of those before it).
	readonly used: readonly boolean[]
	// Each predictor's standard error (0 for one left out); NaN where the residual has no degrees of freedom.
	readonly errors: Float64Array
	readonly constantError: number
	readonly r2: number
	readonly sey: number
	readonly f: number
	readonly df: number
	readonly ssreg: number
	readonly ssresid: number
}

// A predictor whose remainder, after what the predictors before it explain, is below this share of its length adds
// nothing ("collinearity", LINEST's page): it is left out, its coefficient and standard error 0.
const REDUNDANT = 1e-12

// The fit by modified Gram-Schmidt (orthogonalized twice) on the predictors, centered when there is a constant.
export function regress(ys: Float64Array, xs: readonly Float64Array[], withConstant: boolean): Fit {
	const n = ys.length
	const k = xs.length
	const mean = (values: Float64Array): number => {
		let sum = 0

		for (const value of values) sum += value

		return sum / values.length
	}
	const yMean = withConstant ? mean(ys) : 0
	const xMeans = xs.map(x => (withConstant ? mean(x) : 0))
	const basis: Float64Array[] = []
	// R by columns of the predictors in the model: column j holds R[0..j][j].
	const columns: Float64Array[] = []
	const used: boolean[] = []
	const kept: number[] = []

	for (let j = 0; j < k; j++) {
		const x = xs[j] as Float64Array
		const shift = xMeans[j] as number
		const v = new Float64Array(n)

		for (let i = 0; i < n; i++) v[i] = (x[i] as number) - shift

		const length = Math.sqrt(dot(v, v))
		const r = new Float64Array(basis.length + 1)

		for (let pass = 0; pass < 2; pass++)
			basis.forEach((q, index) => {
				const projection = dot(q, v)

				r[index] = (r[index] as number) + projection

				for (let i = 0; i < n; i++) v[i] = (v[i] as number) - projection * (q[i] as number)
			})

		const rest = Math.sqrt(dot(v, v))

		if (length === 0 || rest <= length * REDUNDANT) {
			used.push(false)
			continue
		}

		for (let i = 0; i < n; i++) v[i] = (v[i] as number) / rest

		r[basis.length] = rest
		basis.push(v)
		columns.push(r)
		used.push(true)
		kept.push(j)
	}

	const residual = new Float64Array(n)

	for (let i = 0; i < n; i++) residual[i] = (ys[i] as number) - yMean

	const sstotal = withConstant ? dot(residual, residual) : dot(ys, ys)
	const projected = new Float64Array(basis.length)

	basis.forEach((q, index) => {
		const c = dot(q, residual)

		projected[index] = c

		for (let i = 0; i < n; i++) residual[i] = (residual[i] as number) - c * (q[i] as number)
	})

	const m = basis.length
	// Back substitution of R·β = Qᵀy.
	const beta = new Float64Array(m)

	for (let row = m - 1; row >= 0; row--) {
		let sum = projected[row] as number

		for (let col = row + 1; col < m; col++) sum -= ((columns[col] as Float64Array)[row] as number) * (beta[col] as number)

		beta[row] = sum / ((columns[row] as Float64Array)[row] as number)
	}

	// R⁻¹, upper triangular, row by row: (XᵀX)⁻¹ = R⁻¹R⁻ᵀ.
	const rInverse = new Float64Array(m * m)

	for (let col = 0; col < m; col++) {
		rInverse[col * m + col] = 1 / ((columns[col] as Float64Array)[col] as number)

		for (let row = col - 1; row >= 0; row--) {
			let sum = 0

			for (let mid = row + 1; mid <= col; mid++)
				sum += ((columns[mid] as Float64Array)[row] as number) * (rInverse[mid * m + col] as number)

			rInverse[row * m + col] = -sum / ((columns[row] as Float64Array)[row] as number)
		}
	}

	const slopes = new Float64Array(k)
	let constant = yMean

	kept.forEach((column, index) => {
		slopes[column] = beta[index] as number
		constant -= (beta[index] as number) * (xMeans[column] as number)
	})

	const ssresid = dot(residual, residual)
	const df = n - m - (withConstant ? 1 : 0)
	const sey = df > 0 ? Math.sqrt(ssresid / df) : Number.NaN
	const errors = new Float64Array(k)

	kept.forEach((column, index) => {
		let sum = 0

		for (let col = index; col < m; col++) sum += (rInverse[index * m + col] as number) ** 2

		errors[column] = sey * Math.sqrt(sum)
	})

	let constantError = Number.NaN

	if (withConstant) {
		let sum = 0

		for (let col = 0; col < m; col++) {
			let w = 0

			for (let row = 0; row <= col; row++) w += (xMeans[kept[row] as number] as number) * (rInverse[row * m + col] as number)

			sum += w * w
		}

		constantError = sey * Math.sqrt(1 / n + sum)
	}

	const ssreg = sstotal - ssresid

	return {
		slopes,
		constant: withConstant ? constant : 0,
		used,
		errors,
		constantError,
		r2: sstotal === 0 ? Number.NaN : ssreg / sstotal,
		sey,
		f: m === 0 || df === 0 || ssresid === 0 ? Number.NaN : ssreg / m / (ssresid / df),
		df,
		ssreg,
		ssresid
	}
}

// The known values of a regression: y, and the predictors as columns of observations. known_xs left out is 1, 2, 3,
// …; one predictor may have any shape of as many values as y; several are the columns (y a column) or rows (y a row)
// of known_xs. Sizes that do not fit are #REF!.
interface Known {
	readonly ys: Float64Array
	readonly xs: Float64Array[]
	// y is a column: the predictors are known_xs's columns (else its rows).
	readonly column: boolean
}

function known(knownYs: SimpleRangeValue, knownXs: SimpleRangeValue | undefined): Known | CellError {
	const ys = allNumbers(knownYs)

	if (ys instanceof CellError) return ys

	const n = ys.length
	const column = knownYs.width() === 1

	if (knownXs === undefined) return { ys, xs: [Float64Array.from({ length: n }, (_, index) => index + 1)], column }

	const values = allNumbers(knownXs)

	if (values instanceof CellError) return values

	const height = knownXs.height()
	const width = knownXs.width()

	if (column && height === n) {
		return {
			ys,
			xs: Array.from({ length: width }, (_, col) =>
				Float64Array.from({ length: n }, (__, row) => values[row * width + col] as number)
			),
			column
		}
	}

	if (knownYs.height() === 1 && width === n) {
		return { ys, xs: Array.from({ length: height }, (_, row) => values.subarray(row * width, (row + 1) * width)), column }
	}

	if (height === knownYs.height() && width === knownYs.width()) return { ys, xs: [values], column }

	return refError()
}

const REGRESSION = {
	parameters: [
		{ argumentType: FunctionArgumentType.RANGE },
		{ argumentType: FunctionArgumentType.RANGE, optionalArg: true },
		{ argumentType: FunctionArgumentType.BOOLEAN, defaultValue: true, emptyAsDefault: true },
		{ argumentType: FunctionArgumentType.BOOLEAN, defaultValue: false, emptyAsDefault: true }
	],
	enableArrayArithmeticForArguments: true,
	vectorizationForbidden: true
}

// A statistic, or #NUM! where it is undefined.
function stat(value: number): number | CellError {
	return Number.isFinite(value) ? value : numError()
}

// LINEST's (LOGEST's) array: the slopes in reverse order and the constant; with stats, below them their standard
// errors, then r2 and sey, F and df, ssreg and ssresid, #N/A filling the rest of those rows.
function regressionArray(fit: Fit, withConstant: boolean, stats: boolean, exponential: boolean): SimpleRangeValue {
	const k = fit.slopes.length
	const shown = (value: number): number => (exponential ? Math.exp(value) : value)
	const first: PluginScalar[] = []

	for (let j = k - 1; j >= 0; j--) first.push(shown(fit.slopes[j] as number))

	first.push(shown(fit.constant))

	if (!stats) return SimpleRangeValue.onlyValues([first])

	const errors: PluginScalar[] = []

	for (let j = k - 1; j >= 0; j--) errors.push(fit.used[j] === true ? stat(fit.errors[j] as number) : 0)

	errors.push(withConstant ? stat(fit.constantError) : naError())

	const row = (a: number | CellError, b: number | CellError): PluginScalar[] => [a, b, ...Array.from({ length: k - 1 }, () => naError())]

	return SimpleRangeValue.onlyValues([
		first,
		errors,
		row(stat(fit.r2), stat(fit.sey)),
		row(stat(fit.f), fit.df),
		row(fit.ssreg, fit.ssresid)
	])
}

export class MatrixFunctions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		MDETERM: {
			method: "mdeterm",
			parameters: [{ argumentType: FunctionArgumentType.RANGE }],
			enableArrayArithmeticForArguments: true,
			vectorizationForbidden: true
		},
		MINVERSE: {
			method: "minverse",
			parameters: [{ argumentType: FunctionArgumentType.RANGE }],
			enableArrayArithmeticForArguments: true,
			vectorizationForbidden: true
		},
		MUNIT: { method: "munit", parameters: [{ argumentType: FunctionArgumentType.NUMBER }], vectorizationForbidden: true },
		LINEST: { method: "linest", ...REGRESSION },
		LOGEST: { method: "logest", ...REGRESSION },
		GROWTH: {
			method: "growth",
			parameters: [
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.RANGE, optionalArg: true },
				{ argumentType: FunctionArgumentType.RANGE, optionalArg: true },
				{ argumentType: FunctionArgumentType.BOOLEAN, defaultValue: true, emptyAsDefault: true }
			],
			enableArrayArithmeticForArguments: true,
			vectorizationForbidden: true
		}
	}

	// MDETERM(array): the determinant of a square array of numbers; an empty cell, text, or a shape not square is
	// #VALUE!.
	mdeterm(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("MDETERM"), (array: SimpleRangeValue) => {
			const matrix = squareMatrix(array)

			return matrix instanceof CellError ? matrix : determinant(matrix.cells, matrix.size)
		})
	}

	// MINVERSE(array): the inverse of a square array of numbers; #NUM! for a matrix that has none.
	minverse(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("MINVERSE"), (array: SimpleRangeValue) => {
			const matrix = squareMatrix(array)

			if (matrix instanceof CellError) return matrix

			const inverted = inverse(matrix.cells, matrix.size)

			if (inverted === null) return numError()

			return SimpleRangeValue.onlyNumbers(
				Array.from({ length: matrix.size }, (_, row) => Array.from(inverted.subarray(row * matrix.size, (row + 1) * matrix.size)))
			)
		})
	}

	// MUNIT(dimension): the identity matrix of that size; a dimension of 0 or below, or one past the cells held here,
	// is #VALUE! (as Excel answers an oversized one). Checked here, not only in the cell formula's text, as a defined
	// name's expression or a computed dimension reaches it unbounded.
	munit(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("MUNIT"), (dimension: number) => {
			const size = Math.trunc(dimension)

			if (size <= 0 || size * size > MAX_ARRAY_CELLS) return valueError()

			return SimpleRangeValue.onlyNumbers(
				Array.from({ length: size }, (_, row) => {
					const line = new Array<number>(size).fill(0)

					line[row] = 1

					return line
				})
			)
		})
	}

	private regression(ast: PluginCall, state: PluginState, name: "LINEST" | "LOGEST"): unknown {
		const withXs = given(ast, 1)

		return this.runFunction(
			ast.args,
			state,
			this.metadata(name),
			(knownYs: SimpleRangeValue, knownXs: SimpleRangeValue | undefined, withConstant: boolean, stats: boolean) => {
				const data = known(knownYs, withXs ? knownXs : undefined)

				if (data instanceof CellError) return data

				const exponential = name === "LOGEST"
				const ys = exponential ? logs(data.ys) : data.ys

				if (ys === null) return numError()

				return regressionArray(regress(ys, data.xs, withConstant), withConstant, stats, exponential)
			}
		)
	}

	// LINEST(known_ys, [known_xs], [const], [stats]): the least-squares line's slopes (last predictor first) and
	// constant (0 when const is FALSE); with stats, the regression statistics below them.
	linest(ast: PluginCall, state: PluginState): unknown {
		return this.regression(ast, state, "LINEST")
	}

	// LOGEST: the same over ln y, its coefficients given as the bases of y = b·m1^x1·…; a y at or below 0 is #NUM!.
	logest(ast: PluginCall, state: PluginState): unknown {
		return this.regression(ast, state, "LOGEST")
	}

	// GROWTH(known_ys, [known_xs], [new_xs], [const]): the exponential curve LOGEST fits, at new_xs (known_xs by
	// default), as an array of new_xs's shape with one predictor, else one value per observation.
	growth(ast: PluginCall, state: PluginState): unknown {
		const withXs = given(ast, 1)
		const withNew = given(ast, 2)

		return this.runFunction(
			ast.args,
			state,
			this.metadata("GROWTH"),
			(
				knownYs: SimpleRangeValue,
				knownXs: SimpleRangeValue | undefined,
				newXs: SimpleRangeValue | undefined,
				withConstant: boolean
			) => {
				const xsGiven = withXs ? knownXs : undefined
				const data = known(knownYs, xsGiven)

				if (data instanceof CellError) return data

				const ys = logs(data.ys)

				if (ys === null) return numError()

				const fit = regress(ys, data.xs, withConstant)
				const k = data.xs.length
				const at = (values: ArrayLike<number>): number => {
					let sum = fit.constant

					for (let j = 0; j < k; j++) sum += (fit.slopes[j] as number) * (values[j] as number)

					return Math.exp(sum)
				}
				const target = withNew ? newXs : xsGiven

				if (target === undefined) {
					const width = knownYs.width()

					return SimpleRangeValue.onlyNumbers(
						Array.from({ length: knownYs.height() }, (_, row) =>
							Array.from({ length: width }, (__, col) => at([row * width + col + 1]))
						)
					)
				}

				const values = allNumbers(target)

				if (values instanceof CellError) return values

				const width = target.width()
				const height = target.height()

				if (k === 1)
					return SimpleRangeValue.onlyNumbers(
						Array.from({ length: height }, (_, row) =>
							Array.from({ length: width }, (__, col) => at([values[row * width + col] as number]))
						)
					)

				// One observation per row (y a column) or per column (y a row), each of k values.
				if (data.column ? width !== k : height !== k) return refError()

				const count = data.column ? height : width
				const observation = new Float64Array(k)

				return SimpleRangeValue.onlyNumbers(
					shaped(count, data.column, index => {
						for (let j = 0; j < k; j++) observation[j] = values[data.column ? index * width + j : j * width + index] as number

						return at(observation)
					})
				)
			}
		)
	}
}

// ln of each y, or null when one is at or below 0.
function logs(ys: Float64Array): Float64Array | null {
	const out = new Float64Array(ys.length)

	for (let i = 0; i < ys.length; i++) {
		const y = ys[i] as number

		if (y <= 0) return null

		out[i] = Math.log(y)
	}

	return out
}

// `count` values as a column or a row.
function shaped(count: number, column: boolean, value: (index: number) => number): number[][] {
	const values = Array.from({ length: count }, (_, index) => value(index))

	return column ? values.map(item => [item]) : [values]
}
