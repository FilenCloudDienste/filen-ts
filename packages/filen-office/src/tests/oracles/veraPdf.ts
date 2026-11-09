import { spawnSync } from "node:child_process"

// veraPDF's command-line validator (https://verapdf.org) as an oracle: one file against one profile, the machine
// readable report (--format xml) reduced to the rules that failed, each named as veraPDF names it
// ("<clause>-<testNumber>", e.g. "7.1-3" of ISO 14289-1).

export interface VeraPdfResult {
	readonly compliant: boolean
	readonly failedRules: readonly string[]
}

function attribute(tag: string, name: string): string | undefined {
	return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
}

// The report of a single file; throws when it holds no validation result (the file failed to parse, or the
// validator stopped), so a broken PDF never passes as one without failures.
export function parseVeraPdfReport(xml: string): VeraPdfResult {
	const report = /<validationReport\b[^>]*>/.exec(xml)?.[0]
	const compliant = report === undefined ? undefined : attribute(report, "isCompliant")

	if (report === undefined || (compliant !== "true" && compliant !== "false")) {
		throw new Error(`veraPDF produced no validation report:\n${xml.slice(0, 2000)}`)
	}

	const failed = new Set<string>()

	for (const [rule] of xml.matchAll(/<rule\b[^>]*>/g)) {
		if (attribute(rule, "status") !== "failed") continue

		failed.add(`${attribute(rule, "clause") ?? "?"}-${attribute(rule, "testNumber") ?? "?"}`)
	}

	if (compliant === "false" && failed.size === 0)
		throw new Error(`veraPDF reports non-compliance without a failed rule:\n${xml.slice(0, 2000)}`)

	return { compliant: compliant === "true", failedRules: [...failed].sort() }
}

// Exit 0 is compliant, 1 not compliant; any other status is the validator failing.
export function runVeraPdf(binary: string, profile: string, path: string): VeraPdfResult {
	const run = spawnSync(binary, ["-f", profile, "--format", "xml", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

	if (run.status !== 0 && run.status !== 1) {
		throw new Error(`veraPDF exited ${String(run.status)}: ${run.error?.message ?? ""}${run.stderr.slice(0, 2000)}`)
	}

	return parseVeraPdfReport(run.stdout)
}
