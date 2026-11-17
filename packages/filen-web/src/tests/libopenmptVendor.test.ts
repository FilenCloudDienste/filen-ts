import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import manifest from "@/vendor/libopenmpt/manifest.json"

const read = (path: string): Buffer => readFileSync(new URL(path, import.meta.url))
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

describe("vendored libopenmpt module", () => {
	it("is the exact build its manifest records, with the extension list read from it", () => {
		const file = read("../vendor/libopenmpt/libopenmpt.js")

		expect(file.byteLength).toBe(manifest.output["libopenmpt.js"].bytes)
		expect(sha256(file)).toBe(manifest.output["libopenmpt.js"].sha256)
		expect(sha256(read("../vendor/libopenmpt/extensions.json"))).toBe(manifest.output["extensions.json"])
	})

	it("was built by the scripts in the repository", () => {
		expect(sha256(read("../../scripts/codecs/build-libopenmpt.sh"))).toBe(manifest.sources["build-libopenmpt.sh"])
		expect(sha256(read("../../scripts/codecs/emscripten.sh"))).toBe(manifest.sources["emscripten.sh"])
	})

	it("ships the licences of what is linked in, as recorded at build time", () => {
		for (const [name, hash] of Object.entries(manifest.licenses)) {
			expect(sha256(read(`../vendor/libopenmpt/licenses/${name}`)), name).toBe(hash)
		}
	})

	it("catches C++ exceptions in WebAssembly, caps its heap, and needs nothing the CSP forbids", () => {
		const source = read("../vendor/libopenmpt/libopenmpt.js").toString("utf8")

		expect(manifest.link).toContain("-fwasm-exceptions")
		expect(manifest.link).toContain("-sMAXIMUM_MEMORY=256MB")
		expect(source.match(/\beval\(|new Function\(|importScripts\(/g)).toBeNull()
	})
})
