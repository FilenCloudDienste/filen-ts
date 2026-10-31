import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { errorMessage, fail } from "../support.ts"
import type { Target } from "../targets.ts"

export interface SpikeOptions {
	target: Target
	nextDir: string
	nextVersion: string
	signed: boolean
	work: string
	artifacts: string
}

// A run's evidence (a spike's, or a chain's assertion table): every check runs (one failing does not hide the next),
// each is logged as it ends, and the whole list goes to <artifacts>/<name>-findings.json and the job summary. finish()
// fails the run if any check failed. must() is a check the rest of the run depends on: it throws when it fails.

export interface Finding {
	check: string
	ok: boolean
	// Information only: recorded, never a failure.
	info: boolean
	detail: string
}

export interface Findings {
	check(name: string, probe: () => string | Promise<string>): Promise<boolean>
	must(name: string, probe: () => string | Promise<string>): Promise<void>
	info(name: string, detail: string): void
	attach(name: string, text: string): void
	finish(): void
}

export function createFindings(title: string, artifacts: string, redact: (text: string) => string = text => text): Findings {
	const list: Finding[] = []

	mkdirSync(artifacts, { recursive: true })

	const record = (finding: Finding) => {
		const entry = { ...finding, detail: redact(finding.detail) }

		list.push(entry)
		console.log(`${entry.info ? "INFO" : entry.ok ? "PASS" : "FAIL"}  ${entry.check}: ${entry.detail}`)
	}

	const check = async (name: string, probe: () => string | Promise<string>): Promise<boolean> => {
		try {
			record({ check: name, ok: true, info: false, detail: await probe() })

			return true
		} catch (error) {
			record({ check: name, ok: false, info: false, detail: errorMessage(error) })

			return false
		}
	}

	return {
		check,
		async must(name, probe) {
			if (!(await check(name, probe))) {
				fail(`${name} failed; the run cannot go on`)
			}
		},
		info(name, detail) {
			record({ check: name, ok: true, info: true, detail })
		},
		attach(name, text) {
			writeFileSync(path.join(artifacts, name), redact(text))
		},
		finish() {
			writeFileSync(path.join(artifacts, `${title}-findings.json`), `${JSON.stringify(list, null, "\t")}\n`)

			const summary = process.env["GITHUB_STEP_SUMMARY"]

			if (summary) {
				const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")

				appendFileSync(
					summary,
					[
						`### ${title}`,
						"",
						"| result | check | detail |",
						"|---|---|---|",
						...list.map(
							entry =>
								`| ${entry.info ? "info" : entry.ok ? "pass" : "**fail**"} | ${cell(entry.check)} | ${cell(entry.detail)} |`
						),
						"",
						""
					].join("\n")
				)
			}

			const failed = list.filter(entry => !entry.ok)

			if (failed.length > 0) {
				fail(`${title}: ${String(failed.length)} check(s) failed: ${failed.map(entry => entry.check).join("; ")}`)
			}

			console.log(`\n${title}: every check passed`)
		}
	}
}
