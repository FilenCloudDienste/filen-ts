import { describe, expect, it } from "vitest"
import type { Plugin } from "vite"

// The workers' instances of the office asset plugins (`emit: false`): the virtual modules and URLs of the page's
// instance, without the dev middleware or the verify-and-emit every worker bundle would otherwise repeat.

const { officeFonts } = await import("../../vite/office-fonts-plugin")
const { officeHyphenation } = await import("../../vite/office-hyphenation-plugin")

const CASES = [
	{
		name: "officeFonts",
		create: officeFonts,
		ids: ["virtual:office-fonts", "virtual:office-pdf-fonts", "virtual:office-signature-fonts"]
	},
	{ name: "officeHyphenation", create: officeHyphenation, ids: ["virtual:office-hyphenation"] }
]

function hook(plugin: Plugin, name: "configResolved" | "resolveId" | "load"): (...args: unknown[]) => unknown {
	const value: unknown = plugin[name]

	if (typeof value !== "function") throw new Error(`${plugin.name} has no ${name} hook`)

	return (...args: unknown[]): unknown => Reflect.apply(value, {}, args)
}

// What the plugin answers for `id` once configured for `command`: the resolved id and the loaded module.
async function modules(plugin: Plugin, command: "build" | "serve", ids: readonly string[]): Promise<unknown[]> {
	await hook(plugin, "configResolved")({ command })

	return Promise.all(
		ids.map(async id => {
			const resolved = await hook(plugin, "resolveId")(id, undefined, {})

			return [resolved, await hook(plugin, "load")(resolved)]
		})
	)
}

describe("the workers' office asset plugins", () => {
	it.each(CASES)("$name({ emit: false }) has no dev middleware and emits nothing", ({ create }) => {
		const plugin = create({ emit: false })

		expect(plugin.generateBundle).toBeUndefined()
		expect(plugin.configureServer).toBeUndefined()
		expect(create().generateBundle).toBeTypeOf("function")
		expect(create().configureServer).toBeTypeOf("function")
	})

	it.each(CASES)("$name({ emit: false }) resolves and loads its modules with the page instance's URLs", async ({ create, ids }) => {
		for (const command of ["build", "serve"] as const) {
			const worker = await modules(create({ emit: false }), command, ids)

			expect(worker).toEqual(await modules(create(), command, ids))

			for (const [resolved, source] of worker as [unknown, unknown][]) {
				expect(resolved).toBeTypeOf("string")
				expect(source).toMatch(/^export const [A-Z_]+ = Object\.freeze\(/)
			}
		}

		const built = (await modules(create({ emit: false }), "build", ids)) as [unknown, string][]

		expect(built[0]?.[1]).toContain('"/assets/office-')
	})
})
