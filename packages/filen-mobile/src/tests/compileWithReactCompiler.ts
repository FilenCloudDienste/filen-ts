import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

// Compiles a source file the way Metro does, collecting the React Compiler's events. The compiler silently skips what
// it can't compile (babel-preset-expo runs it with panicThreshold "none"), so a lost memoization shows only here.

export type CompilerEvent = {
	kind: string
	fnName: string | null
	memoSlots?: number
	detail?: unknown
}

type BabelCore = {
	transformFileSync: (filename: string, options: Record<string, unknown>) => { code?: string | null } | null
}

const requireHere = createRequire(import.meta.url)
// babel-preset-expo only peers @babel/core; Metro's comes through expo's own metro-config.
const requireMetroConfig = createRequire(createRequire(requireHere.resolve("expo/package.json")).resolve("@expo/metro-config/package.json"))
const babel = requireMetroConfig("@babel/core") as BabelCore
const babelPresetExpo = requireHere.resolve("babel-preset-expo")

// The @babel/runtime helpers the compiled output requires, as the preset that emits them resolves them.
export const requireFromBabelPreset = createRequire(babelPresetExpo)

// `file` is relative to src.
export function compileWithReactCompiler(file: string): { events: CompilerEvent[]; code: string } {
	const events: CompilerEvent[] = []

	const result = babel.transformFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), {
		babelrc: false,
		configFile: false,
		presets: [
			[
				babelPresetExpo,
				{
					"react-compiler": {
						logger: {
							logEvent: (_filename: string | null, event: CompilerEvent) => {
								events.push(event)
							}
						}
					}
				}
			]
		],
		caller: {
			name: "metro",
			bundler: "metro",
			platform: "ios",
			isDev: false,
			isServer: false,
			supportsReactCompiler: true
		}
	})

	if (!result?.code) {
		throw new Error(`${file} produced no output`)
	}

	return {
		events,
		code: result.code
	}
}

export function compilerFailures(events: CompilerEvent[]): CompilerEvent[] {
	return events.filter(event => event.kind !== "CompileSuccess")
}

// An arrow component is logged without a name: pass null.
export function memoSlotsOf(events: CompilerEvent[], fnName: string | null): number {
	return events.find(event => event.kind === "CompileSuccess" && event.fnName === fnName)?.memoSlots ?? 0
}

// The values a compiled memo scope is keyed on, or null when the value is rebuilt every render. `binding` is the
// compiled output's `var name=` or `prop:` site; the scope's temporary is what it reads from.
export function memoDependencies(code: string, binding: RegExp): string[] | null {
	const temporary = binding.exec(code)?.[1]

	if (!temporary || !/^t\d+$/.test(temporary) || !code.includes(`]=${temporary};`)) {
		return null
	}

	const guard = new RegExp(`if\\(([^{}]*)\\)\\{${temporary}=`).exec(code)?.[1]

	return guard ? Array.from(guard.matchAll(/\$\[\d+\]!==([\w.]+)/g), match => match[1] ?? "") : null
}
