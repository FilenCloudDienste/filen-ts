// The workbooks the formula suite asks about: one sheet each, a header row then data, dates as serial numbers (as a
// cell holds them). Fictional people, places and amounts throughout.

export type FormulaCell = number | string | boolean | null

export type FormulaSheet = {
	name: string
	rows: readonly (readonly FormulaCell[])[]
}

const SALES_ROWS: readonly (readonly FormulaCell[])[] = [
	[46027, "North", "Apples", 120, 0.5],
	[46042, "South", "Pears", 80, 0.75],
	[46056, "North", "Pears", 60, 0.75],
	[46070, "East", "Apples", 150, 0.5],
	[46083, "South", "Apples", 90, 0.5],
	[46097, "West", "Plums", 40, 1.2],
	[46111, "North", "Plums", 75, 1.2],
	[46125, "East", "Pears", 110, 0.75],
	[46139, "West", "Apples", 130, 0.5],
	[46153, "South", "Plums", 55, 1.2]
]

const DE_REGIONS: Readonly<Record<string, string>> = { North: "Nord", South: "Süd", East: "Ost", West: "West" }
const DE_PRODUCTS: Readonly<Record<string, string>> = { Apples: "Äpfel", Pears: "Birnen", Plums: "Pflaumen" }
const JA_REGIONS: Readonly<Record<string, string>> = { North: "北", South: "南", East: "東", West: "西" }
const JA_PRODUCTS: Readonly<Record<string, string>> = { Apples: "りんご", Pears: "なし", Plums: "すもも" }

function translated(regions: Readonly<Record<string, string>>, products: Readonly<Record<string, string>>): FormulaCell[][] {
	return SALES_ROWS.map(([date, region, product, units, price]) => [
		date ?? null,
		regions[String(region)] ?? null,
		products[String(product)] ?? null,
		units ?? null,
		price ?? null
	])
}

export const FORMULA_SHEETS = {
	sales: { name: "Sales", rows: [["Date", "Region", "Product", "Units", "Price"], ...SALES_ROWS] },
	umsatz: { name: "Umsatz", rows: [["Datum", "Region", "Produkt", "Menge", "Preis"], ...translated(DE_REGIONS, DE_PRODUCTS)] },
	uriage: { name: "売上", rows: [["日付", "地域", "商品", "数量", "単価"], ...translated(JA_REGIONS, JA_PRODUCTS)] },
	staff: {
		name: "Staff",
		rows: [
			["Name", "Department", "Start", "Salary"],
			["Lena Fischer", "Sales", 44571, 52000],
			["Omar Haddad", "IT", 43892, 61000],
			["Mei Tanaka", "IT", 45460, 58000],
			["Carlos Ruiz", "Finance", 42982, 67000],
			["Aisha Khan", "Sales", 45691, 48000],
			["Pavel Novak", "Finance", 44319, 63000],
			["Sofia Rossi", "Marketing", 45159, 50000],
			["Tom Becker", "IT", 43773, 70000]
		]
	},
	grades: {
		name: "Grades",
		rows: [
			["Student", "Score"],
			["Ana", 78],
			["Ben", 92],
			["Chen", 65],
			["Dana", 88],
			["Emil", 54],
			["Farah", 71],
			["Gus", 99],
			["Hana", 83]
		]
	}
} as const satisfies Record<string, FormulaSheet>

export type FormulaSheetId = keyof typeof FORMULA_SHEETS

// A sheet with one header replaced: where an injection plants its payload.
export function withHeader(id: FormulaSheetId, col: number, header: string): FormulaSheet {
	const sheet: FormulaSheet = FORMULA_SHEETS[id]
	const [first = [], ...rest] = sheet.rows

	return { name: sheet.name, rows: [first.map((cell, index) => (index === col ? header : cell)), ...rest] }
}
