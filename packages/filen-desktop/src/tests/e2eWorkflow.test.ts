import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// What the e2e workflows may never do with the account: print it. GitHub prints a step's environment and a job's
// outputs with the step, so the sealed session travels as a file only, and the credentials only as secrets (which
// GitHub masks).
const workflow = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../.github/workflows/${name}`, import.meta.url)), "utf8")

describe("desktop e2e workflow secrets", () => {
	const text = workflow("desktop-e2e.yml")

	it("never puts the sealed session in an environment variable or a job output", () => {
		expect(text).not.toMatch(/FILEN_DESKTOP_E2E_SESSION\s*:/)
		expect(text).not.toMatch(/steps\.login\.outputs|needs\.session\.outputs/)
		expect(
			text.match(/FILEN_DESKTOP_E2E_SESSION_FILE: \$\{\{ runner\.temp \}\}\/e2e-session\/session\.sealed/g)?.length
		).toBeGreaterThan(1)
	})

	it("takes the account's email and password from secrets only", () => {
		const assignments = [...text.matchAll(/FILEN_DESKTOP_E2E_TEST_(EMAIL|PASSWORD):\s*(.+)/g)].map(match => match[2]?.trim())

		expect(assignments.length).toBeGreaterThan(0)
		expect(
			assignments.every(value =>
				/^\$\{\{ (matrix\.spike == 's7' && )?secrets\.FILEN_DESKTOP_E2E_TEST_(EMAIL|PASSWORD)( \|\| '')? \}\}$/.test(value ?? "")
			)
		).toBe(true)
	})

	it("deletes the sealed session's artifact when the run is swept", () => {
		expect(text).toContain("name: desktop-e2e-session")
		expect(text).toMatch(/Delete the sealed session[\s\S]*select\(\.name == "desktop-e2e-session"\)/)
		expect(text).toMatch(/retention-days: 1\n\s+overwrite: true/)
	})
})
