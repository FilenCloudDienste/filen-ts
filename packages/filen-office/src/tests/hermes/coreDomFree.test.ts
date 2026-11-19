import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

// The core runs in a worker, a WebView and Hermes: it type-checks against ESNext alone (tsconfig.json is the
// gate), and it never reaches a window or document through globalThis, which the types cannot see.

const PACKAGE = new URL("../../../", import.meta.url).pathname
const CORE = join(PACKAGE, "src/core")
const NAMES = "window|document|self|navigator|location|localStorage"
const GLOBAL_NAME = new RegExp(`^(?:${NAMES})$`)
// globalThis.name, globalThis?.name, globalThis["name"] and Reflect.get(globalThis, "name"), cast or not.
const DIRECT = new RegExp(
	`\\bglobalThis\\s*(?:\\??\\.\\s*|(?:\\?\\.\\s*)?\\[\\s*["'\`])(${NAMES})\\b|\\bReflect\\.get\\(\\s*\\(?\\s*globalThis\\b[^,]*,\\s*["'\`](${NAMES})["'\`]`,
	"g"
)
// What follows a cast's closing parenthesis: a member read of one of the names.
const MEMBER = new RegExp(`^\\s*(?:\\??\\.\\s*|(?:\\?\\.\\s*)?\\[\\s*["'\`])(${NAMES})\\b`)
const CAST = /\(\s*globalThis\s+as\b/g
const DESTRUCTURED = /=\s*\(?\s*globalThis\b/g
// Allowed reads: [file relative to core, global].
const ALLOWED: readonly (readonly [string, string])[] = [["docx/forms/dates.ts", "navigator"]]

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
		.map(entry => join(entry.parentPath, entry.name))
}

// The index just past the parenthesis matching the one at `open`, or -1 when it is not closed.
function closing(source: string, open: number): number {
	let depth = 0

	for (let k = open; k < source.length; k++) {
		const char = source.charCodeAt(k)

		if (char === 0x28) depth++
		else if (char === 0x29 && --depth === 0) return k + 1
	}

	return -1
}

// The keys of a destructuring pattern ending with the brace before `end` (top level only).
function patternKeys(source: string, end: number): string[] {
	let close = end - 1

	while (close >= 0 && /\s/.test(source.charAt(close))) close--

	if (source.charAt(close) !== "}") return []

	let depth = 0
	let open = close

	for (; open >= 0; open--) {
		const char = source.charAt(open)

		if (char === "}") depth++
		else if (char === "{" && --depth === 0) break
	}

	if (open < 0) return []

	const keys: string[] = []
	let level = 0
	let part = ""

	for (const char of source.slice(open + 1, close) + ",") {
		if (char === "{" || char === "[") level++
		else if (char === "}" || char === "]") level--

		if (char === "," && level === 0) {
			keys.push(
				part
					.split(/[:=]/)[0]
					?.replace(/^\s*\.\.\./, "")
					.trim() ?? ""
			)
			part = ""
		} else {
			part += char
		}
	}

	return keys
}

// The globals in NAMES that `source` reads off globalThis.
function domReads(source: string): string[] {
	const found = new Set<string>()

	for (const match of source.matchAll(DIRECT)) found.add(match[1] ?? match[2] ?? "")

	for (const match of source.matchAll(CAST)) {
		const end = closing(source, match.index)
		const name = end === -1 ? undefined : MEMBER.exec(source.slice(end, end + 200))?.[1]

		if (name !== undefined) found.add(name)
	}

	for (const match of source.matchAll(DESTRUCTURED)) {
		for (const key of patternKeys(source, match.index)) {
			if (GLOBAL_NAME.test(key)) found.add(key)
		}
	}

	return [...found].sort()
}

describe("core stays platform-free", () => {
	it("type-checks against ESNext without DOM or Node typings", () => {
		const config = JSON.parse(readFileSync(join(PACKAGE, "tsconfig.json"), "utf8")) as {
			readonly exclude: readonly string[]
			readonly compilerOptions: { readonly lib: readonly string[]; readonly types: readonly string[] }
		}

		expect(config.compilerOptions.lib).toEqual(["ESNext"])
		expect(config.compilerOptions.types).toEqual([])
		expect(config.exclude).not.toContain("src/core")
	})

	it("finds a read of a DOM global in every spelling", () => {
		const reads: readonly (readonly [string, string])[] = [
			["globalThis.document.body", "document"],
			["globalThis ?. window", "window"],
			['globalThis["localStorage"]', "localStorage"],
			["Reflect.get(globalThis, 'location')", "location"],
			["(globalThis as { document?: unknown }).document", "document"],
			["(globalThis as { navigator?: { language?: unknown } }).navigator?.language", "navigator"],
			["(globalThis as { self?: unknown })?.self", "self"],
			['(globalThis as { window: unknown })["window"]', "window"],
			["(\n\tglobalThis as {\n\t\tdocument?: { create(tag: string): unknown }\n\t}\n)\n\t.document", "document"],
			["const { document } = globalThis as { document: unknown }", "document"],
			["const { navigator: nav, ...rest } = globalThis", "navigator"],
			["const { location: { href } } = (globalThis as never)", "location"]
		]

		for (const [source, name] of reads) expect(domReads(source), source).toEqual([name])

		for (const source of [
			"(globalThis as { TextDecoder?: new (label: string) => unknown }).TextDecoder",
			'Reflect.get(globalThis, "setTimeout")',
			"const { TextDecoder } = globalThis",
			"const self = this; self.document",
			"// a location in the document"
		]) {
			expect(domReads(source), source).toEqual([])
		}
	})

	it("never reaches a window or document through globalThis beyond the allowed reads", () => {
		const files = sources(CORE)
		const reads = files.flatMap(file =>
			domReads(readFileSync(file, "utf8")).map(name => [relative(CORE, file).split("\\").join("/"), name] as const)
		)

		expect(files.length).toBeGreaterThan(100)
		expect(reads).toEqual(ALLOWED)
	})
})
