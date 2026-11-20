import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { beforeEach, describe, expect, it } from "vitest"
import { THEME_COLORS } from "@/providers/themeProvider"

// public/theme.js runs before the bundle; it is executed here as the browser would, against stubs.
const SCRIPT = readFileSync(new URL("../../public/theme.js", import.meta.url), "utf8")

let store: Map<string, string>
let cookie: string
let classes: string[]
let themeColor: string

function run(systemDark = false, storageBlocked = false): void {
	runInNewContext(SCRIPT, {
		localStorage: {
			getItem: (key: string) => {
				if (storageBlocked) {
					throw new Error("SecurityError")
				}

				return store.get(key) ?? null
			},
			setItem: (key: string, value: string) => store.set(key, value)
		},
		document: {
			get cookie() {
				return cookie
			},
			set cookie(value: string) {
				cookie = value
			},
			documentElement: { classList: { add: (name: string) => classes.push(name) } },
			querySelector: (selector: string) =>
				selector === 'meta[name="theme-color"]'
					? {
							setAttribute: (name: string, value: string) => {
								if (name === "content") {
									themeColor = value
								}
							}
						}
					: null
		},
		window: { matchMedia: () => ({ matches: systemDark }) }
	})
}

beforeEach(() => {
	store = new Map()
	cookie = ""
	classes = []
	themeColor = THEME_COLORS.light
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

	it("tints the browser chrome with the saved theme's canvas, not the OS appearance", () => {
		store.set("theme", "dark")
		run(false)

		expect(themeColor).toBe(THEME_COLORS.dark)

		store.set("theme", "light")
		run(true)

		expect(themeColor).toBe(THEME_COLORS.light)

		store.set("theme", "system")
		run(true)

		expect(themeColor).toBe(THEME_COLORS.dark)
	})

	it("falls back to the OS appearance for the tint when storage is blocked", () => {
		run(true, true)

		expect(classes).toEqual([])
		expect(themeColor).toBe(THEME_COLORS.dark)
	})
})
