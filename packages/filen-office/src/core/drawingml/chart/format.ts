// Number formats for chart labels: the sheet's number-format engine (core/sheet/numfmt), so a chart shows its
// numbers as the cells it charts show them. Only General keeps the chart's own rule: a chart's General is not
// bounded by a cell's width.

import { MAX_NUMFMT_LENGTH } from "../../sheet/numfmt/edit"
import { formatNumberInto, numFmt, NumFmtOutput, type NumFmtOptions } from "../../sheet/numfmt/format"
import { isPlainGeneral } from "../../sheet/numfmt/general"
import { NUMFMT_EN_US } from "../../sheet/numfmt/locale"

// Locale threading from the hosts is not wired yet; charts show en-US numbers and dates.
const OPTIONS_1900: NumFmtOptions = { date1904: false, locale: NUMFMT_EN_US }
const OPTIONS_1904: NumFmtOptions = { date1904: true, locale: NUMFMT_EN_US }
// Reused between calls: formatting a point allocates only its text.
const output = new NumFmtOutput()

function general(value: number): string {
	if (value === 0) return "0"

	const magnitude = Math.abs(value)

	if (magnitude >= 1e11 || magnitude < 1e-9) {
		return value
			.toExponential(5)
			.replace(/\.?0+e/, "E")
			.replace(/E([+-])(\d)$/, "E$10$2")
	}

	// Ten significant digits, trailing zeros dropped, as Excel's General shows them on a chart.
	const text = Number(value.toPrecision(10)).toString()

	return text.includes("e") ? value.toFixed(Math.max(0, 10 - Math.ceil(Math.log10(magnitude)))).replace(/\.?0+$/, "") : text
}

// Formats `value` with an Excel number format code. `date1904` selects the workbook's date system. An empty code,
// and one longer than Excel allows, read as General; a code is compiled once (numFmt caches it) and reused for
// every value.
export function formatNumber(value: number, code: string, date1904: boolean): string {
	if (!Number.isFinite(value)) return ""
	if (code === "" || code.length > MAX_NUMFMT_LENGTH) return general(value)

	const format = numFmt(code)

	if (isPlainGeneral(format)) return general(value)

	return formatNumberInto(format, value, output, date1904 ? OPTIONS_1904 : OPTIONS_1900).text
}
