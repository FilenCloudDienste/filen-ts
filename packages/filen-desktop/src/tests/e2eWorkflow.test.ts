import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// What the e2e workflows may never do with the accounts: print them. GitHub prints a step's environment and a job's
// outputs with the step, so the sealed sessions travel as files only (cache and artifact), and the credentials and the
// sealing key only as secrets (which GitHub masks).
const workflow = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../.github/workflows/${name}`, import.meta.url)), "utf8")

describe("desktop e2e workflow secrets", () => {
	const text = workflow("desktop-e2e.yml")

	it("never puts the sealed session in an environment variable or a job output", () => {
		expect(text).not.toMatch(/FILEN_DESKTOP_E2E_SESSION\s*:/)
		expect(text).not.toMatch(/steps\.login\.outputs|needs\.session\.outputs/)
		expect(text.match(/FILEN_DESKTOP_E2E_SESSION_DIR: \$\{\{ runner\.temp \}\}\/e2e-session\n/g)?.length).toBeGreaterThan(1)
		// The session job's step outputs: whether each slot minted, which gates saving it to the cache; nothing else.
		expect(
			[...new Set([...text.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)].map(match => `${match[1] ?? ""}.${match[2] ?? ""}`))]
				.filter(output => !output.startsWith("plan.") && !output.startsWith("submodules."))
				.sort()
		).toEqual(["quota.minted", "test.minted"])
	})

	it("takes the accounts' emails and passwords and the sealing key from secrets only", () => {
		const assignments = [...text.matchAll(/FILEN_DESKTOP_E2E_TEST_(EMAIL|PASSWORD):\s*(.+)/g)].map(match => match[2]?.trim())

		expect(assignments.length).toBeGreaterThan(0)
		expect(
			assignments.every(value =>
				/^\$\{\{ (matrix\.spike == 's7' && )?secrets\.FILEN_DESKTOP_E2E_TEST_(EMAIL|PASSWORD)( \|\| '')? \}\}$/.test(value ?? "")
			)
		).toBe(true)

		for (const name of ["FILEN_DESKTOP_E2E_QUOTA_EMAIL", "FILEN_DESKTOP_E2E_QUOTA_PASSWORD", "FILEN_DESKTOP_E2E_SESSION_KEY"]) {
			const values = [...text.matchAll(new RegExp(`^\\s+${name}:\\s*(.+)$`, "gm"))].map(match => match[1]?.trim())

			expect(values.length).toBeGreaterThan(0)
			expect(values.every(value => value === `\${{ secrets.${name} }}`)).toBe(true)
		}
	})

	it("restores each slot's cached session and saves it only when that slot minted, under the run attempt's own key", () => {
		for (const slot of ["test", "quota"]) {
			const key = `key: desktop-e2e-session-v1-${slot}-\${{ github.run_id }}-\${{ github.run_attempt }}`

			expect(text).toContain(`restore-keys: desktop-e2e-session-v1-${slot}-\n`)
			expect(text).toContain(`run: node scripts/ci/e2eCloud.ts session --slot ${slot}\n`)
			expect(text).toMatch(
				new RegExp(
					`if: steps\\.${slot}\\.outputs\\.minted == 'true'\\n\\s+uses: actions/cache/save@v4\\n[\\s\\S]{0,120}${key.replace(/[$.{}|]/g, "\\$&")}`
				)
			)
			expect(text.split(key).length - 1).toBe(2)
		}
	})

	it("tells each deep chain how it signs in, and lets a custom run ask for real sign-ins", () => {
		expect(text).toContain("E2E_SIGN_IN: ${{ matrix.signInPrevious }}")
		expect(text).toContain("E2E_SIGN_IN: ${{ matrix.signInLegacy }}")
		expect(text).toContain("SIGNIN: ${{ inputs.signin }}")
		expect(text).toContain("MAX_OTHER_RUNS: 5")
		expect(text).not.toContain("at most 11")
	})

	it("deletes the sealed session's artifact when the run is swept", () => {
		expect(text).toContain("name: desktop-e2e-session")
		expect(text).toMatch(/Delete the sealed session[\s\S]*select\(\.name == "desktop-e2e-session"\)/)
		expect(text).toMatch(/retention-days: 1\n\s+overwrite: true/)
	})
})
