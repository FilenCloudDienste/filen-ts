import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Drift guard, not a mirror of the title map: a new screen shipping with no <title> is the regression
// that matters, and which catalog key each route uses is the route file's own business.
const ROUTES_DIR = "src/routes"

// Route files that deliberately declare no head, each for a checked reason.
const NO_HEAD = new Set([
	// Redirect-only, never renders.
	"index.tsx",
	"_app/settings/index.tsx",
	// Pathless auth layout; every child declares a title.
	"_app/route.tsx",
	// Inherit their notes/chats layout title — the deepest declared title wins, and per-item titles are
	// deliberately out of scope.
	"_app/notes.index.tsx",
	"_app/notes.$uuid.tsx",
	"_app/chats.index.tsx",
	"_app/chats.$uuid.tsx"
])

function routeFiles(dir: string, prefix = ""): string[] {
	return readdirSync(join(ROUTES_DIR, dir), { withFileTypes: true }).flatMap(entry => {
		const relative = prefix + entry.name

		if (entry.isDirectory()) {
			return routeFiles(join(dir, entry.name), `${relative}/`)
		}

		return entry.name.endsWith(".tsx") ? [relative] : []
	})
}

const files = routeFiles(".")
const sources = new Map(files.map(file => [file, readFileSync(join(ROUTES_DIR, file), "utf8")]))

function sourceOf(file: string): string {
	const source = sources.get(file)

	if (source === undefined) {
		throw new Error(`route file ${file} was not read`)
	}

	return source
}

describe("route head coverage", () => {
	it("finds the route tree", () => {
		expect(files).toContain("__root.tsx")
		expect(files.length).toBeGreaterThan(20)
	})

	it("declares a head on every route that renders a component", () => {
		const missing = files.filter(
			file => !NO_HEAD.has(file) && sourceOf(file).includes("component:") && !sourceOf(file).includes("head:")
		)

		expect(missing.sort()).toEqual([])
	})

	it("keeps the allowlist honest — every entry still exists and still has no head", () => {
		expect([...NO_HEAD].filter(file => !sources.has(file)).sort()).toEqual([])
		expect([...NO_HEAD].filter(file => sources.has(file) && sourceOf(file).includes("head:")).sort()).toEqual([])
	})

	it("routes every non-root head through routeHead so none can skip the not-found guard", () => {
		// A hand-written head: closure would silently re-introduce the ancestor-title bug for every
		// not-found URL under that route. The root is the one exception — it reads its own match.
		const handRolled = files.filter(
			file => file !== "__root.tsx" && sourceOf(file).includes("head:") && !sourceOf(file).includes("head: routeHead(")
		)

		expect(handRolled.sort()).toEqual([])
	})
})
