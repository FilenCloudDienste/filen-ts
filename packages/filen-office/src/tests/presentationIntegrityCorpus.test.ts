import { existsSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"
import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { planDelete, planDuplicate, sectionsAfterMove } from "../core/presentation/edit/integrity"
import type { SlideRef } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { CORPUS_DIR } from "./corpusDir"
import { readCorpusList } from "./oracles/presentation/corpus"
import { editHarness } from "./presentationEditFixtures"

// The reference graph on the corpus decks that have sections, custom shows or slide jumps: deleting, duplicating and
// moving a slide gives the change lists the package itself implies, read here from the raw parts with no help from
// the reader or the graph (relationships, p14:sectionLst, p:custShowLst, hlink r:ids).

const OOXML = /\.(?:pptx|pptm|potx|potm|ppsx|ppsm)$/iu
const MANIFEST = join(import.meta.dirname, "..", "..", "corpus", "manifest.json")
const files = existsSync(CORPUS_DIR) && existsSync(MANIFEST) ? readCorpusList(MANIFEST).filter(entry => OOXML.test(entry.path)) : []
const OWNED = new Set([
	"notesSlide",
	"comments",
	"chart",
	"chartStyle",
	"chartColorStyle",
	"package",
	"oleObject",
	"diagramData",
	"diagramLayout",
	"diagramQuickStyle",
	"diagramColors",
	"diagramDrawing",
	"tags",
	"vmlDrawing",
	"customXml",
	"ink"
])
const decoder = new TextDecoder()

interface Rel {
	readonly id: string
	readonly kind: string
	readonly part: string | undefined
}

class RawDeck {
	readonly files: Record<string, Uint8Array>

	constructor(bytes: Uint8Array) {
		this.files = unzipSync(bytes)
	}

	text(name: string): string {
		const key = Object.keys(this.files).find(file => file.toLowerCase() === name.toLowerCase())

		return key === undefined ? "" : decoder.decode(this.files[key])
	}

	rels(part: string): Rel[] {
		const dir = posix.dirname(part)
		const xml = this.text(`${dir}/_rels/${posix.basename(part)}.rels`)
		const out: Rel[] = []

		for (const match of xml.matchAll(/<Relationship\b[^>]*>/gu)) {
			const tag = match[0]
			const id = /\bId="([^"]*)"/u.exec(tag)?.[1] ?? ""
			const target = /\bTarget="([^"]*)"/u.exec(tag)?.[1] ?? ""
			const type = /\bType="([^"]*)"/u.exec(tag)?.[1] ?? ""
			const external = /\bTargetMode="External"/u.test(tag)
			const resolved = external
				? undefined
				: target.startsWith("/")
					? target.slice(1)
					: posix.normalize(posix.join(dir, decodeURI(target)))

			out.push({ id, kind: type.slice(type.lastIndexOf("/") + 1), part: resolved })
		}

		return out
	}

	// Owned parts of a slide, depth first (the package's own relationships).
	owned(part: string): string[] {
		const out: string[] = []
		const seen = new Set([part])
		const walk = (from: string, depth: number): void => {
			for (const rel of this.rels(from)) {
				if (rel.part === undefined || seen.has(rel.part) || !OWNED.has(rel.kind)) continue

				seen.add(rel.part)
				out.push(`/${rel.part}`)
				if (depth < 8) walk(rel.part, depth + 1)
			}
		}

		walk(part, 0)

		return out
	}

	// hlink elements in other slides naming a relationship to `target`.
	jumpsTo(target: string, slides: readonly string[]): number {
		let count = 0

		for (const part of slides) {
			if (part === target) continue

			const ids = this.rels(part)
				.filter(rel => rel.kind === "slide" && rel.part === target)
				.map(rel => rel.id)

			if (ids.length === 0) continue

			const xml = this.text(part)

			for (const match of xml.matchAll(/<a:(?:hlinkClick|hlinkHover|hlinkMouseOver)\b[^>]*>/gu)) {
				const id = /\br:id="([^"]*)"/u.exec(match[0])?.[1]

				if (id !== undefined && ids.includes(id)) count++
			}
		}

		return count
	}
}

function interesting(raw: RawDeck): boolean {
	const presentation = raw.text("ppt/presentation.xml")

	return (
		/<p14:sectionLst/u.test(presentation) ||
		/<p:custShow\b/u.test(presentation) ||
		Object.keys(raw.files).some(name => /^ppt\/slides\/_rels\//u.test(name) && raw.text(name).includes('/relationships/slide"'))
	)
}

describe.skipIf(files.length === 0)("reference graph over the corpus", () => {
	it("delete, duplicate and reorder of slides in decks with sections, custom shows and slide jumps give the package's change lists", async ({
		task
	}) => {
		const checked = { decks: 0, deletes: 0, duplicates: 0, moves: 0, jumps: 0, sections: 0, customShows: 0 }

		for (const entry of files) {
			const path = join(CORPUS_DIR, entry.path)

			if (!existsSync(path)) continue

			const bytes = new Uint8Array(readFileSync(path))
			let raw: RawDeck

			try {
				raw = new RawDeck(bytes)
			} catch {
				continue
			}

			if (!interesting(raw)) continue

			let harness

			try {
				harness = await editHarness(bytes)
			} catch {
				continue
			}

			const deck = harness.session.deck
			const parts = pptxParts(deck)

			if (parts === undefined || deck.gate.length > 0 || deck.slides.length < 2) {
				harness.close()
				continue
			}

			checked.decks++

			const slideParts = deck.slides.map(ref => (parts.partOf(ref) ?? "").slice(1))
			// The slide most others refer to: a jump target when there is one, else one in a custom show, else the second.
			const target =
				deck.slides.find((_ref, index) => raw.jumpsTo(slideParts[index] ?? "", slideParts) > 0) ??
				deck.customShows[0]?.slides[0] ??
				(deck.slides[1] as SlideRef)
			const index = deck.slides.indexOf(target)
			const part = slideParts[index] ?? ""

			// Duplicate: the copy gets its own copies of exactly the owned parts, shares the rest.
			await harness.slide(index)
			await harness.command({ family: "slide", kind: "duplicate", slide: target })

			const facts = {
				references: (name: string) =>
					raw.rels(name.slice(1)).flatMap(rel => (rel.part === undefined ? [] : [{ kind: rel.kind, part: `/${rel.part}` }])),
				parts: () =>
					Object.keys(raw.files)
						.filter(name => name.endsWith(".xml"))
						.map(name => `/${name}`)
			}
			const partOf = (ref: SlideRef): string | undefined => parts.partOf(ref) ?? deck.nodes.get(ref)?.part

			expect(planDuplicate(deck, target, facts, partOf)?.copy, entry.path).toEqual(raw.owned(part))
			checked.duplicates++
			await harness.undo()

			// Delete: out of its sections and custom shows, every jump to it rewritten, its part and its notes removed.
			const expectedSections = deck.sections.map(section => section.slides.filter(ref => ref !== target))
			const expectedShows = deck.customShows.map(show => show.slides.filter(ref => ref !== target))
			const jumps = raw.jumpsTo(part, slideParts)
			const plan = planDelete(deck, [target], facts, partOf)

			expect(plan.remove.filter(name => name === `/${part}` || raw.owned(part).includes(name)).sort(), entry.path).toEqual(
				[`/${part}`, ...raw.owned(part)].filter(name => !raw.owned(part).includes(name) || !othersRefer(raw, name, part)).sort()
			)

			const result = await harness.command({ family: "slide", kind: "delete", slides: [target] })

			expect(result.ok, entry.path).toBe(true)
			expect(
				deck.sections.map(section => section.slides),
				entry.path
			).toEqual(expectedSections)
			expect(
				deck.customShows.map(show => show.slides),
				entry.path
			).toEqual(expectedShows)

			const rewritten = sessionEdits(harness.session)
				.history.peekUndo()
				?.inverse.ops.find(op => op.family === "slide" && op.kind === "restore")
			const held =
				rewritten?.family === "slide" && rewritten.kind === "restore"
					? (rewritten.slides[0] as { jumps?: readonly unknown[] })
					: undefined

			expect(held?.jumps?.length ?? 0, entry.path).toBe(jumps)
			checked.jumps += jumps
			checked.sections += deck.sections.length > 0 ? 1 : 0
			checked.customShows += deck.customShows.length > 0 ? 1 : 0

			const removed = [...sessionEdits(harness.session).changes().parts]
				.filter(([, change]) => change.change === "removed")
				.map(([name]) => name)

			expect(removed, entry.path).toContain(`/${part}`)
			checked.deletes++
			await harness.undo()
			expect(sessionEdits(harness.session).history.dirty, entry.path).toBe(false)

			// Move to the end: every section stays one run of slides, each slide in exactly one section.
			const moved = sectionsAfterMove(deck.sections, [...deck.slides.filter(ref => ref !== target), target], new Set([target]))
			const order = [...deck.slides.filter(ref => ref !== target), target]

			if (moved !== undefined) {
				expect(
					moved.flatMap(section => section.slides),
					entry.path
				).toEqual(order)
				checked.moves++
			}

			harness.close()
		}

		Object.assign(task.meta, { plans: checked })
		expect(checked.decks).toBeGreaterThan(0)
		expect(checked.jumps).toBeGreaterThan(0)
		expect(checked.sections).toBeGreaterThan(0)
	}, 900_000)
})

// Whether a part other than `owner` (and its own owned parts) refers to `name`.
function othersRefer(raw: RawDeck, name: string, owner: string): boolean {
	const own = new Set([owner, ...raw.owned(owner).map(part => part.slice(1))])

	return Object.keys(raw.files)
		.filter(file => file.endsWith(".xml") && !own.has(file))
		.some(file => raw.rels(file).some(rel => rel.part !== undefined && `/${rel.part}` === name))
}
