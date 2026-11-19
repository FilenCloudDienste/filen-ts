// Date serials (ECMA-376 Part 1 §18.17.4): days since the epoch, the time of day as the fraction.
// - 1900 system: 1 is 1900-01-01, 0 is shown as 1900-01-00, and 60 is 1900-02-29, a day the Gregorian calendar
//   does not have (§18.17.4.1: kept for compatibility, so serials from 61 on are one day off a plain count).
// - 1904 system: 0 is 1904-01-01.
// - 1900 date base of a Strict workbook (MS-OI29500 2.1.585 j: "If workbook@conformance equals strict, the 1900 date
//   system is used"; §18.17.4.1): a plain count from 1899-12-30, so 1 is 1899-12-31 and 61 is 1900-03-01 as above.

// A workbook's date base: true the 1904 system, false the 1900 system, ISO_1900 a Strict workbook's 1900 date base.
export const ISO_1900 = "iso1900"
export type DateBase = boolean | typeof ISO_1900

export interface DateParts {
	year: number
	// 1-12.
	month: number
	// 0 only for the 1900 system's serial 0.
	day: number
	// 0 Sunday to 6 Saturday.
	weekday: number
}

// The largest serial a format shows as a date: 9999-12-31 (§18.17.4.1, §18.17.4.2).
export const MAX_SERIAL_1900 = 2958465
export const MAX_SERIAL_1904 = MAX_SERIAL_1900 - 1462

// Days from 1970-01-01 to a proleptic Gregorian date and back (civil calendar arithmetic, integers only).
function civil(days: number, out: DateParts): void {
	const z = days + 719468
	const era = Math.floor(z / 146097)
	const doe = z - era * 146097
	const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
	const mp = Math.floor((5 * doy + 2) / 153)
	const month = mp < 10 ? mp + 3 : mp - 9

	out.year = yoe + era * 400 + (month <= 2 ? 1 : 0)
	out.month = month
	out.day = doy - Math.floor((153 * mp + 2) / 5) + 1
}

// 1899-12-30 and 1904-01-01 as days from 1970-01-01.
const EPOCH_1900 = -25569
const EPOCH_1904 = -24107

// Days from 1970-01-01 to a proleptic Gregorian date (civil calendar arithmetic, integers only).
function civilDays(year: number, month: number, day: number): number {
	const y = month <= 2 ? year - 1 : year
	const era = Math.floor(y / 400)
	const yoe = y - era * 400
	const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1

	return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468
}

// A date's serial in a date system, serialDate's inverse: the 1900 system counts the 1900-02-29 it does not have, so
// dates before March 1900 are a day lower than a plain count.
export function dateSerial(year: number, month: number, day: number, date1904: DateBase): number {
	const days = civilDays(year, month, day)

	if (date1904 === true) return days - EPOCH_1904

	const serial = days - EPOCH_1900

	return serial < 61 && date1904 !== ISO_1900 ? serial - 1 : serial
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/

// A t="d" cell's ISO 8601 text (§18.17.4: a date, its time of day, seconds with their fraction) as a serial, NaN when
// it does not read.
export function isoSerial(text: string, date1904: DateBase): number {
	const match = ISO_DATE.exec(text)

	if (match === null) return Number.NaN

	const [, year = "", month = "", day = "", hours = "0", minutes = "0", seconds = "0"] = match

	return (
		dateSerial(Number(year), Number(month), Number(day), date1904) +
		(Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) / 86_400
	)
}

// The date of a whole serial day (>= 0, at most the system's maximum).
export function serialDate(day: number, date1904: DateBase, out: DateParts): DateParts {
	if (date1904 === ISO_1900) {
		civil(day + EPOCH_1900, out)
		out.weekday = (day + 6) % 7

		return out
	}

	if (date1904) {
		civil(day + EPOCH_1904, out)
		out.weekday = (day + 5) % 7

		return out
	}

	if (day === 0) {
		out.year = 1900
		out.month = 1
		out.day = 0
	} else if (day === 60) {
		out.year = 1900
		out.month = 2
		out.day = 29
	} else civil(day + EPOCH_1900 + (day < 60 ? 1 : 0), out)

	out.weekday = (day + 6) % 7

	return out
}
