import { describe, expect, it } from "vitest"
import { mermaidSourceVerdict } from "@/features/preview/lib/mermaidSource.logic"
import { MERMAID_MAX_EDGES, MERMAID_MAX_TEXT } from "@/mermaidFrame/config"

// The page's filter in front of the diagram frame: no directive or front-matter configuration reaches it, and a
// diagram naming images, icons, links or callbacks is refused rather than drawn half.

function rendered(text: string): string {
	const verdict = mermaidSourceVerdict(text)

	if (verdict.kind !== "render") {
		throw new Error(`expected a render, got ${verdict.kind}`)
	}

	return verdict.source
}

describe("mermaidSourceVerdict", () => {
	it("passes a plain diagram through", () => {
		expect(rendered("graph TD; A-->B")).toBe("graph TD; A-->B")
	})

	it("strips init directives, closed, across lines and unclosed", () => {
		expect(rendered('%%{init: {"theme": "dark", "themeCSS": "x{fill:red}"}}%%\ngraph TD; A-->B')).toBe("\ngraph TD; A-->B")
		expect(rendered('graph TD; A-->B\n%%{\n  init: {"htmlLabels": true}\n}%%\nB-->C')).toBe("graph TD; A-->B\n\nB-->C")
		expect(rendered('graph TD; A-->B\n%%{init: {"securityLevel": "loose"')).toBe("graph TD; A-->B\n")
		expect(rendered("graph TD; A-->B\n%% a comment")).toBe("graph TD; A-->B\n%% a comment")
	})

	it("drops front matter, keeping only a plain title", () => {
		const front = "---\ntitle: Flow\nconfig:\n  theme: forest\n  themeCSS: 'x{}'\n---\ngraph TD; A-->B"

		expect(rendered(front)).toBe("---\ntitle: Flow\n---\ngraph TD; A-->B")
		expect(rendered("---\nconfig:\n  htmlLabels: true\n---\ngraph TD; A-->B")).toBe("graph TD; A-->B")
		expect(rendered("---\ntitle: {a: b}\n---\npie")).toBe("pie")
	})

	it.each([
		['flowchart TD\n  A@{ img: "https://cdn.filen.io/x.png", label: "x" }'],
		['flowchart TD\n  A@{ icon: "fa:user", form: "square" }'],
		["mindmap\n  root\n    A::icon(fa fa-book)"],
		['graph TD; A-->B\n  click A "https://example.com"'],
		["graph TD; A-->B\n  click A callback"],
		['graph TD; A-->B\n  click A href "https://example.com"'],
		["sequenceDiagram\n  participant A\n  link A: Docs @ https://example.com"],
		['sequenceDiagram\n  participant A\n  links A: {"Docs": "https://example.com"}'],
		['C4Context\n  Person(a, "A", $link="https://example.com")'],
		["graph TD; A-->B\n  style A fill:url(https://example.com/a.png)"],
		["graph TD; A-->B\n  classDef x stroke:url( #g )"],
		["graph TD; A-->B\n  %% @import"]
	])("refuses a diagram that loads or links: %s", text => {
		expect(mermaidSourceVerdict(text)).toEqual({ kind: "refused" })
	})

	it("judges what is left once directives are gone", () => {
		expect(mermaidSourceVerdict('%%{init: {"themeCSS": "a{background:url(https://x.y/a.png)}"}}%%\npie\n  "a": 1')).toEqual({
			kind: "render",
			source: '\npie\n  "a": 1'
		})
	})

	it("caps the source at the frame's text size", () => {
		const big = `graph TD;${" ".repeat(MERMAID_MAX_TEXT)}`

		expect(mermaidSourceVerdict(big)).toEqual({ kind: "tooComplex" })
		expect(mermaidSourceVerdict("a".repeat(MERMAID_MAX_TEXT)).kind).toBe("render")
	})

	it("caps every diagram type's edges, not only a flowchart's", () => {
		const lines = (count: number, line: (index: number) => string): string =>
			Array.from({ length: count }, (_, index) => line(index)).join("\n")

		for (const [type, edge] of [
			["flowchart TD", (index: number) => `  n${String(index)} --> n${String(index + 1)}`],
			["stateDiagram-v2", (index: number) => `  s${String(index)} --> s${String(index + 1)}`],
			["classDiagram", (index: number) => `  C${String(index)} <|-- C${String(index + 1)}`],
			["erDiagram", (index: number) => `  E${String(index)} ||--o{ E${String(index + 1)} : has`],
			["sequenceDiagram", (index: number) => `  A${String(index)} ->> B : hi`],
			["gitGraph", () => "  commit"]
		] as const) {
			expect(mermaidSourceVerdict(`${type}\n${lines(MERMAID_MAX_EDGES, edge)}`).kind, type).toBe("render")
			expect(mermaidSourceVerdict(`${type}\n${lines(MERMAID_MAX_EDGES + 1, edge)}`), type).toEqual({ kind: "tooComplex" })
		}
	})

	it("judges a run of blank lines in linear time", () => {
		const started = performance.now()

		expect(mermaidSourceVerdict(`graph TD\n${"\n".repeat(49_000)}A --> B`).kind).toBe("render")
		expect(performance.now() - started).toBeLessThan(200)
	})
})
