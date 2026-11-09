import { sheetFunctions } from "./catalogue"

// A call of a volatile function the engine calculates (INDIRECT, OFFSET, NOW, TODAY, RAND...), not part of a longer
// name: built on first use.
let calls: RegExp | null = null

function volatileCalls(): RegExp {
	if (calls === null) {
		const names = sheetFunctions()
			.filter(entry => entry.volatility === "always" && (entry.support === "hyperformula" || entry.support === "plugin"))
			.map(entry => entry.name.replace(/[.]/g, "\\."))

		calls = new RegExp(`(?:^|[^A-Za-z0-9_.])(?:_xlfn\\.(?:_xlws\\.)?)?(?:${names.join("|")})\\(`, "i")
	}

	return calls
}

// Whether a formula (Excel's syntax, with or without "=") calls a volatile function the engine calculates: Excel
// calculates such a formula at every recalculation, opening the workbook included, whatever the file cached
// (learn.microsoft.com "Excel Recalculation"), and LibreOffice does on load.
export function volatileFormula(text: string): boolean {
	return volatileCalls().test(text.includes('"') ? text.replace(/"(?:[^"]|"")*"/g, '""') : text)
}
