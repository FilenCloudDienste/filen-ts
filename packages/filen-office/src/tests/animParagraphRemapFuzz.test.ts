import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { effectPreset } from "../core/anim/presets/effects/index"
import { cloneModel } from "../core/presentation/edit/changes"
import { addEffectsOp, slideEffects } from "../core/presentation/edit/commands/timing"
import type { Paragraph, ShapeNode, SlideNode, TextBody } from "../core/presentation/model"
import { viewCapability } from "../dom/presentation/engine/view"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// Random text edits on a body animated by paragraph, with saves, undos and redos between them (both formats): every
// paragraph that is left keeps its effect, none gets two, every saved file names only paragraphs it has, the reopened
// file animates the paragraphs the session does, and undoing everything brings the first effects back. Inserted
// paragraphs sometimes carry another paragraph's source ref (a body built off the editor's path).

const COUNT = 5
const LABELS = Array.from({ length: COUNT }, (_, index) => `P${String(index)}`)
const SEEDS = 60
const STEPS = 14

function pptxDeck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title 1", 'type="title"', xfrm(457200, 274638, 8229600, 1143000), body(para("T"))) +
					sp(3, "Body 2", 'idx="1"', xfrm(457200, 1600200, 8229600, 4525963), body(LABELS.map(label => para(label)).join("")))
			}
		]
	})
}

function odpDeck(): Uint8Array {
	return odpBytes({
		body:
			'<draw:page draw:name="a" draw:master-page-name="M"><draw:frame draw:name="Body" presentation:class="outline" svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="9cm"><draw:text-box><text:list>' +
			LABELS.map(label => `<text:list-item><text:p>${label}</text:p></text:list-item>`).join("") +
			"</text:list></draw:text-box></draw:frame></draw:page>"
	})
}

// mulberry32.
function random(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = state

		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function labelOf(paragraph: Paragraph): string {
	return paragraph.runs.map(run => (run.kind === "br" ? "" : run.text)).join("")
}

function withText(paragraph: Paragraph, text: string, keepSource: boolean): Paragraph {
	const copy = cloneModel(paragraph)
	const first = copy.runs.find(run => run.kind === "r")

	copy.runs = first === undefined ? [] : [{ ...first, text }]

	if (!keepSource) delete copy.src

	return copy
}

type Session = Awaited<ReturnType<typeof driveSession>>

function slideOf(session: Session): SlideNode {
	const deck = session.session.deck
	const node = deck.nodes.get(deck.slides[0] ?? (0 as never))

	if (node === undefined) throw new Error("no slide")

	return node
}

function bodyOf(session: Session): ShapeNode {
	const shape = slideOf(session).shapes.find(candidate => candidate.name === "Body" || candidate.name === "Body 2")

	if (shape === undefined) throw new Error("no body")

	return shape
}

// The labels of the paragraphs the body's effects animate, and the targets past its text.
function animated(session: Session): { readonly labels: string[]; readonly past: number[] } {
	const shape = bodyOf(session)
	const rows = slideEffects(slideOf(session).timing)
	const paragraphs = shape.text?.paragraphs ?? []
	const labels: string[] = []
	const past: number[] = []

	if (rows.kind !== "effects") return { labels, past }

	for (const row of rows.rows) {
		if (row.shape !== shape.id || row.paragraph === undefined) continue

		const paragraph = paragraphs[row.paragraph]

		if (paragraph === undefined) past.push(row.paragraph)
		else labels.push(labelOf(paragraph))
	}

	return { labels, past }
}

// Targets a saved file names that it does not have.
function dangling(format: "odp" | "pptx", bytes: Uint8Array): string[] {
	const files = unzipSync(bytes)
	const out: string[] = []

	if (format === "odp") {
		const content = strFromU8(files["content.xml"] ?? new Uint8Array())
		const ids = new Set([...content.matchAll(/xml:id="([^"]*)"/gu)].map(match => match[1]))

		for (const match of content.matchAll(/smil:targetElement="([^"]*)"/gu)) if (!ids.has(match[1])) out.push(String(match[1]))

		return out
	}

	const xml = strFromU8(files["ppt/slides/slide1.xml"] ?? new Uint8Array())
	const shape = /<p:sp>(?:(?!<\/p:sp>).)*?<p:cNvPr id="3"(?:(?!<\/p:sp>).)*<\/p:sp>/su.exec(xml)?.[0] ?? ""
	const count = (shape.match(/<a:p[ >/]/gu) ?? []).length

	for (const match of xml.matchAll(/<p:spTgt spid="3"><p:txEl><p:pRg st="(\d+)" end="(\d+)"/gu))
		if (Number(match[2]) >= count) out.push(`${String(match[1])}-${String(match[2])} of ${String(count)}`)

	return out
}

async function opened(bytes: Uint8Array, format: "odp" | "pptx"): Promise<Session> {
	const session = await driveSession(bytes, format)

	await viewCapability.render(session.context, [session.session.deck.slides[0] ?? (0 as never)])

	return session
}

function current(session: Session): Uint8Array {
	const bytes = session.drive.files.get(session.drive.current)

	if (bytes === undefined) throw new Error("no file")

	return bytes
}

async function run(format: "odp" | "pptx", seed: number, copiedSources: boolean): Promise<void> {
	const next = random(seed)
	const session = await opened(format === "odp" ? odpDeck() : pptxDeck(), format)
	const slide = slideOf(session)
	const shape = bodyOf(session)
	const preset = effectPreset("entr", 10)
	const op =
		preset === undefined
			? undefined
			: addEffectsOp(slide.ref, [], [{ id: shape.id, paragraphs: COUNT }], { preset, byParagraph: true, aspect: 4 / 3 })

	if (op === undefined) throw new Error("no op")

	expect(await session.command(op)).toMatchObject({ ok: true })

	const alive = new Set(LABELS)
	const log: string[] = []
	let fresh = 0

	for (let step = 0; step < STEPS; step++) {
		const roll = next()
		const edited: TextBody = cloneModel(bodyOf(session).text ?? { bodyPr: {}, paragraphs: [] })
		const count = edited.paragraphs.length
		const at = Math.floor(next() * (count + 1))
		const near = edited.paragraphs[Math.min(at, count - 1)]

		if (roll < 0.3 && count > 1 && at < count && near !== undefined) {
			edited.paragraphs.splice(at, 1)
			alive.delete(labelOf(near))
			log.push(`del ${String(at)}`)
		} else if (roll < 0.6 && near !== undefined) {
			const label = `N${String(fresh++)}`

			edited.paragraphs.splice(at, 0, withText(near, label, copiedSources && next() < 0.5))
			log.push(`ins ${String(at)}`)
		} else if (roll < 0.75 && near !== undefined && at < count) {
			const old = labelOf(near)

			edited.paragraphs[at] = withText(near, `${old}x`, true)

			if (alive.delete(old)) alive.add(`${old}x`)

			log.push(`mod ${String(at)}`)
		} else if (roll < 0.85) {
			const saved = await session.save()

			log.push("save")
			expect(saved.result.kind, log.join(" | ")).not.toBe("refused")

			if (saved.result.kind === "written") expect(dangling(format, current(session)), log.join(" | ")).toEqual([])

			continue
		} else {
			const before = JSON.stringify(animated(session))

			await session.undo()
			await session.redo()
			log.push("undo/redo")
			expect(JSON.stringify(animated(session)), log.join(" | ")).toBe(before)

			continue
		}

		expect(
			await session.command({ family: "text", kind: "setText", target: { slide: slide.ref, id: shape.id }, body: edited }),
			log.join(" | ")
		).toMatchObject({ ok: true })

		const now = animated(session)

		expect(now.past, log.join(" | ")).toEqual([])

		for (const label of alive) expect(now.labels, `${label}: ${log.join(" | ")}`).toContain(label)

		expect(new Set(now.labels).size, log.join(" | ")).toBe(now.labels.length)
	}

	const saved = await session.save()

	expect(saved.result.kind, log.join(" | ")).not.toBe("refused")
	expect(dangling(format, current(session)), log.join(" | ")).toEqual([])

	const reopened = await opened(current(session), format)

	expect(animated(reopened).labels.sort(), log.join(" | ")).toEqual(animated(session).labels.sort())

	for (let k = 0; k < 400; k++) if (!(await session.undo()).ok) break

	await session.redo()
	expect(animated(session).labels.sort(), log.join(" | ")).toEqual([...LABELS].sort())

	const last = await session.save()

	expect(last.result.kind, log.join(" | ")).not.toBe("refused")
	if (last.result.kind === "written") expect(dangling(format, current(session)), log.join(" | ")).toEqual([])
}

describe("by-paragraph effects under random text edits, saves, undos and redos", () => {
	for (const format of ["pptx", "odp"] as const)
		for (const copiedSources of [false, true])
			it(`${format}${copiedSources ? ", inserted paragraphs sometimes naming another's source" : ""}: ${String(SEEDS)} sequences`, async () => {
				for (let seed = 1; seed <= SEEDS; seed++) await run(format, seed * 7919 + (copiedSources ? 1 : 0), copiedSources)
			}, 300_000)
})
