import { describe, it, expect } from "vitest"
import { compileWithReactCompiler, compilerFailures, memoDependencies } from "@/tests/compileWithReactCompiler"

// The composer re-renders on every keystroke. Skipped by the compiler (it can't compile try/finally), or with the
// attach menu's handlers keyed on the draft, each keystroke rebuilds and re-sends the native attach menu config.
describe("React Compiler coverage of the chat composer", () => {
	const { events, code } = compileWithReactCompiler("features/chats/components/chat/input/index.tsx")
	// Memo temporaries restart per component: read Input's scopes only.
	const input = code.slice(code.indexOf("var Input="))

	it("compiles every component", () => {
		expect(compilerFailures(events)).toEqual([])
		expect(events.filter(event => event.kind === "CompileSuccess")).toHaveLength(2)
	})

	it("keeps the attach menu's handlers off the draft", () => {
		expect(code.indexOf("var Input=")).toBeGreaterThan(0)

		for (const handler of ["insertLinksIntoInput", "uploadAssetsAndInsert", "pickAndInsert"]) {
			const dependencies = memoDependencies(input, new RegExp(`var ${handler}=(t\\d+);`))

			expect(dependencies, handler).not.toBeNull()
			expect(dependencies, handler).not.toContain("chatInputValue")
		}

		expect(memoDependencies(input, /var insertLinksIntoInput=(t\d+);/)).toEqual(["setChatInputValue"])
	})
})
