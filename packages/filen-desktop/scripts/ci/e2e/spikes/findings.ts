import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { errorMessage, fail } from "../../support.ts"
import type { Target } from "../../targets.ts"

export interface SpikeOptions {
	target: Target
	nextDir: string
	nextVersion: string
	signed: boolean
	work: string
	artifacts: string
}

// A spike's evidence: every check runs (one failing does not hide the next), each is logged as it ends, and the whole
// list goes to <artifacts>/<spike>-findings.json and the job summary. finish() fails the run if any check failed.

export interface Finding {
	check: string
	ok: boolean
	// Information only: recorded, never a failure.
	info: boolean
	detail: string
}

export interface Findings {
	check(name: string, probe: () => string | Promise<string>): Promise<boolean>
	info(name: string, detail: string): void
	attach(name: string, text: string): void
	finish(): void
}

export function createFindings(spike: string, artifacts: string, redact: (text: string) => string = text => text): Findings {
	const list: Finding[] = []

	mkdirSync(artifacts, { recursive: true })

	const record = (finding: Finding) => {
		const entry = { ...finding, detail: redact(finding.detail) }

		list.push(entry)
		console.log(`${entry.info ? "INFO" : entry.ok ? "PASS" : "FAIL"}  ${entry.check}: ${entry.detail}`)
	}

	return {
		async check(name, probe) {
			try {
				record({ check: name, ok: true, info: false, detail: await probe() })

				return true
			} catch (error) {
				record({ check: name, ok: false, info: false, detail: errorMessage(error) })

				return false
			}
		},
		info(name, detail) {
			record({ check: name, ok: true, info: true, detail })
		},
		attach(name, text) {
			writeFileSync(path.join(artifacts, name), redact(text))
		},
		finish() {
			writeFileSync(path.join(artifacts, `${spike}-findings.json`), `${JSON.stringify(list, null, "\t")}\n`)

			const summary = process.env["GITHUB_STEP_SUMMARY"]

			if (summary) {
				const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")

				appendFileSync(
					summary,
					[
						`### ${spike}`,
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
				fail(`${spike}: ${String(failed.length)} check(s) failed: ${failed.map(entry => entry.check).join("; ")}`)
			}

			console.log(`\n${spike}: every check passed`)
		}
	}
}
