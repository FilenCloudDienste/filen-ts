import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { codeSyntaxVariables } from "@filen/office/dom/code"

const CSS = readFileSync("src/features/preview/lib/codeMirrorTheme.css", "utf8")

function block(selector: string): Record<string, string> {
	const start = CSS.indexOf(`${selector} {\n`)
	const body = CSS.slice(start + selector.length + 3, CSS.indexOf("}", start))
	const variables: Record<string, string> = {}

	for (const line of body.split("\n")) {
		const match = /^\s*(--[\w-]+):\s*(.+);$/.exec(line)

		if (match?.[1] !== undefined && match[2] !== undefined) {
			variables[match[1]] = match[2]
		}
	}

	return variables
}

// The dark syntax colours are the package's own One Dark values, every light fallback overridden.
describe("code editor theme", () => {
	it("sets exactly the package's dark syntax variables in dark mode, in the editor and in static code", () => {
		expect(block(".dark .cm-editor,\n.dark .fo-code-static")).toEqual(codeSyntaxVariables("dark"))
	})

	it("maps the editor chrome onto the app's tokens", () => {
		const chrome = block(".cm-editor")

		expect(chrome["--fo-code-fg"]).toBe("var(--foreground)")
		expect(chrome["--fo-code-panel-bg"]).toBe("var(--background)")
		expect(Object.keys(chrome).every(name => name.startsWith("--fo-code-"))).toBe(true)
	})
})
