import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { assertMathTree, ommlToMathTree } from "../core/math/index"
import { OpcPackage, bytesSource } from "../core/opc/index"
import { Namespaces, NodeKind } from "../core/xml/index"
import { CORPUS_DIR as CORPUS } from "./corpusDir"

// The licensed real-world corpus is kept out of the repository; this sweep runs only where it exists.
const EXTENSIONS = ["docx", "docm", "dotx", "dotm"]
const MATH_URIS = new Set(["http://schemas.openxmlformats.org/officeDocument/2006/math", "http://purl.oclc.org/ooxml/officeDocument/math"])

function corpusFiles(): string[] {
	const files: string[] = []

	for (const extension of EXTENSIONS) {
		const directory = join(CORPUS, extension)

		if (!existsSync(directory)) continue

		for (const name of readdirSync(directory).sort()) files.push(join(directory, name))
	}

	return files
}

describe.skipIf(!existsSync(CORPUS))("OMML over the real-world corpus", () => {
	it("converts every equation into a valid MathML tree", { timeout: 300_000 }, async () => {
		let found = 0
		let converted = 0
		let empty = 0
		const failures: string[] = []
		const documents = new Set<string>()

		for (const file of corpusFiles()) {
			const name = file.slice(CORPUS.length + 1)
			let opc: OpcPackage

			try {
				opc = await OpcPackage.open(bytesSource(new Uint8Array(readFileSync(file))))
			} catch {
				continue
			}

			for (const entry of opc.zip.entries) {
				if (!entry.name.startsWith("word/") || !entry.name.endsWith(".xml")) continue

				const bytes = await opc.read(entry.name)

				// Only parts that mention the math namespace's local names are parsed.
				if (!new TextDecoder().decode(bytes).includes(":oMath")) continue

				let document

				try {
					document = await opc.xml(entry.name)
				} catch {
					continue
				}

				const namespaces = new Namespaces(document, { lenient: true })

				for (let node = 0; node < document.count; node++) {
					if (document.kinds[node] !== NodeKind.Element) continue

					const local = document.localName(node)

					if (local !== "oMath" && local !== "oMathPara") continue
					if (!MATH_URIS.has(namespaces.elementUri(node) ?? "")) continue

					// An m:oMath inside an m:oMathPara is converted with its paragraph.
					const parent = document.parent(node)

					if (
						local === "oMath" &&
						document.localName(parent) === "oMathPara" &&
						MATH_URIS.has(namespaces.elementUri(parent) ?? "")
					) {
						continue
					}

					found++
					documents.add(name)

					try {
						const tree = ommlToMathTree(document, node, { namespaces })

						if (tree === undefined) {
							empty++
						} else {
							assertMathTree(tree)
							converted++
						}
					} catch (error) {
						failures.push(`${name} ${entry.name}#${node}: ${String(error)}`)
					}
				}
			}
		}

		console.log(
			`OMML corpus: ${found} equations in ${documents.size} documents; ${converted} converted, ${empty} empty, ${failures.length} failed`
		)

		expect(failures).toEqual([])
		// Fewer means lost coverage: the corpus holds 30 equations.
		expect(found).toBeGreaterThanOrEqual(28)
	})
})
