import { describe, expect, it } from "vitest"
import { parseVeraPdfReport } from "./oracles/veraPdf"

// The shape of veraPDF's --format xml report (one job).
function report(validation: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<report>
	<buildInformation><releaseDetails id="core" version="1.30.3"></releaseDetails></buildInformation>
	<jobs><job><item size="1"><name>/tmp/out.pdf</name></item>${validation}</job></jobs>
	<batchSummary totalJobs="1" failedToParse="0" encrypted="0" outOfMemory="0" veraExceptions="0"></batchSummary>
</report>`
}

describe("parseVeraPdfReport", () => {
	it("reads a compliant report", () => {
		const xml = report(
			'<validationReport jobEndStatus="normal" profileName="PDF/UA-1 validation profile" isCompliant="true"><details passedRules="106" failedRules="0"></details></validationReport>'
		)

		expect(parseVeraPdfReport(xml)).toEqual({ compliant: true, failedRules: [] })
	})

	it("names each failed rule once, as clause-testNumber, and skips passed ones", () => {
		const xml = report(`<validationReport jobEndStatus="normal" profileName="PDF/UA-1 validation profile" isCompliant="false">
	<details passedRules="104" failedRules="2">
		<rule specification="ISO 14289-1:2014" clause="7.18.1" testNumber="2" status="failed" failedChecks="2"><check status="failed"/></rule>
		<rule status="passed" specification="ISO 14289-1:2014" clause="7.2" testNumber="1"></rule>
		<rule specification="ISO 14289-1:2014" clause="7.1" testNumber="3" status="failed" failedChecks="1"></rule>
		<rule specification="ISO 14289-1:2014" clause="7.1" testNumber="3" status="failed" failedChecks="1"></rule>
	</details>
</validationReport>`)

		expect(parseVeraPdfReport(xml)).toEqual({ compliant: false, failedRules: ["7.1-3", "7.18.1-2"] })
	})

	it("throws when there is no validation result", () => {
		const xml =
			'<report><jobs><job><item size="1"><name>x.pdf</name></item><taskException type="PARSE" isExecuted="true" isSuccess="false"><exceptionMessage>Couldn\'t parse stream</exceptionMessage></taskException></job></jobs></report>'

		expect(() => parseVeraPdfReport(xml)).toThrow(/no validation report/)
		expect(() => parseVeraPdfReport("")).toThrow(/no validation report/)
	})

	it("throws on non-compliance without a failed rule", () => {
		expect(() =>
			parseVeraPdfReport(report('<validationReport isCompliant="false"><details failedRules="0"></details></validationReport>'))
		).toThrow(/without a failed rule/)
	})
})
