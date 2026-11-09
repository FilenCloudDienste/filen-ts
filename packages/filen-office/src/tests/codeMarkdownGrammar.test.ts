import { ensureSyntaxTree } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { describe, expect, it } from "vitest"
import { codeLanguageSupport } from "../dom/code/languages"

type Tree = NonNullable<ReturnType<typeof ensureSyntaxTree>>

function parse(doc: string): Tree {
	const state = EditorState.create({ doc, extensions: [codeLanguageSupport("markdown")] })
	const tree = ensureSyntaxTree(state, doc.length, 5000)

	if (tree === null) {
		throw new Error("markdown parse did not finish")
	}

	return tree
}

function nodeNames(doc: string): Set<string> {
	const names = new Set<string>()

	parse(doc).iterate({
		enter: node => {
			names.add(node.name)
		}
	})

	return names
}

// Names from the innermost node at the first occurrence of needle up to the root, entering nested overlays the
// way highlighting does.
function namesAt(doc: string, needle: string): string[] {
	const names: string[] = []

	for (
		let node: ReturnType<Tree["resolveInner"]> | null = parse(doc).resolveInner(doc.indexOf(needle), 1);
		node !== null;
		node = node.parent
	) {
		names.push(node.name)
	}

	return names
}

describe("markdown source grammar", () => {
	it("parses GFM tables, strikethrough and task lists", () => {
		const names = nodeNames("| a | b |\n| - | - |\n| 1 | 2 |\n\n~~gone~~\n\n- [x] done\n")

		expect(names.has("Table")).toBe(true)
		expect(names.has("Strikethrough")).toBe(true)
		expect(names.has("Task")).toBe(true)
	})

	it("nests the fence's language inside fenced code, by id or extension", () => {
		const doc = "```ts\nconst x: number = 1\n```\n\n```Python extra\ndef f():\n    pass\n```\n"

		expect(namesAt(doc, "number")).toContain("TypeAnnotation")
		expect(namesAt(doc, "def")).toContain("FunctionDefinition")
	})

	it("leaves unknown and markdown fences as plain code text", () => {
		const doc = "```nope\nconst x = 1\n```\n\n```markdown\n# h\n```\n"

		expect(namesAt(doc, "const")[0]).toBe("CodeText")
		expect(namesAt(doc, "# h")[0]).toBe("CodeText")
	})
})
