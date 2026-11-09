import { readFileSync } from "node:fs"
import { posix } from "node:path"
import { describe, expect, it } from "vitest"

// The nightly and corpus jobs (.github/workflows/office-corpus.yml) wire up the opt-in oracles and fuzzers by the
// variables those read: a renamed variable or a moved build output would leave a suite silently skipping in CI.

function text(path: string): string {
	return readFileSync(new URL(path, import.meta.url), "utf8")
}

const WORKFLOW = text("../../../../.github/workflows/office-corpus.yml")

// Every value the workflow gives `name`, in its env blocks or written to $GITHUB_ENV.
function values(name: string): string[] {
	return [...WORKFLOW.matchAll(new RegExp(`(?:^\\s*${name}: |echo "${name}=)(.+)$`, "gmu"))].map(match =>
		(match[1] ?? "").replace(/^'|'$/gu, "")
	)
}

// The variable `file` reads by the pattern `read` (its first group).
function readVariable(file: string, read: RegExp): string {
	const name = read.exec(text(file))?.[1]

	if (name === undefined) throw new Error(`${file} reads no such variable`)

	return name
}

describe("office corpus workflow", () => {
	it("points FILEN_OFFICE_OOXML_VALIDATOR at the build tools/openxml-validate makes", () => {
		const props = text("../../tools/openxml-validate/Directory.Build.props")
		const artifacts = /<ArtifactsPath>\$\(MSBuildThisFileDirectory\)(.+?)<\/ArtifactsPath>/u.exec(props)?.[1] ?? ""
		const project = "OpenXmlValidate"

		expect(text(`../../tools/openxml-validate/${project}.csproj`)).toContain("<OutputType>Exe</OutputType>")

		const dll = posix.join("packages/filen-office/tools/openxml-validate", artifacts, "bin", project, "release", `${project}.dll`)
		const all = values("FILEN_OFFICE_OOXML_VALIDATOR")

		// The corpus shards and the ODF job.
		expect(all.length).toBe(2)
		expect(new Set(all)).toEqual(new Set([`\${{ github.workspace }}/${dll}`]))
		expect(values("FILEN_OFFICE_DOTNET")).toEqual(["dotnet", "dotnet"])
		expect(WORKFLOW).toContain("dotnet restore --locked-mode")
	})

	it("gives the ODF suites a pinned odfvalidator", () => {
		const read = /process\.env\["(FILEN_OFFICE_ODFVALIDATOR)"\]/u

		for (const suite of ["odtWriterSchema", "odsSaveOracle", "odsConvertCorpus", "convertTextCorpus", "presentationShowOracle"]) {
			expect(readVariable(`./${suite}.test.ts`, read)).toBe("FILEN_OFFICE_ODFVALIDATOR")
			expect(WORKFLOW).toContain(`src/tests/${suite}.test.ts`)
		}

		expect(values("FILEN_OFFICE_ODFVALIDATOR")).toHaveLength(1)
		expect(values("ODFVALIDATOR_SHA256")[0]).toMatch(/^[0-9a-f]{64}$/u)
		expect(WORKFLOW).toContain('echo "${ODFVALIDATOR_SHA256}  $FILEN_OFFICE_ODFVALIDATOR" | sha256sum -c -')
		expect(values(readVariable("./odsConvertCorpus.test.ts", /process\.env\["(FILEN_OFFICE_CONVERT_CORPUS)"\] === "1"/u))).toEqual([
			"1"
		])
	})

	it("derives a seed of the run for every format fuzzer", () => {
		const seeded = [
			readVariable("./rtfFuzz.test.ts", /process\.env\["(\w+_SEED)"\]/u),
			readVariable("./cfbFuzz.test.ts", /process\.env\["(\w+_SEED)"\]/u),
			readVariable("./xlsxReadFuzz.test.ts", /process\.env\["(\w+_SEED)"\]/u),
			readVariable("./odtWriterFuzz.test.ts", /process\.env\["(\w+_FROM)"\]/u),
			readVariable("./presentationSessionFuzz.test.ts", /process\.env\["(\w+_FROM)"\]/u),
			readVariable("./fuzz/sheet/run.ts", /env\["(\w+_SHEET_FUZZ_SEED)"\]/u)
		]
		const derived = seeded.map(name => values(name))

		for (const [at, found] of derived.entries()) {
			expect(found, seeded[at]).toHaveLength(1)
			expect(found[0], seeded[at]).toContain("FILEN_OFFICE_FUZZ_SEED")
		}

		// Each fuzzer's range is its own: the constant offsets differ.
		const offsets = derived.map(found => /(\d{4,})/u.exec(found[0] ?? "")?.[1]).filter(offset => offset !== undefined)

		expect(new Set(offsets).size).toBe(offsets.length)
		expect(values(readVariable("./fuzz/sheet/run.ts", /env\["(FILEN_OFFICE_SHEET_FUZZ)"\]/u))).toEqual(["1"])
	})

	it("runs the recalculation against Excel's cached results at the gate its README states", () => {
		const recalc = readVariable("./sheetOracleCached.test.ts", /process\.env\["(\w+_RECALC)"\] === "1"/u)
		const gate = /process\.env\["FILEN_OFFICE_SHEET_RECALC_MIN"\] \?\? "([\d.]+)"/u.exec(text("./sheetOracleCached.test.ts"))?.[1]

		expect(values(recalc)).toEqual(["1"])
		expect(values(`${recalc}_OUT`)).toHaveLength(1)
		expect(gate).toBe("0.995")
		expect(text("./fuzz/sheet/README.md")).toContain(`\`_MIN\` (${gate ?? ""}) is the rate it must reach`)
	})
})
