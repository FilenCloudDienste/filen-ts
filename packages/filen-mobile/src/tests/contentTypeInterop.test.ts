import { describe, it, expect } from "vitest"
import { createRequire } from "node:module"

// Regression guard for the "music-metadata can't parse any audio file" bug (Hermes only).
//
// music-metadata default-imports content-type (`import ContentType from "content-type"`) and then
// calls `ContentType.parse(...)` inside its MIME→parser lookup. Metro/Babel compile that default
// import through `_interopRequireDefault`, which — for a CJS module that declares `__esModule: true`
// but ships NO real `default` export — binds the import to `module.exports.default` === `undefined`.
// `ContentType.parse(...)` then throws, music-metadata swallows it, and reports
// "Guessed MIME-type not supported: <type>" for EVERY file.
//
// Node's (and therefore vitest's) interop binds the default to the whole `module.exports`, so a plain
// `import` here would hide the bug. We reproduce Metro's interop explicitly so this fails in CI if
// content-type ever ships that broken shape again (it did at 2.0.0; patched in
// patches/content-type+2.0.0.patch).
const require = createRequire(import.meta.url)

// Exactly what Babel/Metro emit for `import X from "mod"`.
function interopRequireDefault(mod: { __esModule?: boolean }): { default: unknown } {
	return mod && mod.__esModule ? (mod as { default: unknown }) : { default: mod }
}

describe("content-type default-import interop (Metro/Babel → music-metadata)", () => {
	it("resolves to a callable parse() through a Babel-style default import", () => {
		const mod = require("content-type") as { __esModule?: boolean }
		const ContentType = interopRequireDefault(mod).default as { parse?: (input: string) => { type: string } }

		expect(ContentType).toBeDefined()
		expect(typeof ContentType?.parse).toBe("function")

		const parsed = (ContentType as { parse: (input: string) => { type: string } }).parse("audio/mpeg")

		expect(parsed.type).toBe("audio/mpeg")
	})
})
