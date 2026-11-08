import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { TextSelection } from "prosemirror-state"
import { bytesSource } from "@filen/office/core/opc"
import { NumberingCounters, PropsStore, parseNumbering, parseStyles } from "../core/docx/index"
import { splitParagraph } from "../core/docx/paged/index"
import { openOdtAsDocx } from "../core/odt/index"
import { writeOdt } from "../core/odt/write/writer"
import { odtBytes } from "./odtFixtures"
import { editOdt, odtEditsOf, type OdtEditing } from "./odtWriteFixtures"

// List labels of saved ODT files against LibreOffice 7.5's: each list edit is saved, and the labels LibreOffice's
// text export shows for the save must be those our reading of it shows (which the writer's proof holds to the edit).
// Opt-in through FILEN_OFFICE_SOFFICE (a 7.5 install's soffice); LibreOffice converts copies in a profile of its own.

const SOFFICE = (process.env["FILEN_OFFICE_SOFFICE"] ?? "").split(",").find(path => path !== "" && existsSync(path))

const STYLES =
	'<style:default-style style:family="paragraph"><style:text-properties fo:font-size="12pt"/></style:default-style><style:style style:name="Standard" style:family="paragraph"/>'
const LEVEL = (indent: number): string =>
	`<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.635cm" fo:margin-left="${indent}cm"/></style:list-level-properties>`
const NUMBERED =
	'<text:list-style style:name="L1">' +
	`<text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix=".">${LEVEL(1.27)}</text:list-level-style-number>` +
	`<text:list-level-style-number text:level="2" style:num-format="a" style:num-suffix=")">${LEVEL(2.54)}</text:list-level-style-number>` +
	"</text:list-style>"
const item = (text: string, attributes = ""): string => `<text:list-item${attributes}><text:p>${text}</text:p></text:list-item>`
const FOUR = `<text:list text:style-name="L1">${["one", "two", "three", "four"].map(text => item(text)).join("")}</text:list>`

function paragraphAt(e: OdtEditing, index: number): number {
	let found = -1
	let k = 0

	e.session.state.doc.descendants((node, pos) => {
		if (found >= 0) return false
		if (node.type.name === "paragraph") {
			if (k++ === index) found = pos

			return false
		}

		return true
	})

	if (found < 0) throw new Error(`no paragraph ${index}`)

	return found
}

function caret(e: OdtEditing, index: number, offset: number): void {
	const at = paragraphAt(e, index) + 1 + offset

	e.session.dispatch(e.session.state.tr.setSelection(TextSelection.create(e.session.state.doc, at)))
}

interface Scenario {
	readonly name: string
	readonly body: string
	readonly edit: (e: OdtEditing) => Promise<void>
}

const SCENARIOS: readonly Scenario[] = [
	{
		name: "bullet-middle",
		body: FOUR,
		edit: async e => {
			caret(e, 1, 1)
			await e.editor.execute({ type: "list.bullet" })
		}
	},
	{
		name: "unnumber-middle",
		body: FOUR,
		edit: async e => {
			caret(e, 1, 1)
			await e.editor.execute({ type: "list.numbered" })
		}
	},
	{
		name: "number-between-lists",
		body: `<text:list text:style-name="L1">${item("one")}</text:list><text:p>plain</text:p><text:list text:style-name="L1" text:continue-numbering="true">${item("two")}</text:list>`,
		edit: async e => {
			caret(e, 1, 2)
			await e.editor.execute({ type: "list.numbered" })
		}
	},
	{
		name: "indent-middle",
		body: FOUR,
		edit: async e => {
			caret(e, 2, 1)
			await e.editor.execute({ type: "list.indent" })
		}
	},
	{
		name: "enter-in-started-item",
		body: `<text:list text:style-name="L1">${item("one")}${item("seven", ' text:start-value="7"')}${item("eight")}</text:list>`,
		edit: async e => {
			caret(e, 1, 3)

			const split = splitParagraph(e.session.state, e.session.formats)

			if (split === null) throw new Error("no split")

			e.session.dispatch(split)
		}
	},
	{
		name: "delete-middle",
		body: FOUR,
		edit: async e => {
			const from = paragraphAt(e, 1)
			const to = paragraphAt(e, 2)

			e.session.dispatch(e.session.state.tr.delete(from, to))
		}
	}
]

// Labels as our reading of an ODT shows them: each paragraph's text with its list label (empty where unnumbered).
async function ourLabels(bytes: Uint8Array): Promise<string[]> {
	const opened = await openOdtAsDocx(bytesSource(bytes))

	if (!opened.ok) throw new Error(opened.message)

	const pkg = opened.package
	const store = new PropsStore()
	const part = async (kind: string) => {
		const name = pkg.part(kind)

		return name === undefined ? undefined : pkg.xml(name)
	}
	const stylesXml = await part("styles")
	const styles = stylesXml === undefined ? undefined : parseStyles(stylesXml, store)
	const numberingXml = await part("numbering")
	const numbering = numberingXml === undefined ? undefined : parseNumbering(numberingXml, store, styles)
	const counters = numbering === undefined ? undefined : new NumberingCounters(numbering)
	const body = await pkg.xml(pkg.part("document") ?? "word/document.xml")
	const out: string[] = []
	const walk = (node: number): void => {
		for (let child = body.firstChildElement(node); child >= 0; child = body.nextSiblingElement(child)) {
			if (body.localName(child) !== "p") {
				walk(child)

				continue
			}

			const markup = new TextDecoder().decode(body.raw(child))
			const numId = /<w:numId w:val="(\d+)"/u.exec(markup)?.[1]
			const ilvl = Number(/<w:ilvl w:val="(\d+)"/u.exec(markup)?.[1] ?? "0")
			const marker = numId === undefined || counters === undefined ? undefined : counters.next(Number(numId), ilvl)
			const text = [...markup.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/gu)].map(match => match[1]).join("")

			// A Symbol-font bullet (U+F0B7) LibreOffice's text export writes as the character it shows (U+2022).
			const label = marker?.text.replace(/\uf0b7/gu, "\u2022")

			if (text !== "") out.push(`${label === undefined ? "" : `${" ".repeat(4 * (ilvl + 1))}${label} `}${text}`)
		}
	}

	walk(body.documentElement())

	return out
}

describe.skipIf(SOFFICE === undefined)("ODT list labels against LibreOffice 7.5", () => {
	it("every list edit's save shows LibreOffice the labels it shows us", { timeout: 600_000 }, async () => {
		const work = mkdtempSync(join(tmpdir(), "filen-odt-labels-"))
		const report: { name: string; ours: string[]; theirs: string[] }[] = []
		const refused: string[] = []

		try {
			for (const scenario of SCENARIOS) {
				const e = await editOdt(odtBytes({ styles: STYLES, automatic: NUMBERED, body: scenario.body }))

				await scenario.edit(e)

				try {
					writeFileSync(join(work, `${scenario.name}.odt`), (await writeOdt(e.source, await odtEditsOf(e))).bytes)
				} catch (error) {
					refused.push(`${scenario.name}: ${String(error)}`)
				}
			}

			const converted = spawnSync(
				SOFFICE as string,
				[
					`-env:UserInstallation=file://${join(work, "profile")}`,
					"--headless",
					"--norestore",
					"--convert-to",
					"txt:Text (encoded):UTF8",
					"--outdir",
					join(work, "txt"),
					...SCENARIOS.map(scenario => join(work, `${scenario.name}.odt`)).filter(path => existsSync(path))
				],
				{ env: { ...process.env, SAL_ENABLE_FILE_LOCKING: "0" }, timeout: 300_000 }
			)

			expect(converted.status).toBe(0)

			for (const scenario of SCENARIOS) {
				if (!existsSync(join(work, `${scenario.name}.odt`))) continue

				const theirs = readFileSync(join(work, "txt", `${scenario.name}.txt`), "utf8")
					.replace(/^\ufeff/u, "")
					.split(/\r?\n/u)
					.filter(line => line.trim() !== "")
				const ours = await ourLabels(new Uint8Array(readFileSync(join(work, `${scenario.name}.odt`))))

				report.push({ name: scenario.name, ours, theirs })
			}
		} finally {
			rmSync(work, { recursive: true, force: true })
		}

		expect(refused).toEqual([])
		expect(report.filter(row => JSON.stringify(row.ours) !== JSON.stringify(row.theirs))).toEqual([])
	})
})
