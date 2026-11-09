import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { beforeEach, describe, expect, it } from "vitest"

// public/theme.js runs before the bundle; it is executed here as the browser would, against stubs.
const SCRIPT = readFileSync(new URL("../../public/theme.js", import.meta.url), "utf8")

let store: Map<string, string>
let cookie: string
let classes: string[]

function run(systemDark = false): void {
	runInNewContext(SCRIPT, {
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value)
		},
		document: {
			get cookie() {
				return cookie
			},
			set cookie(value: string) {
				cookie = value
			},
			documentElement: { classList: { add: (name: string) => classes.push(name) } }
		},
		window: { matchMedia: () => ({ matches: systemDark }) }
	})
}

beforeEach(() => {
	store = new Map()
	cookie = ""
	classes = []
})

describe("theme.js", () => {
	it("takes over the previous web app's theme cookie before paint, then expires it", () => {
		cookie = "refId=abc; theme=dark"
		run()

		expect(classes).toEqual(["dark"])
		expect(store.get("theme")).toBe("dark")
		expect(cookie).toBe("theme=; Max-Age=0; path=/")
	})

	it("keeps a theme saved here and still expires the cookie", () => {
		store.set("theme", "light")
		cookie = "theme=dark"
		run(true)

		expect(classes).toEqual(["light"])
		expect(store.get("theme")).toBe("light")
		expect(cookie).toBe("theme=; Max-Age=0; path=/")
	})

	it("ignores a cookie value it does not know and leaves other cookies alone", () => {
		cookie = "affId=1; theme=sepia"
		run(true)

		expect(classes).toEqual(["dark"])
		expect(store.has("theme")).toBe(false)

		cookie = "refId=abc"
		run()

		expect(cookie).toBe("refId=abc")
	})
})
