import { CellError, FunctionArgumentType, type FunctionArgument, type FunctionPlugin, type ImplementedFunctions } from "hyperformula"
import { MAX_SERIAL_1900, MAX_SERIAL_1904 } from "../../numfmt"
import {
	accruedInterest,
	amorDegrc,
	amorLinc,
	bondPrice,
	bondYield,
	couponCount,
	couponDays,
	couponDaysBefore,
	couponDaysNext,
	couponNext,
	couponPrevious,
	dateToSerial,
	duration,
	oddFirstPricer,
	oddLastPrice,
	oddLastYield,
	serialToDate,
	solveYield,
	variableDeclining,
	VDB_MAX_PERIODS,
	yearDifference,
	yearFraction,
	type Basis,
	type BondDate
} from "./bondMath"
import type { DateBase } from "../../numfmt/date"
import { dateBaseOf, numError, SheetFunctionPlugin, valueError, type PluginCall, type PluginState } from "./plugin"

// Excel's bond and depreciation functions, as support.microsoft.com defines them: dates, frequency and basis are
// truncated to integers; a date that is no valid serial is #VALUE!, the other conditions each page lists #NUM!.

const NUMBER: FunctionArgument = { argumentType: FunctionArgumentType.NUMBER }
const BASIS: FunctionArgument = { argumentType: FunctionArgumentType.NUMBER, defaultValue: 0 }
const PAR: FunctionArgument = { argumentType: FunctionArgumentType.NUMBER, defaultValue: 1000, emptyAsDefault: true }

// Numbers, then an optional basis.
function numbers(count: number): { parameters: FunctionArgument[] } {
	return { parameters: [...new Array<FunctionArgument>(count).fill(NUMBER), BASIS] }
}

function basisOf(value: number): Basis | undefined {
	const basis = Math.trunc(value)

	return basis >= 0 && basis <= 4 ? (basis as Basis) : undefined
}

function frequencyOf(value: number): number | undefined {
	const frequency = Math.trunc(value)

	return frequency === 1 || frequency === 2 || frequency === 4 ? frequency : undefined
}

function finite(value: number): number | CellError {
	return Number.isFinite(value) ? value : numError()
}

type Dated = (dates: BondDate[], basis: Basis) => number | CellError

// A function's calculation as the engine calls it, with the arguments coerced.
type Implementation = Parameters<FunctionPlugin["runFunction"]>[3]

export class BondFunctions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		ACCRINT: {
			method: "accrint",
			parameters: [
				NUMBER,
				NUMBER,
				NUMBER,
				NUMBER,
				PAR,
				NUMBER,
				BASIS,
				{ argumentType: FunctionArgumentType.BOOLEAN, defaultValue: true }
			]
		},
		ACCRINTM: { method: "accrintm", parameters: [NUMBER, NUMBER, NUMBER, PAR, BASIS] },
		AMORDEGRC: { method: "amordegrc", ...numbers(6) },
		AMORLINC: { method: "amorlinc", ...numbers(6) },
		COUPDAYBS: { method: "coupdaybs", ...numbers(3) },
		COUPDAYS: { method: "coupdays", ...numbers(3) },
		COUPDAYSNC: { method: "coupdaysnc", ...numbers(3) },
		COUPNCD: { method: "coupncd", ...numbers(3) },
		COUPNUM: { method: "coupnum", ...numbers(3) },
		COUPPCD: { method: "couppcd", ...numbers(3) },
		DISC: { method: "disc", ...numbers(4) },
		DURATION: { method: "duration", ...numbers(5) },
		INTRATE: { method: "intrate", ...numbers(4) },
		MDURATION: { method: "mduration", ...numbers(5) },
		ODDFPRICE: { method: "oddfprice", ...numbers(8) },
		ODDFYIELD: { method: "oddfyield", ...numbers(8) },
		ODDLPRICE: { method: "oddlprice", ...numbers(7) },
		ODDLYIELD: { method: "oddlyield", ...numbers(7) },
		PRICE: { method: "price", ...numbers(6) },
		PRICEDISC: { method: "pricedisc", ...numbers(4) },
		PRICEMAT: { method: "pricemat", ...numbers(5) },
		RECEIVED: { method: "received", ...numbers(4) },
		VDB: {
			method: "vdb",
			parameters: [
				NUMBER,
				NUMBER,
				NUMBER,
				NUMBER,
				NUMBER,
				{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 2 },
				{ argumentType: FunctionArgumentType.BOOLEAN, defaultValue: false, emptyAsDefault: true }
			]
		},
		YIELD: { method: "yield", ...numbers(6) },
		YIELDDISC: { method: "yielddisc", ...numbers(4) },
		YIELDMAT: { method: "yieldmat", ...numbers(5) }
	}

	private get date1904(): DateBase {
		return dateBaseOf(this.config)
	}

	// The date of a serial argument, truncated; undefined for no valid date.
	private dateOf(serial: number): BondDate | undefined {
		const day = Math.trunc(serial)

		return day >= 0 && day <= (this.date1904 === true ? MAX_SERIAL_1904 : MAX_SERIAL_1900)
			? serialToDate(day, this.date1904)
			: undefined
	}

	// A function of leading date arguments and a basis: #VALUE! for a date that is none, #NUM! for a basis out of 0-4.
	private dated(dates: readonly number[], basis: number, work: Dated): number | CellError {
		const read: BondDate[] = []

		for (const serial of dates) {
			const date = this.dateOf(serial)

			if (date === undefined) return valueError()

			read.push(date)
		}

		const checked = basisOf(basis)

		if (checked === undefined) return numError()

		const result = work(read, checked)

		return result instanceof CellError ? result : finite(result)
	}

	private run(ast: PluginCall, state: PluginState, name: string, work: Implementation): unknown {
		return this.runFunction(ast.args, state, this.metadata(name), work)
	}

	// The coupon functions: settlement before maturity, a frequency of 1, 2 or 4.
	private coupon(
		ast: PluginCall,
		state: PluginState,
		name: string,
		work: (settlement: BondDate, maturity: BondDate, frequency: number, basis: Basis) => number
	): unknown {
		return this.run(ast, state, name, (settlement: number, maturity: number, frequency: number, basis: number) =>
			this.dated([settlement, maturity], basis, ([start, end], checked) => {
				const periods = frequencyOf(frequency)

				if (start === undefined || end === undefined || periods === undefined || start.days >= end.days) return numError()

				return work(start, end, periods, checked)
			})
		)
	}

	accrint(ast: PluginCall, state: PluginState): unknown {
		return this.run(
			ast,
			state,
			"ACCRINT",
			(
				issue: number,
				firstInterest: number,
				settlement: number,
				rate: number,
				par: number,
				frequency: number,
				basis: number,
				fromIssue: boolean
			) =>
				this.dated([issue, firstInterest, settlement], basis, ([start, first, end], checked) => {
					const periods = frequencyOf(frequency)

					if (start === undefined || first === undefined || end === undefined) return numError()
					if (rate <= 0 || par <= 0 || periods === undefined || start.days >= end.days) return numError()

					return accruedInterest(start, first, end, rate, par, periods, checked, fromIssue)
				})
		)
	}

	accrintm(ast: PluginCall, state: PluginState): unknown {
		return this.run(ast, state, "ACCRINTM", (issue: number, settlement: number, rate: number, par: number, basis: number) =>
			this.dated([issue, settlement], basis, ([start, end], checked) => {
				if (start === undefined || end === undefined || rate <= 0 || par <= 0 || start.days >= end.days) return numError()

				return par * rate * yearDifference(start, end, checked)
			})
		)
	}

	// AMORDEGRC and AMORLINC take the bases the pages list (0, 1, 3 and 4); the date purchased is not after the end of
	// the first period, the rate is above 0, the salvage within the cost, the period not negative.
	private amortization(ast: PluginCall, state: PluginState, name: string, degressive: boolean): unknown {
		return this.run(
			ast,
			state,
			name,
			(cost: number, purchased: number, firstPeriod: number, salvage: number, period: number, rate: number, basis: number) =>
				this.dated([purchased, firstPeriod], basis, ([bought, first], checked) => {
					if (bought === undefined || first === undefined || checked === 2) return numError()
					if (bought.days > first.days || rate <= 0 || salvage > cost || cost <= 0 || salvage < 0 || period < 0) return numError()

					const whole = Math.trunc(period)

					if (!degressive) return amorLinc(cost, bought, first, salvage, whole, rate, checked)

					// "If the life of assets is between 0 (zero) and 1, 1 and 2, 2 and 3, or 4 and 5, the #NUM! error value
					// is returned."
					const life = 1 / rate

					if (life < 3 || (life > 4 && life < 5)) return numError()

					return amorDegrc(cost, bought, first, salvage, whole, rate, checked)
				})
		)
	}

	amordegrc(ast: PluginCall, state: PluginState): unknown {
		return this.amortization(ast, state, "AMORDEGRC", true)
	}

	amorlinc(ast: PluginCall, state: PluginState): unknown {
		return this.amortization(ast, state, "AMORLINC", false)
	}

	coupdaybs(ast: PluginCall, state: PluginState): unknown {
		return this.coupon(ast, state, "COUPDAYBS", couponDaysBefore)
	}

	coupdays(ast: PluginCall, state: PluginState): unknown {
		return this.coupon(ast, state, "COUPDAYS", couponDays)
	}

	coupdaysnc(ast: PluginCall, state: PluginState): unknown {
		return this.coupon(ast, state, "COUPDAYSNC", couponDaysNext)
	}

	coupncd(ast: PluginCall, state: PluginState): unknown {
		return this.coupon(ast, state, "COUPNCD", (settlement, maturity, frequency, basis) =>
			dateToSerial(couponNext(settlement, maturity, frequency, basis), this.date1904)
		)
	}

	coupnum(ast: PluginCall, state: PluginState): unknown {
		return this.coupon(ast, state, "COUPNUM", couponCount)
	}

	couppcd(ast: PluginCall, state: PluginState): unknown {
		return this.coupon(ast, state, "COUPPCD", (settlement, maturity, frequency, basis) =>
			dateToSerial(couponPrevious(settlement, maturity, frequency, basis), this.date1904)
		)
	}

	// The discount securities: settlement before maturity, both amounts above 0.
	private discounted(
		ast: PluginCall,
		state: PluginState,
		name: string,
		work: (settlement: BondDate, maturity: BondDate, first: number, second: number, basis: Basis) => number
	): unknown {
		return this.run(ast, state, name, (settlement: number, maturity: number, first: number, second: number, basis: number) =>
			this.dated([settlement, maturity], basis, ([start, end], checked) => {
				if (start === undefined || end === undefined || first <= 0 || second <= 0 || start.days >= end.days) return numError()

				return work(start, end, first, second, checked)
			})
		)
	}

	disc(ast: PluginCall, state: PluginState): unknown {
		return this.discounted(
			ast,
			state,
			"DISC",
			(start, end, pr, redemption, basis) => (1 - pr / redemption) / yearFraction(start, end, basis)
		)
	}

	intrate(ast: PluginCall, state: PluginState): unknown {
		return this.discounted(
			ast,
			state,
			"INTRATE",
			(start, end, investment, redemption, basis) => (redemption / investment - 1) / yearDifference(start, end, basis)
		)
	}

	pricedisc(ast: PluginCall, state: PluginState): unknown {
		return this.discounted(
			ast,
			state,
			"PRICEDISC",
			(start, end, discount, redemption, basis) => redemption * (1 - discount * yearDifference(start, end, basis))
		)
	}

	received(ast: PluginCall, state: PluginState): unknown {
		return this.discounted(
			ast,
			state,
			"RECEIVED",
			(start, end, investment, discount, basis) => investment / (1 - discount * yearDifference(start, end, basis))
		)
	}

	yielddisc(ast: PluginCall, state: PluginState): unknown {
		return this.discounted(
			ast,
			state,
			"YIELDDISC",
			(start, end, pr, redemption, basis) => (redemption / pr - 1) / yearFraction(start, end, basis)
		)
	}

	private durations(ast: PluginCall, state: PluginState, name: string, modified: boolean): unknown {
		return this.run(
			ast,
			state,
			name,
			(settlement: number, maturity: number, coupon: number, yld: number, frequency: number, basis: number) =>
				this.dated([settlement, maturity], basis, ([start, end], checked) => {
					const periods = frequencyOf(frequency)

					if (start === undefined || end === undefined || periods === undefined) return numError()
					if (coupon < 0 || yld < 0 || start.days >= end.days) return numError()

					const years = duration(start, end, coupon, yld, periods, checked)

					return modified ? years / (1 + yld / periods) : years
				})
		)
	}

	duration(ast: PluginCall, state: PluginState): unknown {
		return this.durations(ast, state, "DURATION", false)
	}

	mduration(ast: PluginCall, state: PluginState): unknown {
		return this.durations(ast, state, "MDURATION", true)
	}

	// ODDFPRICE and ODDFYIELD: maturity > first_coupon > settlement > issue.
	private oddFirst(ast: PluginCall, state: PluginState, name: string, price: boolean): unknown {
		return this.run(
			ast,
			state,
			name,
			(
				settlement: number,
				maturity: number,
				issue: number,
				firstCoupon: number,
				rate: number,
				value: number,
				redemption: number,
				frequency: number,
				basis: number
			) =>
				this.dated([settlement, maturity, issue, firstCoupon], basis, ([start, end, issued, first], checked) => {
					const periods = frequencyOf(frequency)

					if (start === undefined || end === undefined || issued === undefined || first === undefined) return numError()
					if (periods === undefined || rate < 0 || (price ? value < 0 : value <= 0)) return numError()
					if (!(end.days > first.days && first.days > start.days && start.days > issued.days)) return numError()

					const pricer = oddFirstPricer(start, end, issued, first, rate, redemption, periods, checked)

					return price ? pricer(value) : solveYield(yld => pricer(yld) - value, periods, 0.05)
				})
		)
	}

	oddfprice(ast: PluginCall, state: PluginState): unknown {
		return this.oddFirst(ast, state, "ODDFPRICE", true)
	}

	oddfyield(ast: PluginCall, state: PluginState): unknown {
		return this.oddFirst(ast, state, "ODDFYIELD", false)
	}

	// ODDLPRICE and ODDLYIELD: maturity > settlement > last_interest, a redemption above 0.
	private oddLast(ast: PluginCall, state: PluginState, name: string, price: boolean): unknown {
		return this.run(
			ast,
			state,
			name,
			(
				settlement: number,
				maturity: number,
				lastInterest: number,
				rate: number,
				value: number,
				redemption: number,
				frequency: number,
				basis: number
			) =>
				this.dated([settlement, maturity, lastInterest], basis, ([start, end, last], checked) => {
					const periods = frequencyOf(frequency)

					if (start === undefined || end === undefined || last === undefined || periods === undefined) return numError()
					if (rate < 0 || (price ? value < 0 : value <= 0) || redemption <= 0) return numError()
					if (!(end.days > start.days && start.days > last.days)) return numError()

					return (price ? oddLastPrice : oddLastYield)(start, end, last, rate, value, redemption, periods, checked)
				})
		)
	}

	oddlprice(ast: PluginCall, state: PluginState): unknown {
		return this.oddLast(ast, state, "ODDLPRICE", true)
	}

	oddlyield(ast: PluginCall, state: PluginState): unknown {
		return this.oddLast(ast, state, "ODDLYIELD", false)
	}

	price(ast: PluginCall, state: PluginState): unknown {
		return this.run(
			ast,
			state,
			"PRICE",
			(settlement: number, maturity: number, rate: number, yld: number, redemption: number, frequency: number, basis: number) =>
				this.dated([settlement, maturity], basis, ([start, end], checked) => {
					const periods = frequencyOf(frequency)

					if (start === undefined || end === undefined || periods === undefined) return numError()
					if (yld < 0 || rate < 0 || redemption <= 0 || start.days >= end.days) return numError()

					return bondPrice(start, end, rate, yld, redemption, periods, checked)
				})
		)
	}

	yield(ast: PluginCall, state: PluginState): unknown {
		return this.run(
			ast,
			state,
			"YIELD",
			(settlement: number, maturity: number, rate: number, pr: number, redemption: number, frequency: number, basis: number) =>
				this.dated([settlement, maturity], basis, ([start, end], checked) => {
					const periods = frequencyOf(frequency)

					if (start === undefined || end === undefined || periods === undefined) return numError()
					if (rate < 0 || pr <= 0 || redemption <= 0 || start.days >= end.days) return numError()

					return bondYield(start, end, rate, pr, redemption, periods, checked)
				})
		)
	}

	// PRICEMAT and YIELDMAT, interest at maturity: settlement before maturity.
	private atMaturity(ast: PluginCall, state: PluginState, name: string, price: boolean): unknown {
		return this.run(
			ast,
			state,
			name,
			(settlement: number, maturity: number, issue: number, rate: number, value: number, basis: number) =>
				this.dated([settlement, maturity, issue], basis, ([start, end, issued], checked) => {
					if (start === undefined || end === undefined || issued === undefined) return numError()
					if (rate < 0 || (price ? value < 0 : value <= 0) || start.days >= end.days) return numError()

					const issueToMaturity = yearFraction(issued, end, checked)
					const issueToSettlement = yearFraction(issued, start, checked)
					const settlementToMaturity = yearFraction(start, end, checked)

					if (price) return ((1 + issueToMaturity * rate) / (1 + settlementToMaturity * value) - issueToSettlement * rate) * 100

					// Issued after settlement: no interest accrued to settlement.
					if (start.days < issued.days) return numError()

					return ((1 + issueToMaturity * rate) / (value / 100 + issueToSettlement * rate) - 1) / settlementToMaturity
				})
		)
	}

	pricemat(ast: PluginCall, state: PluginState): unknown {
		return this.atMaturity(ast, state, "PRICEMAT", true)
	}

	yieldmat(ast: PluginCall, state: PluginState): unknown {
		return this.atMaturity(ast, state, "YIELDMAT", false)
	}

	// VDB: "All arguments except no_switch must be positive numbers"; the periods within the life, the salvage within the
	// cost.
	vdb(ast: PluginCall, state: PluginState): unknown {
		return this.run(
			ast,
			state,
			"VDB",
			(cost: number, salvage: number, life: number, start: number, end: number, factor: number, noSwitch: boolean) => {
				if (cost < 0 || salvage < 0 || life <= 0 || start < 0 || end < start || end > life || factor <= 0 || salvage > cost)
					return numError()

				// A schedule of more periods than any real asset has would hang the calculation.
				if (Math.ceil(end) > VDB_MAX_PERIODS) return numError()

				return finite(variableDeclining(cost, salvage, life, start, end, factor, noSwitch))
			}
		)
	}
}
