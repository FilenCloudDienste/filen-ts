import { describe, expect, it } from "vitest"
import { transformFileSync } from "@babel/core"

// The React Compiler silently skips a component it cannot compile (a try without a catch, a write to a value a hook
// was handed, a function used before its declaration), and lint does not notice. The preview overlay and its body are
// compiled the way vite.config.ts compiles them and must come out compiled.

interface CompilerEvent {
	kind: string
	fnName: string | null
	memoSlots?: number
}

function compile(file: string): CompilerEvent[] {
	const events: CompilerEvent[] = []

	transformFileSync(file, {
		babelrc: false,
		configFile: false,
		presets: ["@babel/preset-typescript"],
		plugins: [
			"@babel/plugin-syntax-jsx",
			[
				"babel-plugin-react-compiler",
				{
					logger: {
						logEvent: (_filename: string | null, event: CompilerEvent) => {
							events.push(event)
						}
					}
				}
			]
		]
	})

	return events
}

describe("preview overlay compilation", () => {
	it.each([
		["src/features/preview/components/previewOverlay.tsx", "PreviewOverlay"],
		["src/features/preview/components/previewBody.tsx", "PreviewBody"],
		["src/features/preview/components/readOnlyPreviewBody.tsx", "ReadOnlyViewer"]
	])("compiles %s whole", (file, fnName) => {
		const events = compile(file)

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(true)
	})
})
