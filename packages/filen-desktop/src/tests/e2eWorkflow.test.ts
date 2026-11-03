import { spawnSync } from "node:child_process"
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
		expect(text).not.toMatch(/steps\.login\.outputs/)
		// The session job's one output: whether 3.0.47's signed-in chain was dropped for the account's auth version.
		expect([...new Set([...text.matchAll(/needs\.session\.outputs\.([\w-]+)/g)].map(match => match[1]))]).toEqual(["older"])
		expect(text).toContain("    outputs:\n      older: ${{ steps.pins.outputs.older }}\n")
		expect(text.match(/FILEN_DESKTOP_E2E_SESSION_DIR: \$\{\{ runner\.temp \}\}\/e2e-session\n/g)?.length).toBeGreaterThan(1)
		// The session job's step outputs: whether each slot minted, which gates saving it to the cache; nothing else.
		expect(
			[...new Set([...text.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)].map(match => `${match[1] ?? ""}.${match[2] ?? ""}`))]
				.filter(output => !output.startsWith("plan.") && !output.startsWith("submodules."))
				.sort()
		).toEqual(["pins.older", "quota.minted", "test.minted"])
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
		expect(text).not.toMatch(/at most 1[17]\b/)
		expect(text).toContain("per IP")
	})

	it("runs 3.0.47 -> N at install depth and deep, checks the account's auth version first and drops only its chain", () => {
		expect(text).toContain("pins: ${{ steps.plan.outputs.pins }}")
		expect(text).toMatch(
			/Check the test account against the old clients\n\s+id: pins\n\s+if: needs\.plan\.outputs\.pins != ''[\s\S]{0,400}E2E_SIGN_IN_PINS: \$\{\{ needs\.plan\.outputs\.pins \}\}\n\s+run: node scripts\/ci\/e2eCloud\.ts pins\n/
		)
		// Before the quota slot and the hand-off's upload, after the test session is written.
		expect(text.indexOf("Check the test account against the old clients")).toBeGreaterThan(text.indexOf("Cache the new test session"))
		expect(text.indexOf("Check the test account against the old clients")).toBeLessThan(text.indexOf("Hand the sealed sessions on"))
		expect(text).toContain(
			"if: ${{ !cancelled() && matrix.older && (!matrix.deepOlder || needs.session.outputs.older == 'dropped') }}\n        timeout-minutes: 30\n        run: node scripts/ci/e2e.ts --scenario older ${{ env.TEST_ARGS }}"
		)
		// An account 3.0.47 cannot sign in to drops its signed-in chain only: the install-only update runs in its place.
		expect(text).toContain("if: ${{ !cancelled() && matrix.deepOlder && needs.session.outputs.older != 'dropped' }}")
		expect(text).toContain("E2E_SIGN_IN: ${{ matrix.signInOlder }}")
		expect(text).toContain("bash scripts/ci/deepSession.sh --scenario older --depth deep")
	})

	it("runs a scale reseed alone, and never fails the session job on the scale tree", () => {
		expect(text).toMatch(
			/name: Run a scale reseed alone\n\s+if: inputs\.scale_reseed && github\.workflow == 'Desktop E2E'\n[\s\S]{0,400}if \[ "\$\{active\}" -gt 0 \]; then[\s\S]{0,160}exit 1/
		)
		expect(text).toMatch(/name: The scale fixture tree\n\s+continue-on-error: true\n/)
	})

	it("deletes the sealed session's artifact when the run is swept", () => {
		expect(text).toContain("name: desktop-e2e-session")
		expect(text).toMatch(/Delete the sealed session[\s\S]*select\(\.name == "desktop-e2e-session"\)/)
		expect(text).toMatch(/retention-days: 1\n\s+overwrite: true/)
	})
})

describe("desktop e2e workflow chain K", () => {
	const text = workflow("desktop-e2e.yml")
	const step = (name: string) => {
		const start = text.indexOf(`- name: ${name}\n`)

		return start === -1 ? "" : text.slice(start, text.indexOf("\n      - name:", start + 1))
	}

	it("runs chain K after chain L's steps with no secret and no session", () => {
		const chain = step("Keyring chain K, no sign-in")

		expect(chain).toContain("if: ${{ !cancelled() && matrix.keyring }}")
		expect(chain).toContain("run: node scripts/ci/e2e.ts --scenario keyring ${{ env.TEST_ARGS }} --artifacts e2e-artifacts")
		expect(chain).not.toMatch(/secrets\.|E2E_SIGN_IN|SESSION/)
		// A budget below the step's timeout, so an overrun keeps its evidence; the job's timeout (the plan's) counts it.
		expect(chain).toContain("timeout-minutes: 45")
		expect(chain).toContain("E2E_CHAIN_BUDGET_MINUTES: 40")
		expect(text.indexOf("- name: Keyring chain K, no sign-in")).toBeGreaterThan(text.indexOf("- name: 3.0.53 -> N, signed in"))
		expect(step("Prepare the keyring chain")).toContain("dbus-bin")
		// A keyring-only entry is deep (the harness) without a session to download.
		expect(text).toContain(
			"- name: Download the sealed session\n        if: matrix.deepPrevious || matrix.deepLegacy || matrix.deepOlder\n"
		)
		expect(text).not.toContain("if: matrix.deep\n")
	})

	it("offers the keyring-mac spike and the keyring scenario by hand", () => {
		expect(text).toContain("          - keyring-mac\n")
		expect(text.match(/description: Comma-separated subset of [a-z,-]*\bkeyring\b/g)).toHaveLength(2)
	})
})

// The deep chains' desktop session (scripts/ci/deepSession.sh): Linux's keyring is proven before the chain starts.
describe("the deep chains' desktop session", () => {
	const file = fileURLToPath(new URL("../../scripts/ci/deepSession.sh", import.meta.url))
	const text = readFileSync(file, "utf8")
	const inner = /bash -ec '\n([\s\S]*)\n' e2e "\$@"\n$/.exec(text)?.[1] ?? ""

	it.runIf(process.platform !== "win32")("parses, the D-Bus session's script too", () => {
		expect(inner).not.toBe("")
		expect(spawnSync("bash", ["-n", file]).status).toBe(0)
		expect(spawnSync("bash", ["-n"], { input: inner }).status).toBe(0)
	})

	it("starts gnome-keyring on directories of its own, keeping its output, and never hands its password on", () => {
		expect(inner).toContain(
			'XDG_DATA_HOME="${KEYRING_HOME}/data" XDG_RUNTIME_DIR="${KEYRING_HOME}/run" \\\n\t\t\tgnome-keyring-daemon --foreground --unlock --components=secrets >> "${KEYRING_LOG}" 2>&1 &'
		)
		expect(inner.indexOf("unset KEYRING_PASSWORD")).toBeLessThan(inner.indexOf("exec node scripts/ci/e2e.ts"))
		expect(inner).not.toMatch(/export XDG_(DATA_HOME|RUNTIME_DIR)/)
	})

	it("fails before the chain unless the login collection is unlocked, the default, and stores without a prompt", () => {
		const start = inner.indexOf("exec node scripts/ci/e2e.ts")

		for (const step of [
			'*"boolean false"*) ;;',
			"org.freedesktop.Secret.Service.SetAlias string:default",
			"secret-tool store",
			'secret-tool lookup filen-e2e keyring-probe)" = "${probe}" ]'
		]) {
			expect(inner.indexOf(step)).toBeGreaterThan(-1)
			expect(inner.indexOf(step)).toBeLessThan(start)
		}
	})
})
