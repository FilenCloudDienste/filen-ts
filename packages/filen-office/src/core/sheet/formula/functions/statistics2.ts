import { CellError, EmptyValue, FunctionArgumentType, SimpleRangeValue, type ImplementedFunctions } from "hyperformula"
import {
	ARRAY_ARGUMENTS,
	divError,
	naError,
	numError,
	rawNumber,
	SheetFunctionPlugin,
	valueError,
	type PluginCall,
	type PluginScalar,
	type PluginState
} from "./plugin"
import { at, linearFit, rangeNumbers } from "./statistics"

// Statistical and math functions as support.microsoft.com defines them (each on its own page).

const SQRT_PI = Math.sqrt(Math.PI)

// erf(x) for |x| < 2 by its series of positive terms, 2/√π·e^(-x²)·Σ 2ⁿx^(2n+1)/(1·3·…·(2n+1)) (no cancellation).
function erfSeries(x: number): number {
	const square = x * x
	let term = x
	let sum = x

	for (let n = 1; n < 200 && Math.abs(term) > Math.abs(sum) * 1e-17; n++) {
		term *= (2 * square) / (2 * n + 1)
		sum += term
	}

	return (2 / SQRT_PI) * Math.exp(-square) * sum
}

// erfc(x) for x ≥ 2 by its continued fraction, e^(-x²)/√π · 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + …)))), evaluated
// by the modified Lentz method.
function erfcFraction(x: number): number {
	const tiny = 1e-300
	let f = x
	let c = x
	let d = 0

	for (let n = 1; n < 500; n++) {
		const a = n / 2

		d = x + a * d
		d = d === 0 ? tiny : d
		c = x + a / c
		c = c === 0 ? tiny : c
		d = 1 / d

		const delta = c * d

		f *= delta

		if (Math.abs(delta - 1) < 1e-16) break
	}

	return Math.exp(-x * x) / (SQRT_PI * f)
}

export function erf(x: number): number {
	if (Math.abs(x) < 2) return erfSeries(x)

	const tail = erfcFraction(Math.abs(x))

	return x > 0 ? 1 - tail : tail - 1
}

export function erfc(x: number): number {
	if (Math.abs(x) < 2) return 1 - erfSeries(x)

	const tail = erfcFraction(Math.abs(x))

	return x > 0 ? tail : 2 - tail
}

const LANCZOS = [
	0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
	-0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
]

// ln Γ(x) for x ≥ 1 (the Lanczos approximation, g = 7).
function logGamma(x: number): number {
	const z = x - 1
	let sum = LANCZOS[0] as number

	for (let i = 1; i < LANCZOS.length; i++) sum += (LANCZOS[i] as number) / (z + i)

	const t = z + 7.5

	return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum)
}

// Trials past which the most likely term's log-gamma differences lose their digits (and the sum runs to millions of
// terms): such a count is refused rather than answered wrongly or slowly.
const MAX_BINOMIAL_TRIALS = 1e10

// The probability of `from` to `to` successes in `trials` trials of probability p, the terms summed from the most
// likely one in the span outwards until they no longer count (the terms fall away from the distribution's mode).
// NaN for a count it cannot answer.
export function binomialRange(trials: number, p: number, from: number, to: number): number {
	if (p === 0) return from === 0 ? 1 : 0
	if (p === 1) return to === trials ? 1 : 0
	if (!(trials <= MAX_BINOMIAL_TRIALS)) return NaN

	const start = Math.min(to, Math.max(from, Math.floor((trials + 1) * p)))
	const odds = p / (1 - p)
	const first = Math.exp(
		logGamma(trials + 1) - logGamma(start + 1) - logGamma(trials - start + 1) + start * Math.log(p) + (trials - start) * Math.log1p(-p)
	)

	if (!Number.isFinite(first)) return NaN
	// The span's largest term underflowed: so did every other.
	if (first === 0) return 0

	// Every term that counts lies within some 9 standard deviations of the mode; the cap only bounds the loops.
	const terms = 40 * Math.sqrt(trials * p * (1 - p)) + 64
	let sum = first
	let term = first

	for (let k = start, last = Math.min(to, start + terms); k < last; k++) {
		term *= ((trials - k) / (k + 1)) * odds

		if (term <= sum * 1e-17) break

		sum += term
	}

	term = first

	for (let k = start, last = Math.max(from, start - terms); k > last; k--) {
		term *= k / ((trials - k + 1) * odds)

		if (term <= sum * 1e-17) break

		sum += term
	}

	return sum
}

// The sum of the numbers of a range or array, or its first error.
function sumOf(value: SimpleRangeValue): number | CellError {
	let sum = 0

	for (const row of value.data)
		for (const cell of row) {
			if (cell instanceof CellError) return cell

			sum += rawNumber(cell) ?? 0
		}

	return sum
}

// A number cut (not rounded) to `digits` decimals: PERCENTRANK's significance. The product is read at 15
// significant digits first, so 0.7 × 1000 is 700, not 699.99….
function truncated(value: number, digits: number): number {
	const scale = 10 ** digits

	return Math.floor(Number((value * scale).toPrecision(15))) / scale
}

const RANKS = {
	parameters: [
		{ argumentType: FunctionArgumentType.RANGE },
		{ argumentType: FunctionArgumentType.NUMBER },
		{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 3 }
	],
	...ARRAY_ARGUMENTS
}
const COUNTS = { parameters: [{ argumentType: FunctionArgumentType.NUMBER }, { argumentType: FunctionArgumentType.NUMBER }] }

export class Statistics2Functions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		"BINOM.DIST.RANGE": {
			method: "binomDistRange",
			parameters: [
				{ argumentType: FunctionArgumentType.NUMBER },
				{ argumentType: FunctionArgumentType.NUMBER },
				{ argumentType: FunctionArgumentType.NUMBER },
				{ argumentType: FunctionArgumentType.NUMBER, optionalArg: true }
			]
		},
		"ERF.PRECISE": { method: "erfPrecise", parameters: [{ argumentType: FunctionArgumentType.NUMBER }] },
		"ERFC.PRECISE": { method: "erfcPrecise", parameters: [{ argumentType: FunctionArgumentType.NUMBER }] },
		GESTEP: {
			method: "gestep",
			parameters: [{ argumentType: FunctionArgumentType.SCALAR }, { argumentType: FunctionArgumentType.SCALAR, defaultValue: 0 }]
		},
		INTERCEPT: {
			method: "intercept",
			parameters: [{ argumentType: FunctionArgumentType.RANGE }, { argumentType: FunctionArgumentType.RANGE }],
			...ARRAY_ARGUMENTS
		},
		PERMUT: { method: "permut", ...COUNTS },
		PERMUTATIONA: { method: "permutationa", ...COUNTS },
		PERCENTRANK: { method: "percentrankInc", ...RANKS },
		"PERCENTRANK.INC": { method: "percentrankInc", ...RANKS },
		"PERCENTRANK.EXC": { method: "percentrankExc", ...RANKS },
		TRIMMEAN: {
			method: "trimmean",
			parameters: [{ argumentType: FunctionArgumentType.RANGE }, { argumentType: FunctionArgumentType.NUMBER }],
			...ARRAY_ARGUMENTS
		},
		PROB: {
			method: "prob",
			parameters: [
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.NUMBER },
				{ argumentType: FunctionArgumentType.NUMBER, optionalArg: true }
			],
			...ARRAY_ARGUMENTS
		},
		PERCENTOF: {
			method: "percentof",
			parameters: [{ argumentType: FunctionArgumentType.RANGE }, { argumentType: FunctionArgumentType.RANGE }],
			...ARRAY_ARGUMENTS
		}
	}

	// BINOM.DIST.RANGE(trials, probability_s, number_s, [number_s2]): the probability of number_s to number_s2
	// successes (number_s alone without it); counts truncated to integers, each outside its bounds #NUM!.
	binomDistRange(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("BINOM.DIST.RANGE"),
			(trials: number, p: number, first: number, second: number | undefined) => {
				const n = Math.trunc(trials)
				const from = Math.trunc(first)
				const to = second === undefined ? from : Math.trunc(second)

				if (n < 0 || n > Number.MAX_SAFE_INTEGER || p < 0 || p > 1 || from < 0 || from > n || to < from || to > n) return numError()

				const probability = binomialRange(n, p, from, to)

				return Number.isNaN(probability) ? numError() : probability
			}
		)
	}

	erfPrecise(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("ERF.PRECISE"), erf)
	}

	erfcPrecise(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("ERFC.PRECISE"), erfc)
	}

	// A number argument of the engineering functions: text that reads as a number counts, an empty cell is 0; a
	// logical value or other text is #VALUE! ("If any argument is nonnumeric").
	private engineeringNumber(value: PluginScalar): number | CellError {
		if (value instanceof CellError) return value
		if (value === EmptyValue) return 0
		if (typeof value === "boolean") return valueError()

		return this.numberOf(value)
	}

	// GESTEP(number, [step]): 1 when number ≥ step (0 by default), else 0.
	gestep(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("GESTEP"), (value: PluginScalar, threshold: PluginScalar) => {
			const number = this.engineeringNumber(value)

			if (number instanceof CellError) return number

			const step = this.engineeringNumber(threshold)

			if (step instanceof CellError) return step

			return number >= step ? 1 : 0
		})
	}

	// INTERCEPT(known_ys, known_xs): where the least-squares line crosses the y-axis. Pairs where either value is
	// not a number are left out; arrays of different sizes, or no pairs, are #N/A; no spread in x is #DIV/0!.
	intercept(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("INTERCEPT"), (ys: SimpleRangeValue, xs: SimpleRangeValue) => {
			const fit = linearFit(ys, xs)

			if (fit instanceof CellError) return fit

			return fit.yMean - fit.slope * fit.xMean
		})
	}

	// PERMUT(number, number_chosen): number!/(number - number_chosen)!, both truncated; number ≤ 0, number_chosen < 0
	// or number < number_chosen is #NUM!.
	permut(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("PERMUT"), (total: number, chosen: number) => {
			const n = Math.trunc(total)
			const k = Math.trunc(chosen)

			if (n <= 0 || k < 0 || n < k) return numError()

			let product = 1

			for (let i = 0; i < k && Number.isFinite(product); i++) product *= n - i

			return Number.isFinite(product) ? product : numError()
		})
	}

	// PERMUTATIONA(number, number_chosen): number^number_chosen, both truncated; a negative one, or number 0 with
	// number_chosen above 0, is #NUM!.
	permutationa(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("PERMUTATIONA"), (total: number, chosen: number) => {
			const n = Math.trunc(total)
			const k = Math.trunc(chosen)

			if (n < 0 || k < 0 || (n === 0 && k > 0)) return numError()

			const power = n ** k

			return Number.isFinite(power) ? power : numError()
		})
	}

	// PERCENTRANK, PERCENTRANK.INC and PERCENTRANK.EXC(array, x, [significance]): x's rank among the numbers of array,
	// interpolated between the numbers either side of it, cut to `significance` decimals (3 by default). A number's
	// rank is the count below it over n - 1 (inclusive) or, plus 1, over n + 1 (exclusive). No numbers, or significance
	// below 1, is #NUM!; x outside the numbers is #VALUE! (the pages are silent; LibreOffice's reading).
	private percentrank(ast: PluginCall, state: PluginState, name: string, exclusive: boolean): unknown {
		return this.runFunction(ast.args, state, this.metadata(name), (array: SimpleRangeValue, x: number, significance: number) => {
			const digits = Math.trunc(significance)
			let n = 0
			let below = 0
			let equal = 0
			let lower = Number.NEGATIVE_INFINITY
			let lowerCount = 0
			let upper = Number.POSITIVE_INFINITY

			for (const row of array.data)
				for (const cell of row) {
					if (cell instanceof CellError) return cell

					const number = rawNumber(cell)

					if (number === undefined) continue

					n++

					if (number < x) {
						below++

						if (number > lower) {
							lower = number
							lowerCount = 1
						} else if (number === lower) lowerCount++
					} else if (number > x) upper = Math.min(upper, number)
					else equal++
				}

			if (n === 0 || digits < 1) return numError()

			// One number is its own rank 1 (the pages are silent; LibreOffice's reading).
			const rank = (count: number): number => (n === 1 ? 1 : exclusive ? (count + 1) / (n + 1) : count / (n - 1))

			if (equal > 0) return truncated(rank(below), digits)
			if (lower === Number.NEGATIVE_INFINITY || upper === Number.POSITIVE_INFINITY) return valueError()

			const low = rank(below - lowerCount)
			const high = rank(below)

			return truncated(low + ((x - lower) / (upper - lower)) * (high - low), digits)
		})
	}

	percentrankInc(ast: PluginCall, state: PluginState): unknown {
		return this.percentrank(ast, state, ast.procedureName.toUpperCase() === "PERCENTRANK" ? "PERCENTRANK" : "PERCENTRANK.INC", false)
	}

	percentrankExc(ast: PluginCall, state: PluginState): unknown {
		return this.percentrank(ast, state, "PERCENTRANK.EXC", true)
	}

	// TRIMMEAN(array, percent): the mean of the numbers without the share `percent` of them, half from each end, the
	// count left out rounded down to an even number. percent outside 0 to 1 is #NUM!.
	trimmean(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("TRIMMEAN"), (array: SimpleRangeValue, percent: number) => {
			const numbers: number[] = []
			const error = rangeNumbers(array.data, numbers)

			if (error !== null) return error
			if (percent < 0 || percent > 1 || numbers.length === 0) return numError()

			const sorted = Float64Array.from(numbers).sort()
			const cut = Math.floor((sorted.length * percent) / 2)

			if (2 * cut >= sorted.length) return numError()

			let sum = 0

			for (let index = cut; index < sorted.length - cut; index++) sum += sorted[index] as number

			return sum / (sorted.length - 2 * cut)
		})
	}

	// PROB(x_range, prob_range, lower_limit, [upper_limit]): the sum of the probabilities of the xs from lower_limit to
	// upper_limit (equal to lower_limit without it). A probability at or below 0 or above 1, or probabilities that do
	// not sum to 1, is #NUM!; ranges of different sizes are #N/A.
	prob(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("PROB"),
			(xs: SimpleRangeValue, ps: SimpleRangeValue, lower: number, upper: number | undefined) => {
				const size = xs.width() * xs.height()

				if (size !== ps.width() * ps.height()) return naError()

				const high = upper ?? lower
				let total = 0
				let inside = 0

				for (let index = 0; index < size; index++) {
					const x = at(xs, index)
					const p = at(ps, index)

					if (x instanceof CellError) return x
					if (p instanceof CellError) return p

					const xNumber = rawNumber(x)
					const pNumber = rawNumber(p)

					if (xNumber === undefined || pNumber === undefined) continue
					if (pNumber <= 0 || pNumber > 1) return numError()

					total += pNumber

					if (xNumber >= lower && xNumber <= high) inside += pNumber
				}

				return Math.abs(total - 1) > 1e-12 ? numError() : inside
			}
		)
	}

	// PERCENTOF(data_subset, data_all): the sum of the subset over the sum of all; a sum of all of 0 is #DIV/0!.
	percentof(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("PERCENTOF"), (subset: SimpleRangeValue, all: SimpleRangeValue) => {
			const part = sumOf(subset)

			if (part instanceof CellError) return part

			const whole = sumOf(all)

			if (whole instanceof CellError) return whole

			return whole === 0 ? divError() : part / whole
		})
	}
}
