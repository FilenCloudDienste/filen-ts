import { describe, expect, it } from "vitest"
import { transformFileSync } from "@babel/core"

// The workbook's structure lock is read through a per-grid store's hook. The React Compiler treats a call as a hook only
// by its name, so a read it took for a plain call would sit inside a memo block and run on the first render only (React
// then throws on the next render, a hook missing). Both readers are compiled the way vite.config.ts compiles them, and
// the read must be a statement of the function body itself.

function compiled(file: string): string {
	const result = transformFileSync(file, {
		babelrc: false,
		configFile: false,
		presets: ["@babel/preset-typescript"],
		plugins: ["@babel/plugin-syntax-jsx", "babel-plugin-react-compiler"]
	})

	return result?.code ?? ""
}

// The compiled body's lines that make `call`: one indent level is the body's own, deeper ones sit inside a block.
function callLines(code: string, fnName: string, call: string): string[] {
	const start = code.indexOf(`function ${fnName}(`)

	if (start === -1) {
		throw new Error(`${fnName} not found in compiled output`)
	}

	const body = code.slice(start, code.indexOf("\n}\n", start))

	return body.split("\n").filter(line => line.includes(call))
}

describe("structure lock read under the React Compiler", () => {
	it.each([
		["src/features/spreadsheet/tabs/sheetTabs.tsx", "useStructureLocked"],
		["src/features/spreadsheet/toolbar/sheetToolbar.tsx", "SheetToolbar"]
	])("%s reads the lock on every render of %s", (file, fnName) => {
		const lines = callLines(compiled(file), fnName, "workbookStructureLocks.")
		const reads = lines.filter(line => !line.includes("workbookStructureLocks.set("))

		expect(reads.length).toBeGreaterThan(0)
		expect(reads.filter(line => !/^ {2}\S/.test(line))).toEqual([])
	})
})
