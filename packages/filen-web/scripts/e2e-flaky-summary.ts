// Lists the end-to-end tests that passed only on a retry (Playwright's "flaky"), from the JSON report the CI run
// writes: in the job's summary, and as a warning on each test's line, so a green run still shows them.
// Usage: node scripts/e2e-flaky-summary.ts <report.json>
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import type { JSONReport, JSONReportSuite } from "@playwright/test/reporter"

interface Flaky {
	title: string
	project: string
	file: string
	line: number
}

function collect(suite: JSONReportSuite, titles: readonly string[], out: Flaky[]): void {
	const path = suite.title === "" || suite.title === suite.file ? titles : [...titles, suite.title]

	for (const spec of suite.specs) {
		for (const test of spec.tests) {
			if (test.status === "flaky") {
				out.push({ title: [...path, spec.title].join(" › "), project: test.projectName, file: spec.file, line: spec.line })
			}
		}
	}

	for (const child of suite.suites ?? []) {
		collect(child, path, out)
	}
}

const reportPath = process.argv[2]

if (reportPath === undefined || !existsSync(reportPath)) {
	// No report: the run ended before Playwright wrote one, and its own failure says why.
	process.exit(0)
}

const report = JSON.parse(readFileSync(reportPath, "utf8")) as JSONReport
const flaky: Flaky[] = []

for (const suite of report.suites) {
	collect(suite, [], flaky)
}

const lines =
	flaky.length === 0
		? ["### End-to-end: no test needed a retry"]
		: [
				`### End-to-end: ${String(flaky.length)} test${flaky.length === 1 ? "" : "s"} passed only on a retry`,
				"",
				"| Project | Test | Where |",
				"| --- | --- | --- |",
				...flaky.map(test => `| ${test.project} | ${test.title.replaceAll("|", "\\|")} | ${test.file}:${String(test.line)} |`)
			]

for (const test of flaky) {
	console.log(
		`::warning file=packages/filen-web/e2e/${test.file},line=${String(test.line)}::Flaky (passed on retry) in ${test.project}: ${test.title}`
	)
}

const summary = process.env["GITHUB_STEP_SUMMARY"]

if (summary !== undefined && summary !== "") {
	appendFileSync(summary, `${lines.join("\n")}\n`)
} else {
	console.log(lines.join("\n"))
}
