// The CAD viewer's drawing: a plan in Windows-1252 (an R2000 file naming ANSI_1252), with a line pair on WALLS and a
// circle and a text on DIMS.

const RICH_CAD_TEXT = "Café plan"

export const RICH_CAD_LAYERS = ["WALLS", "DIMS"] as const

function groups(...pairs: (string | number)[]): string {
	return pairs.map(String).join("\r\n") + "\r\n"
}

function section(name: string, ...pairs: (string | number)[]): (string | number)[] {
	return [0, "SECTION", 2, name, ...pairs, 0, "ENDSEC"]
}

function layer(name: string, color: number): (string | number)[] {
	return [0, "LAYER", 2, name, 70, 0, 62, color, 6, "CONTINUOUS"]
}

export function planDxf(): Buffer {
	const text = groups(
		...section("HEADER", 9, "$ACADVER", 1, "AC1015", 9, "$DWGCODEPAGE", 3, "ANSI_1252"),
		...section("TABLES", 0, "TABLE", 2, "LAYER", 70, 2, ...layer("WALLS", 1), ...layer("DIMS", 5), 0, "ENDTAB"),
		...section(
			"ENTITIES",
			...[0, "LINE", 8, "WALLS", 10, 0, 20, 0, 30, 0, 11, 100, 21, 0, 31, 0],
			...[0, "LINE", 8, "WALLS", 10, 100, 20, 0, 30, 0, 11, 100, 21, 60, 31, 0],
			...[0, "CIRCLE", 8, "DIMS", 10, 50, 20, 30, 30, 0, 40, 20],
			...[0, "TEXT", 8, "DIMS", 10, 10, 20, 70, 30, 0, 40, 8, 1, RICH_CAD_TEXT]
		),
		0,
		"EOF"
	)

	return Buffer.from(text, "latin1")
}
