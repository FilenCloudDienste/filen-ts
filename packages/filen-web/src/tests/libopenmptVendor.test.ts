import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import manifest from "@/vendor/libopenmpt/manifest.json"

const read = (path: string): Buffer => readFileSync(new URL(path, import.meta.url))
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

describe("vendored libopenmpt module", () => {
	it("is the exact build its manifest records, with the extension list read from it", () => {
		for (const name of ["libopenmpt.js", "libopenmpt.wasm"] as const) {
			const file = read(`../vendor/libopenmpt/${name}`)

			expect(file.byteLength, name).toBe(manifest.output[name].bytes)
			expect(sha256(file), name).toBe(manifest.output[name].sha256)
		}

		expect(sha256(read("../vendor/libopenmpt/extensions.json"))).toBe(manifest.output["extensions.json"])
	})

	it("was built by the scripts in the repository, from a release its upstream tag pins", () => {
		for (const name of ["build-libopenmpt.sh", "libopenmpt-bridge.c", "emscripten.sh"] as const) {
			expect(sha256(read(`../../scripts/codecs/${name}`)), name).toBe(manifest.sources[name])
		}

		expect(manifest.libopenmpt.tag).toBe(`libopenmpt-${manifest.libopenmpt.version}`)
		expect(manifest.libopenmpt.commit).toMatch(/^[0-9a-f]{40}$/)
	})

	it("ships the licences of what is linked in, as recorded at build time", () => {
		for (const [name, hash] of Object.entries(manifest.licenses)) {
			expect(sha256(read(`../vendor/libopenmpt/licenses/${name}`)), name).toBe(hash)
		}
	})

	it("catches C++ exceptions in WebAssembly, caps its heap, takes its wasm compiled, and needs nothing the CSP forbids", () => {
		const source = read("../vendor/libopenmpt/libopenmpt.js").toString("utf8")

		expect(manifest.link).toContain("-fwasm-exceptions")
		expect(manifest.link).toContain("-sMAXIMUM_MEMORY=256MB")
		expect(manifest.link).toContain("-sINCOMING_MODULE_JS_API=[instantiateWasm]")
		expect(source.match(/\beval\(|new Function\(|importScripts\(/g)).toBeNull()
	})
})
