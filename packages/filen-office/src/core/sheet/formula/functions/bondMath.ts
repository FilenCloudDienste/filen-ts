import { dateSerial, serialDate, type DateBase, type DateParts } from "../../numfmt/date"

// Bond and depreciation arithmetic of Excel's financial functions, on calendar dates. Day-count bases: 0 US (NASD)
// 30/360, 1 actual/actual, 2 actual/360, 3 actual/365, 4 European 30/360. Where support.microsoft.com gives no
// algorithm, LibreOffice's analysis add-in is followed (MPL-2.0; see THIRD_PARTY_NOTICES.md).

export type Basis = 0 | 1 | 2 | 3 | 4

export interface BondDate {
	readonly year: number
	readonly month: number
	readonly day: number
	// Days on a plain proleptic Gregorian count, for actual-day differences.
	readonly days: number
}

function isLeap(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function monthDays(month: number, year: number): number {
	return month === 2 ? (isLeap(year) ? 29 : 28) : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

function bondDate(year: number, month: number, day: number): BondDate {
	return { year, month, day, days: dateSerial(year, month, day, true) }
}

const parts: DateParts = { year: 0, month: 0, day: 0, weekday: 0 }

// The date of a whole serial day in a workbook's date system.
export function serialToDate(serial: number, date1904: DateBase): BondDate {
	serialDate(serial, date1904, parts)

	return bondDate(parts.year, parts.month, parts.day)
}

export function dateToSerial(date: BondDate, date1904: DateBase): number {
	return dateSerial(date.year, date.month, date.day, date1904)
}

// A coupon date stepped by months: the day of the month it started from is kept (the last day of a month stays the
// last day), and in the 30-day bases no day is past the 30th.
class CouponDate {
	private origDay: number
	private day = 0
	private month: number
	private year: number
	private lastDay: boolean
	private readonly days30: boolean
	private readonly us: boolean

	constructor(date: BondDate | CouponDate, basis: Basis) {
		if (date instanceof CouponDate) {
			this.origDay = date.origDay
			this.month = date.month
			this.year = date.year
			this.lastDay = date.lastDay
		} else {
			this.origDay = date.day
			this.month = date.month
			this.year = date.year
			this.lastDay = date.day >= monthDays(date.month, date.year)
		}

		this.days30 = basis === 0 || basis === 4
		this.us = basis === 0
		this.setDay()
	}

	private setDay(): void {
		const last = monthDays(this.month, this.year)

		if (this.days30) this.day = this.lastDay || Math.min(this.origDay, 30) >= last ? 30 : Math.min(this.origDay, 30)
		else this.day = this.lastDay ? last : Math.min(this.origDay, last)
	}

	private daysIn(month: number): number {
		return this.days30 ? 30 : monthDays(month, this.year)
	}

	setYear(year: number): void {
		this.year = year
		this.setDay()
	}

	addYears(count: number): void {
		this.year += count
		this.setDay()
	}

	addMonths(count: number): void {
		let month = this.month + count

		if (month > 12) {
			month--
			this.year += Math.trunc(month / 12)
			this.month = (month % 12) + 1
		} else if (month < 1) {
			this.year += Math.trunc(month / 12) - 1
			this.month = (month % 12) + 12
		} else this.month = month

		this.setDay()
	}

	get yearOf(): number {
		return this.year
	}

	get monthOf(): number {
		return this.month
	}

	toDate(): BondDate {
		const last = monthDays(this.month, this.year)

		return bondDate(this.year, this.month, this.lastDay ? last : Math.min(last, this.origDay))
	}

	before(other: CouponDate): boolean {
		if (this.year !== other.year) return this.year < other.year
		if (this.month !== other.month) return this.month < other.month
		if (this.day !== other.day) return this.day < other.day
		if (this.lastDay || other.lastDay) return !this.lastDay && other.lastDay

		return this.origDay < other.origDay
	}

	// Days from one date to another in the dates' basis (0 when the second is earlier).
	static between(from: CouponDate, to: CouponDate, basis: Basis): number {
		if (to.before(from)) return CouponDate.between(to, from, basis)

		const start = new CouponDate(from, basis)
		const end = new CouponDate(to, basis)

		if (end.days30) {
			if (end.us) {
				if ((from.month === 2 || from.day < 30) && end.origDay === 31) end.day = 31
				else if (end.month === 2 && end.lastDay) end.day = monthDays(2, end.year)
			} else {
				if (start.month === 2 && start.day === 30) start.day = monthDays(2, start.year)
				if (end.month === 2 && end.day === 30) end.day = monthDays(2, end.year)
			}
		}

		let total = 0

		if (start.year < end.year || (start.year === end.year && start.month < end.month)) {
			total = start.daysIn(start.month) - start.day + 1
			start.origDay = 1
			start.day = 1
			start.lastDay = false
			start.addMonths(1)

			if (start.year < end.year) {
				for (let month = start.month; month <= 12; month++) total += start.daysIn(month)

				start.addMonths(13 - start.month)

				for (let year = start.year; year < end.year; year++) total += start.days30 ? 360 : isLeap(year) ? 366 : 365

				start.addYears(end.year - start.year)
			}

			for (let month = start.month; month < end.month; month++) total += start.daysIn(month)

			start.addMonths(end.month - start.month)
		}

		return Math.max(0, total + end.day - start.day)
	}
}

// The last coupon date on or before settlement, on the schedule that ends at maturity.
function previousCoupon(settlement: CouponDate, maturity: CouponDate, frequency: number, basis: Basis): CouponDate {
	const date = new CouponDate(maturity, basis)

	date.setYear(settlement.yearOf)

	if (date.before(settlement)) date.addYears(1)

	while (settlement.before(date)) date.addMonths(-12 / frequency)

	return date
}

// The first coupon date after settlement.
function nextCoupon(settlement: CouponDate, maturity: CouponDate, frequency: number, basis: Basis): CouponDate {
	const date = new CouponDate(maturity, basis)

	date.setYear(settlement.yearOf)

	if (settlement.before(date)) date.addYears(-1)

	while (!settlement.before(date)) date.addMonths(12 / frequency)

	return date
}

export function couponPrevious(settlement: BondDate, maturity: BondDate, frequency: number, basis: Basis): BondDate {
	return previousCoupon(new CouponDate(settlement, basis), new CouponDate(maturity, basis), frequency, basis).toDate()
}

export function couponNext(settlement: BondDate, maturity: BondDate, frequency: number, basis: Basis): BondDate {
	return nextCoupon(new CouponDate(settlement, basis), new CouponDate(maturity, basis), frequency, basis).toDate()
}

export function couponDaysBefore(settlement: BondDate, maturity: BondDate, frequency: number, basis: Basis): number {
	const start = new CouponDate(settlement, basis)

	return CouponDate.between(previousCoupon(start, new CouponDate(maturity, basis), frequency, basis), start, basis)
}

export function couponDays(settlement: BondDate, maturity: BondDate, frequency: number, basis: Basis): number {
	if (basis === 1) {
		const previous = previousCoupon(new CouponDate(settlement, basis), new CouponDate(maturity, basis), frequency, basis)
		const next = new CouponDate(previous, basis)

		next.addMonths(12 / frequency)

		return CouponDate.between(previous, next, basis)
	}

	return (basis === 3 ? 365 : 360) / frequency
}

export function couponDaysNext(settlement: BondDate, maturity: BondDate, frequency: number, basis: Basis): number {
	if (basis === 0 || basis === 4)
		return couponDays(settlement, maturity, frequency, basis) - couponDaysBefore(settlement, maturity, frequency, basis)

	const start = new CouponDate(settlement, basis)

	return CouponDate.between(start, nextCoupon(start, new CouponDate(maturity, basis), frequency, basis), basis)
}

export function couponCount(settlement: BondDate, maturity: BondDate, frequency: number, basis: Basis): number {
	const end = new CouponDate(maturity, basis)
	const previous = previousCoupon(new CouponDate(settlement, basis), end, frequency, basis)
	const months = (end.yearOf - previous.yearOf) * 12 + end.monthOf - previous.monthOf

	return Math.trunc((months * frequency) / 12)
}

// Days between two dates and the days of the first one's year, by month for the 30/360 bases (LibreOffice's
// GetDiffDate: February keeps its own length within one year in the US basis; the European basis reads a 31st as the
// 30th).
function dayDifference(start: BondDate, end: BondDate, basis: Basis): { days: number; year: number } {
	const negative = start.days > end.days
	const [from, to] = negative ? [end, start] : [start, end]
	let days: number
	let year: number

	if (basis === 0 || basis === 4) {
		const [day1, day2] = basis === 4 ? [Math.min(from.day, 30), Math.min(to.day, 30)] : [from.day, to.day]

		days = (to.month - from.month + (to.year - from.year) * 12) * 30 + day2 - day1

		if (basis === 0 && from.month === 2 && to.month !== 2 && from.year === to.year) days -= isLeap(from.year) ? 1 : 2

		year = 360
	} else {
		days = to.days - from.days
		year = basis === 1 ? (isLeap(from.year) ? 366 : 365) : basis === 2 ? 360 : 365
	}

	return { days: negative ? -days : days, year }
}

// The years between two dates as the days of the first year count them (LibreOffice's GetYearDiff).
export function yearDifference(start: BondDate, end: BondDate, basis: Basis): number {
	const { days, year } = dayDifference(start, end, basis)

	return days / year
}

// YEARFRAC's fraction of a year between two dates.
export function yearFraction(start: BondDate, end: BondDate, basis: Basis): number {
	if (start.days === end.days) return 0

	const [from, to] = start.days > end.days ? [end, start] : [start, end]
	let day1 = from.day
	let day2 = to.day
	let days: number

	if (basis === 0) {
		if (day1 === 31) day1--

		if (day1 === 30 && day2 === 31) day2--
		else if (from.month === 2 && day1 === monthDays(2, from.year)) {
			day1 = 30

			if (to.month === 2 && day2 === monthDays(2, to.year)) day2 = 30
		}

		days = (to.year - from.year) * 360 + (to.month - from.month) * 30 + day2 - day1
	} else if (basis === 4) {
		days = (to.year - from.year) * 360 + (to.month - from.month) * 30 + Math.min(day2, 30) - Math.min(day1, 30)
	} else days = to.days - from.days

	return days / yearLength(from, to, basis)
}

function yearLength(from: BondDate, to: BondDate, basis: Basis): number {
	if (basis === 3) return 365
	if (basis !== 1) return 360

	const differentYear = from.year !== to.year

	if (differentYear && (to.year !== from.year + 1 || from.month < to.month || (from.month === to.month && from.day < to.day))) {
		let total = 0

		for (let year = from.year; year <= to.year; year++) total += isLeap(year) ? 366 : 365

		return total / (to.year - from.year + 1)
	}

	if (!differentYear) return isLeap(from.year) ? 366 : 365

	return (isLeap(from.year) && (from.month < 2 || (from.month === 2 && from.day <= 29))) ||
		(isLeap(to.year) && (to.month > 2 || (to.month === 2 && to.day === 29)))
		? 366
		: 365
}

// Days from one date to another as a basis counts the accrued days of a coupon period: 30/360 (US with NASD's
// end-of-month rules, or European), or actual days.
function accruedDays(from: BondDate, to: BondDate, basis: Basis): number {
	if (basis !== 0 && basis !== 4) return to.days - from.days

	let day1 = from.day
	let day2 = to.day

	if (basis === 0) {
		const lastFebruary1 = from.month === 2 && day1 === monthDays(2, from.year)
		const lastFebruary2 = to.month === 2 && day2 === monthDays(2, to.year)

		if (lastFebruary1 && lastFebruary2) day2 = 30
		if (day2 === 31 && day1 >= 30) day2 = 30
		if (day1 === 31 || lastFebruary1) day1 = 30
	} else {
		day1 = Math.min(day1, 30)
		day2 = Math.min(day2, 30)
	}

	return (to.year - from.year) * 360 + (to.month - from.month) * 30 + day2 - day1
}

// A date a number of months away, its day kept (or the month's last when it has fewer), or the month's last day.
function addMonths(date: BondDate, months: number, monthEnd: boolean): BondDate {
	const index = date.year * 12 + date.month - 1 + months
	const year = Math.floor(index / 12)
	const month = index - year * 12 + 1
	const last = monthDays(month, year)

	return bondDate(year, month, monthEnd ? last : Math.min(date.day, last))
}

// ACCRINT: par × rate/frequency × the sum of Aᵢ/NLᵢ over the quasi-coupon periods (those of the schedule through
// first_interest) from the start to settlement. The start is issue, or first_interest when calcFromIssue is false and
// settlement is after it.
export function accruedInterest(
	issue: BondDate,
	firstInterest: BondDate,
	settlement: BondDate,
	rate: number,
	par: number,
	frequency: number,
	basis: Basis,
	calcFromIssue: boolean
): number {
	const months = 12 / frequency
	const monthEnd = firstInterest.day === monthDays(firstInterest.month, firstInterest.year)
	const start = !calcFromIssue && settlement.days > firstInterest.days ? firstInterest : issue
	const offset = (start.year - firstInterest.year) * 12 + start.month - firstInterest.month
	let period = Math.floor(offset / months) + 1
	let from = addMonths(firstInterest, period * months, monthEnd)

	while (from.days > start.days) from = addMonths(firstInterest, --period * months, monthEnd)

	let sum = 0

	while (from.days < settlement.days) {
		const to = addMonths(firstInterest, ++period * months, monthEnd)
		const length = basis === 1 ? to.days - from.days : (basis === 3 ? 365 : 360) / frequency
		const begin = start.days > from.days ? start : from
		const end = settlement.days < to.days ? settlement : to

		sum += accruedDays(begin, end, basis) / length
		from = to
	}

	return ((par * rate) / frequency) * sum
}

// The discount factors of a yield, per coupon period: Σ step^-(k+offset) for k from 0 below count, step 1 + yld/frequency
// (log the step's natural logarithm), in closed form.
function annuity(log: number, count: number, offset: number): number {
	if (count <= 0) return 0
	if (log === 0) return count

	return (Math.exp(-offset * log) * Math.expm1(-count * log)) / Math.expm1(-log)
}

// PRICE per $100 face value as a function of the yield: one equation for one coupon left, the discounted cash flows
// for more.
function pricer(
	settlement: BondDate,
	maturity: BondDate,
	rate: number,
	redemption: number,
	frequency: number,
	basis: Basis
): (yld: number) => number {
	const e = couponDays(settlement, maturity, frequency, basis)
	const dsc = couponDaysNext(settlement, maturity, frequency, basis) / e
	const n = couponCount(settlement, maturity, frequency, basis)
	const accrued = ((100 * rate) / frequency) * (couponDaysBefore(settlement, maturity, frequency, basis) / e)
	const coupon = (100 * rate) / frequency

	if (n === 1) return yld => (redemption + coupon) / (1 + (dsc * yld) / frequency) - accrued

	return yld => {
		const log = Math.log1p(yld / frequency)

		return redemption * Math.exp(-(n - 1 + dsc) * log) + coupon * annuity(log, n, dsc) - accrued
	}
}

export function bondPrice(
	settlement: BondDate,
	maturity: BondDate,
	rate: number,
	yld: number,
	redemption: number,
	frequency: number,
	basis: Basis
): number {
	return pricer(settlement, maturity, rate, redemption, frequency, basis)(yld)
}

// YIELD: in closed form for one coupon period or less to redemption, else the yield PRICE gives the price at.
export function bondYield(
	settlement: BondDate,
	maturity: BondDate,
	rate: number,
	pr: number,
	redemption: number,
	frequency: number,
	basis: Basis
): number {
	if (couponCount(settlement, maturity, frequency, basis) <= 1) {
		const e = couponDays(settlement, maturity, frequency, basis)
		const a = couponDaysBefore(settlement, maturity, frequency, basis)
		const dsr = couponDaysNext(settlement, maturity, frequency, basis)
		const accrued = (a / e) * (rate / frequency)

		return ((redemption / 100 + rate / frequency - (pr / 100 + accrued)) / (pr / 100 + accrued)) * ((frequency * e) / dsr)
	}

	const price = pricer(settlement, maturity, rate, redemption, frequency, basis)

	return solveYield(yld => price(yld) - pr, frequency, 0.05)
}

// The yield where a price function, falling as the yield grows (above -frequency), meets the price: Newton's method
// kept inside the bracket found so far, bisecting where a step leaves it, at most 200 steps. NaN when no yield gives
// the price.
export function solveYield(excess: (yld: number) => number, frequency: number, guess: number): number {
	let low = -frequency
	let high = Number.POSITIVE_INFINITY
	let yld = guess

	for (let iteration = 0; iteration < 200; iteration++) {
		const value = excess(yld)

		if (value === 0) return yld
		if (Number.isNaN(value)) return Number.NaN
		if (value > 0) low = yld
		else high = yld

		const h = Math.max(1e-7, Math.abs(yld) * 1e-7)
		const slope = (excess(yld + h) - excess(yld - h)) / (2 * h)
		let next = Number.isFinite(value) && slope < 0 ? yld - value / slope : Number.NaN

		if (!(next > low && next < high)) next = Number.isFinite(high) ? (low + high) / 2 : Math.max(yld * 2, yld + 1)
		if (Math.abs(next - yld) <= 1e-14 * Math.max(1, Math.abs(yld))) return next
		if (!Number.isFinite(next)) return Number.NaN

		yld = next
	}

	return Number.NaN
}

// DURATION (Macaulay) of a security paying periodic interest, in years.
export function duration(settlement: BondDate, maturity: BondDate, coupon: number, yld: number, frequency: number, basis: Basis): number {
	const e = couponDays(settlement, maturity, frequency, basis)
	const dsc = couponDaysNext(settlement, maturity, frequency, basis) / e
	const n = couponCount(settlement, maturity, frequency, basis)
	const step = 1 + yld / frequency
	const cash = (100 * coupon) / frequency
	let weighted = 0
	let present = 0

	for (let k = 1; k <= n; k++) {
		const time = k - 1 + dsc
		const flow = (k === n ? cash + 100 : cash) / step ** time

		weighted += time * flow
		present += flow
	}

	return weighted / present / frequency
}

// ODDFPRICE per $100 face value as a function of the yield, the first period short (DFC < E) or long (a sum over
// its quasi-coupon periods).
export function oddFirstPricer(
	settlement: BondDate,
	maturity: BondDate,
	issue: BondDate,
	firstCoupon: BondDate,
	rate: number,
	redemption: number,
	frequency: number,
	basis: Basis
): (yld: number) => number {
	const e = couponDays(settlement, firstCoupon, frequency, basis)
	const coupon = (100 * rate) / frequency
	const dfc = Math.max(0, accruedDays(issue, firstCoupon, basis))

	if (dfc < e) {
		const n = couponCount(settlement, maturity, frequency, basis)
		const dsc = Math.max(0, accruedDays(settlement, firstCoupon, basis)) / e
		const accrued = (coupon * Math.max(0, accruedDays(issue, settlement, basis))) / e

		return yld => {
			const log = Math.log1p(yld / frequency)

			return (
				redemption * Math.exp(-(n - 1 + dsc) * log) +
				((coupon * dfc) / e) * Math.exp(-dsc * log) +
				coupon * annuity(log, n - 1, 1 + dsc) -
				accrued
			)
		}
	}

	const months = 12 / frequency
	const quasi = couponCount(issue, firstCoupon, frequency, basis)
	let late = firstCoupon
	let dcnl = 0
	let anl = 0

	for (let index = quasi; index >= 1; index--) {
		const early = addMonths(late, -months, false)
		const nl = basis === 1 ? Math.max(0, accruedDays(early, late, basis)) : e
		const dc = index > 1 ? nl : Math.max(0, accruedDays(issue, late, basis))
		const begin = issue.days > early.days ? issue : early
		const end = settlement.days < late.days ? settlement : late

		dcnl += dc / nl
		anl += Math.max(0, accruedDays(begin, end, basis)) / nl
		late = early
	}

	const dsc =
		(basis === 2 || basis === 3
			? Math.max(0, accruedDays(settlement, couponNext(settlement, firstCoupon, frequency, basis), basis))
			: e - accruedDays(couponPrevious(settlement, firstCoupon, frequency, basis), settlement, basis)) / e
	const nq = couponCount(settlement, firstCoupon, frequency, basis) - 1
	const n = couponCount(firstCoupon, maturity, frequency, basis)

	return yld => {
		const log = Math.log1p(yld / frequency)

		return (
			redemption * Math.exp(-(n + nq + dsc) * log) +
			coupon * dcnl * Math.exp(-(nq + dsc) * log) +
			coupon * annuity(log, n, 1 + nq + dsc) -
			coupon * anl
		)
	}
}

// ODDLPRICE per $100 face value, the odd last period as fractions of coupon periods.
export function oddLastPrice(
	settlement: BondDate,
	maturity: BondDate,
	lastInterest: BondDate,
	rate: number,
	yld: number,
	redemption: number,
	frequency: number,
	basis: Basis
): number {
	const dc = yearFraction(lastInterest, maturity, basis) * frequency
	const dsc = yearFraction(settlement, maturity, basis) * frequency
	const a = yearFraction(lastInterest, settlement, basis) * frequency
	const coupon = (100 * rate) / frequency

	return (redemption + dc * coupon) / ((dsc * yld) / frequency + 1) - a * coupon
}

export function oddLastYield(
	settlement: BondDate,
	maturity: BondDate,
	lastInterest: BondDate,
	rate: number,
	pr: number,
	redemption: number,
	frequency: number,
	basis: Basis
): number {
	const dc = yearFraction(lastInterest, maturity, basis) * frequency
	const dsc = yearFraction(settlement, maturity, basis) * frequency
	const a = yearFraction(lastInterest, settlement, basis) * frequency
	const coupon = (100 * rate) / frequency

	return ((redemption + dc * coupon) / (pr + a * coupon) - 1) * (frequency / dsc)
}

// To a whole number, half away from zero, the value read at 15 significant digits first (so 2.4999999999999996 is 3).
function roundHalfAway(value: number): number {
	const exact = Number(value.toPrecision(15))

	return Math.sign(exact) * Math.round(Math.abs(exact))
}

// AMORDEGRC: degressive French depreciation, each period's write-down rounded to a whole number; the rate grows by the
// coefficient of the asset's life (1/rate): 1.5 for 3 to 4 years, 2 for 5 to 6, 2.5 above 6.
export function amorDegrc(
	cost: number,
	purchased: BondDate,
	firstPeriod: BondDate,
	salvage: number,
	period: number,
	rate: number,
	basis: Basis
): number {
	const life = 1 / rate
	const coefficient = life <= 4 ? 1.5 : life <= 6 ? 2 : 2.5
	const degressive = rate * coefficient
	let write = roundHalfAway(yearFraction(purchased, firstPeriod, basis) * degressive * cost)
	let remaining = cost - write
	let rest = remaining - salvage

	for (let n = 0; n < period; n++) {
		write = roundHalfAway(degressive * remaining)
		rest -= write

		if (rest < 0) return period - n <= 1 ? roundHalfAway(remaining * 0.5) : 0
		// Nothing written down, nothing changes from here on: every later period writes down 0 too.
		if (write === 0) return 0

		remaining -= write
	}

	return write
}

// AMORLINC: linear French depreciation, the first period prorated.
export function amorLinc(
	cost: number,
	purchased: BondDate,
	firstPeriod: BondDate,
	salvage: number,
	period: number,
	rate: number,
	basis: Basis
): number {
	const full = cost * rate
	const first = yearFraction(purchased, firstPeriod, basis) * rate * cost
	const fullPeriods = Math.trunc((cost - salvage - first) / full)
	const result =
		period === 0 ? first : period <= fullPeriods ? full : period === fullPeriods + 1 ? cost - salvage - full * fullPeriods - first : 0

	return result > 0 ? result : 0
}

// DDB's depreciation of one whole period.
function decliningPeriod(cost: number, salvage: number, life: number, period: number, factor: number): number {
	let rate = factor / life
	let before: number

	if (rate >= 1) {
		rate = 1
		before = period === 1 ? cost : 0
	} else before = cost * (1 - rate) ** (period - 1)

	const after = cost * (1 - rate) ** period
	const write = after < salvage ? before - salvage : before - after

	return write < 0 ? 0 : write
}

// The declining balance over the first periods of a life (the last one possibly partial), switching to straight
// line once that is larger.
function decliningTotal(cost: number, salvage: number, life: number, remainingLife: number, end: number, factor: number): number {
	const last = Math.ceil(end)
	let total = 0
	let left = cost - salvage

	for (let period = 1; period <= last; period++) {
		const declining = decliningPeriod(cost, salvage, life, period, factor)
		const straight = left / (remainingLife - (period - 1))

		// Straight line from here on: every remaining period writes the same, the last one prorated.
		if (straight > declining) return total + straight * (end + 1 - period)

		left -= declining
		total += period === last ? declining * (end + 1 - last) : declining
	}

	return total
}

// The most whole periods VDB schedules: its loops run once per period, so a far larger life would hang the
// calculation.
export const VDB_MAX_PERIODS = 1_000_000

// VDB: the declining-balance depreciation from start to end (fractions of periods prorated), switching to straight
// line unless noSwitch.
export function variableDeclining(
	cost: number,
	salvage: number,
	life: number,
	start: number,
	end: number,
	factor: number,
	noSwitch: boolean
): number {
	const startWhole = Math.floor(start)
	const endWhole = Math.ceil(end)

	if (noSwitch) {
		let total = 0

		for (let period = startWhole + 1; period <= endWhole; period++) {
			let write = decliningPeriod(cost, salvage, life, period, factor)

			// Book value at salvage: no later period writes anything.
			if (write === 0) break

			if (period === startWhole + 1) write *= Math.min(end, startWhole + 1) - start
			else if (period === endWhole) write *= end + 1 - endWhole

			total += write
		}

		return total
	}

	let part = 0

	if (start !== startWhole) {
		const value = cost - decliningTotal(cost, salvage, life, life, startWhole, factor)

		part += (start - startWhole) * decliningTotal(value, salvage, life, life - startWhole, 1, factor)
	}

	if (end !== endWhole) {
		const before = endWhole - 1
		const value = cost - decliningTotal(cost, salvage, life, life, before, factor)

		part += (endWhole - end) * decliningTotal(value, salvage, life, life - before, 1, factor)
	}

	const value = cost - decliningTotal(cost, salvage, life, life, startWhole, factor)

	return decliningTotal(value, salvage, life, life - startWhole, endWhole - startWhole, factor) - part
}
