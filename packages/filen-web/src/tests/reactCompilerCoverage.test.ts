import { describe, expect, it } from "vitest"
import { transformFileSync } from "@babel/core"

// The React Compiler silently skips a hook or component it can't compile, and neither lint nor
// check:compiler (a fixture probe) notices. These files are compiled the way vite.config.ts compiles
// them and must come out compiled.

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

describe("React Compiler coverage", () => {
	it("compiles useDriveClipboard, which every drive listing runs", () => {
		const events = compile("src/features/drive/hooks/useDriveClipboard.ts")

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(
			events.some(event => event.kind === "CompileSuccess" && event.fnName === "useDriveClipboard" && (event.memoSlots ?? 0) > 0)
		).toBe(true)
	})
})
