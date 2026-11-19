import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { buildDocxModel, openDocxPackage } from "@filen/office/core/docx"
import { DocxDocBuilder, conservativeProof, openDocxEditContext, proveBlocks, type LockReason } from "@filen/office/core/docx/edit"
import { bytesSource } from "@filen/office/core/opc"
import { CORPUS_DIR as CORPUS, corpusFiles } from "./corpusDir"
import { structureProblems } from "./docxEditFixtures"

// The licensed real-world corpus is kept out of the repository (pnpm run corpus:fetch); this sweep runs only where it exists.
const EXTENSIONS = ["docx", "docm", "dotx", "dotm"]

describe.skipIf(!existsSync(CORPUS))("docx editing documents over the real-world corpus", () => {
	it("builds a valid editing document for every body that matches its model", { timeout: 600_000 }, async () => {
		const failures: string[] = []
		const reasons: Partial<Record<LockReason | "unmodelled (proof)", number>> = {}
		const perFile: { name: string; blocks: number; locked: number; proofLocked: number; ms: number }[] = []
		let blocks = 0
		let locked = 0
		let proofLocked = 0
		let opened = 0

		for (const file of corpusFiles(EXTENSIONS)) {
			const name = file.slice(CORPUS.length + 1)

			try {
				const pkg = await openDocxPackage(bytesSource(new Uint8Array(readFileSync(file))))

				// Encrypted and otherwise refused packages: the model sweep reports them.
				if (!pkg.ok) continue

				const model = await buildDocxModel(pkg.package)
				const context = await openDocxEditContext(pkg.package, model)
				const body = model.body

				if (body === undefined) continue

				opened++

				const start = performance.now()
				const story = new DocxDocBuilder(context).build(body)
				const ms = performance.now() - start

				story.doc.check()
				story.doc.descendants(node => {
					const expected = Object.keys(node.type.spec.attrs ?? {}).join()

					if (Object.keys(node.attrs).join() !== expected)
						failures.push(`${name}: ${node.type.name} attrs ${Object.keys(node.attrs).join()}`)

					return true
				})

				const problems = structureProblems(story)

				if (problems.length > 0) failures.push(`${name}: ${problems.join("; ")}`)

				const fileBlocks = story.stats.paragraphs + story.stats.tables
				const requests = proveBlocks(story, story.doc, conservativeProof)

				blocks += fileBlocks
				locked += story.stats.lockedBlocks
				proofLocked += requests.length

				for (const [reason, count] of Object.entries(story.stats.lockReasons))
					reasons[reason as LockReason] = (reasons[reason as LockReason] ?? 0) + count

				reasons["unmodelled (proof)"] = (reasons["unmodelled (proof)"] ?? 0) + requests.length
				perFile.push({ name, blocks: fileBlocks, locked: story.stats.lockedBlocks, proofLocked: requests.length, ms })
			} catch (error) {
				failures.push(`${name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
			}
		}

		const lockedFiles = perFile
			.filter(file => file.locked + file.proofLocked > 0)
			.sort((a, b) => (b.locked + b.proofLocked) / b.blocks - (a.locked + a.proofLocked) / a.blocks)

		console.log(
			`edit docs: ${opened} files, ${blocks} blocks, structural locks ${locked} (${((100 * locked) / Math.max(1, blocks)).toFixed(2)} %), ` +
				`proof locks ${proofLocked} (${((100 * proofLocked) / Math.max(1, blocks)).toFixed(2)} %); files with locks ${lockedFiles.length}\n` +
				`reasons ${JSON.stringify(reasons)}\n` +
				lockedFiles
					.slice(0, 40)
					.map(
						file =>
							`  ${file.name}: ${file.locked}+${file.proofLocked}/${file.blocks} (${((100 * (file.locked + file.proofLocked)) / Math.max(1, file.blocks)).toFixed(1)} %)`
					)
					.join("\n") +
				`\nslowest builds: ${perFile
					.sort((a, b) => b.ms - a.ms)
					.slice(0, 5)
					.map(file => `${file.name} ${file.ms.toFixed(0)} ms`)
					.join(", ")}`
		)

		expect(failures).toEqual([])
		expect(opened).toBeGreaterThan(0)
	})
})
