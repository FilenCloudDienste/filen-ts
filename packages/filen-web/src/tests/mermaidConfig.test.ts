// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import type { MermaidConfig } from "mermaid"
import {
	MERMAID_CONFIG_KEYS,
	MERMAID_CONFIG_KEYS_COMPLETE,
	MERMAID_MAX_EDGES,
	MERMAID_MAX_TEXT,
	mermaidFrameConfig
} from "@/mermaidFrame/config"

// The diagram frame's configuration lock: every key mermaid defines is secure (a diagram's directives can set none of
// them), and the locked values are the safe ones. The key list is checked against mermaid's type at compile time and
// against its runtime defaults here.

// Mermaid's runtime configuration: only its internal API, which its types mark deprecated for rendering, reads it.
interface ConfigView {
	readonly defaultConfig: MermaidConfig
	getConfig(): MermaidConfig
}

async function loadMermaid(): Promise<{
	initialize: (config: MermaidConfig) => void
	render: (id: string, text: string) => Promise<unknown>
	config: ConfigView
}> {
	const { default: mermaid } = await import("mermaid")

	return {
		initialize: config => {
			mermaid.initialize(config)
		},
		render: (id, text) => mermaid.render(id, text),
		config: Reflect.get(mermaid, "mermaidAPI")
	}
}

describe("the diagram frame's configuration", () => {
	it("lists every key of mermaid's configuration", async () => {
		const mermaid = await loadMermaid()
		const listed = new Set<string>(MERMAID_CONFIG_KEYS)

		expect(MERMAID_CONFIG_KEYS_COMPLETE).toBe(true)
		expect(Object.keys(mermaid.config.defaultConfig).filter(key => !listed.has(key))).toEqual([])
		expect(listed.size).toBe(MERMAID_CONFIG_KEYS.length)
	})

	it("locks rendering down and secures every key", () => {
		for (const theme of ["default", "dark"] as const) {
			expect(mermaidFrameConfig(theme)).toEqual({
				startOnLoad: false,
				securityLevel: "strict",
				htmlLabels: false,
				deterministicIds: true,
				layout: "dagre",
				maxTextSize: MERMAID_MAX_TEXT,
				maxEdges: MERMAID_MAX_EDGES,
				suppressErrorRendering: true,
				theme,
				secure: [...MERMAID_CONFIG_KEYS]
			})
		}

		expect(MERMAID_MAX_TEXT).toBe(50_000)
		expect(MERMAID_MAX_EDGES).toBe(500)
	})

	it("keeps a directive from changing any setting", async () => {
		const mermaid = await loadMermaid()

		mermaid.initialize(mermaidFrameConfig("default"))
		// jsdom measures no text: the layout may fail after the directive was read.
		await mermaid
			.render(
				"lock",
				'%%{init: {"securityLevel": "loose", "htmlLabels": true, "themeCSS": "x{}", "maxEdges": 9999}}%%\ngraph TD; A-->B'
			)
			.catch(() => undefined)

		expect(mermaid.config.getConfig()).toMatchObject({ securityLevel: "strict", htmlLabels: false, maxEdges: MERMAID_MAX_EDGES })
		expect(mermaid.config.getConfig().themeCSS).toBeUndefined()
	})
})
