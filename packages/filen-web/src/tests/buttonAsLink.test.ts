import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Drift guard: a link styled as a button is a real <a>/<Link> with buttonVariants' classes. Base UI's
// Button with a link in `render` either logs its native-button error or, with `nativeButton={false}`,
// stamps role="button" on the link, so it would announce as a button and lose its link semantics.
const SRC_DIR = "src"

function tsxFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const path = join(dir, entry.name)

		if (entry.isDirectory()) {
			return entry.name === "tests" ? [] : tsxFiles(path)
		}

		return entry.name.endsWith(".tsx") ? [path] : []
	})
}

// A <Button …> opening tag whose `render` element is an anchor or a router Link.
const BUTTON_AS_LINK = /<Button\b(?:[^>]|=>)*?render=\{\s*<(?:a|Link)\b/

describe("links styled as buttons", () => {
	it("never go through Base UI's Button", () => {
		expect(tsxFiles(SRC_DIR).filter(file => BUTTON_AS_LINK.test(readFileSync(file, "utf8")))).toEqual([])
	})

	it("the guard recognises the pattern it forbids", () => {
		expect(BUTTON_AS_LINK.test('<Button variant="outline" render={<a href="x" />}>')).toBe(true)
		expect(BUTTON_AS_LINK.test('<Button\n\tsize="sm"\n\trender={\n\t\t<Link to="/" />\n\t}\n>')).toBe(true)
		expect(BUTTON_AS_LINK.test('<Button render={<Button variant="ghost" />}>')).toBe(false)
	})
})
