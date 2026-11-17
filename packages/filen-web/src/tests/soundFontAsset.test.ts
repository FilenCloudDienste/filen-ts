import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import manifest from "@/assets/soundfonts/manifest.json"

const read = (path: string): Buffer => readFileSync(new URL(path, import.meta.url))
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

describe("bundled SoundFont", () => {
	it("is the exact build its manifest records, from the scripts in the repository", () => {
		const bank = read("../assets/soundfonts/GeneralUser-GS-2.0.3.sf3")

		expect(bank.byteLength).toBe(manifest.output["GeneralUser-GS-2.0.3.sf3"].bytes)
		expect(sha256(bank)).toBe(manifest.output["GeneralUser-GS-2.0.3.sf3"].sha256)
		expect(sha256(read("../../scripts/soundfont/build-sf3.sh"))).toBe(manifest.sources["build-sf3.sh"])
		expect(sha256(read("../../scripts/soundfont/build-sf3.mjs"))).toBe(manifest.sources["build-sf3.mjs"])
		expect(sha256(read("../assets/soundfonts/GeneralUser-GS-LICENSE.txt"))).toBe(manifest.license["GeneralUser-GS-LICENSE.txt"])
	})

	it("is an SF3 bank, built with the synthesizer version the app plays it with", () => {
		const bank = read("../assets/soundfonts/GeneralUser-GS-2.0.3.sf3")
		const installed = JSON.parse(
			readFileSync(new URL("../../node_modules/spessasynth_core/package.json", import.meta.url), "utf8")
		) as {
			version: string
		}

		expect(bank.subarray(0, 4).toString("latin1")).toBe("RIFF")
		expect(bank.subarray(8, 12).toString("latin1")).toBe("sfbk")
		expect(manifest.converter.spessasynth_core).toBe(installed.version)
	})
})
