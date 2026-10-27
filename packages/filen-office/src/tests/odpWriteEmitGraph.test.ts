import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

// The ODP emit families and their hub (core/odp/write/emit.ts) load in any order: a family imports only types from the
// hub (the hub's registry reads every family at evaluation, so a family that needs the hub at run time would meet a
// family binding not initialised yet when it is imported first, as the presentation worker's bundle does).

const FAMILIES = join(import.meta.dirname, "..", "core", "odp", "write", "emit")

describe("ODP emit module graph", () => {
	it("loads every family first, in a fresh module graph, without meeting the hub half-evaluated", async () => {
		for (const file of readdirSync(FAMILIES).filter(name => name.endsWith(".ts"))) {
			vi.resetModules()

			const family = (await import(join(FAMILIES, file))) as Record<string, unknown>

			expect(Object.keys(family).length, file).toBeGreaterThan(0)

			const hub = (await import("../core/odp/write/emit")) as { ODP_EMIT_FAMILIES: Record<string, unknown> }

			for (const [name, value] of Object.entries(hub.ODP_EMIT_FAMILIES)) expect(value, `${file}: ${name}`).toBeDefined()
		}
	})

	it("imports nothing but types from the hubs in a family file", () => {
		for (const file of readdirSync(FAMILIES).filter(name => name.endsWith(".ts"))) {
			const source = readFileSync(join(FAMILIES, file), "utf8")
			const runtime = [...source.matchAll(/^import\s+(?!type\b)([^;]*?)\s+from\s+"([^"]+)"/gmu)]
				.filter(match => /(^|\/)emit$/u.test(match[2] ?? "") && !/^\{\s*(type\s+[\w]+\s*,?\s*)+\}$/u.test((match[1] ?? "").trim()))
				.map(match => match[2])

			expect(runtime, file).toEqual([])
		}
	})
})
