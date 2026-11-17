import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

// Every decoder file the pinned loaders fetch from a decoder path is shipped under the versioned base.

const { THREE_ASSETS_BASE, THREE_ASSET_FILES, threeAssets } = await import("../../vite/three-assets-plugin")

const JSM = join(dirname(dirname(createRequire(import.meta.url).resolve("three"))), "examples/jsm")

describe("three assets", () => {
	it("ship the files DRACOLoader and KTX2Loader name, from three's own libs", () => {
		const draco = readFileSync(join(JSM, "loaders/DRACOLoader.js"), "utf8")
		const ktx2 = readFileSync(join(JSM, "loaders/KTX2Loader.js"), "utf8")

		for (const file of THREE_ASSET_FILES) expect(existsSync(join(JSM, "libs", file)), file).toBe(true)
		for (const name of ["draco_wasm_wrapper.js", "draco_decoder.wasm"]) expect(draco).toContain(`'${name}'`)
		for (const name of ["basis_transcoder.js", "basis_transcoder.wasm"]) expect(ktx2).toContain(`'${name}'`)
	})

	it("serve each decoder directory under the versioned base", async () => {
		const load = threeAssets({ emit: false }).load

		expect(typeof load).toBe("function")

		if (typeof load !== "function") return

		const source: unknown = await Reflect.apply(load, {}, ["\0virtual:three-assets"])

		expect(THREE_ASSETS_BASE).toMatch(/^\/assets\/three-\d+\.\d+\.\d+\/$/)
		expect(String(source)).toContain(`"draco":"${THREE_ASSETS_BASE}draco/gltf/"`)
		expect(String(source)).toContain(`"basis":"${THREE_ASSETS_BASE}basis/"`)
	})
})
