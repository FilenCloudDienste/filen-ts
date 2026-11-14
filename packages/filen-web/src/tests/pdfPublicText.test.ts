import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// The PDF viewer's and editor's code and comments name no other product they resemble.

const ROOT = process.cwd()
const PLACES = [
	"src/features/pdf",
	"src/tests/pdfViewerPages.test.tsx",
	"../filen-office/src/dom/pdfedit",
	"../filen-office/src/core/pdfedit",
	"../filen-office/src/core/pdfsign"
]
const NAMES = /\b(?:Acrobat|Adobe Reader|Preview\.app|Edge's|VS Code)\b/

function files(path: string, into: string[] = []): string[] {
	if (!statSync(path).isDirectory()) {
		if (/\.tsx?$/.test(path)) into.push(path)

		return into
	}

	for (const entry of readdirSync(path)) files(join(path, entry), into)

	return into
}

describe("PDF public text", () => {
	it("names no imitated product", () => {
		const named = PLACES.flatMap(place => files(join(ROOT, place))).filter(path => NAMES.test(readFileSync(path, "utf8")))

		expect(named).toEqual([])
	})
})
