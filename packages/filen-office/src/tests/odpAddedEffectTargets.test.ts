import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { effectPreset } from "../core/anim/presets/effects/index"
import { insertPictureOp, insertTableOp } from "../core/presentation/edit/commands/insert"
import { addEffectsOp, slideEffects } from "../core/presentation/edit/commands/timing"
import type { SlideRef } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"
import { image } from "./presentationObjectsFixtures"

// An effect added in a session, saved and reopened, still names its shape: the timing markup is namespace-well-formed
// where the source binds anim: only on its own timing roots (a Google export), the target of an object inserted in the
// same session carries the id the effect names, and an id given to a shape is unique in the document.

const XMLNS = /\sxmlns:([\w.-]+)\s*=/gu
const TAG = /<(\/?)([A-Za-z_][\w.-]*(?::[\w.-]+)?)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/gu
const ATTRIBUTE = /\s+([^\s=]+)\s*=/gu

// The prefixes an element or attribute uses where no enclosing element declares them.
function unbound(xml: string): Set<string> {
	const out = new Set<string>()
	const stack: string[][] = []

	for (const match of xml.matchAll(TAG)) {
		if (match[1] === "/") {
			stack.pop()
			continue
		}

		const attributes = match[3] ?? ""
		const declares = [...attributes.matchAll(XMLNS)].map(each => each[1] ?? "")
		const used = [match[2] ?? "", ...[...attributes.matchAll(ATTRIBUTE)].map(each => each[1] ?? "")]
			.filter(name => name.includes(":") && !name.startsWith("xmlns:"))
			.map(name => name.slice(0, name.indexOf(":")))

		stack.push(declares)

		for (const prefix of used) if (prefix !== "xml" && !stack.some(level => level.includes(prefix))) out.add(prefix)

		if (match[4] === "/") stack.pop()
	}

	return out
}

function ids(xml: string): string[] {
	return [...xml.matchAll(/\s(?:xml:id|draw:id)="([^"]*)"/gu)].map(match => match[1] ?? "")
}

// Every id an element holds, once per element (a frame's xml:id and draw:id are written equal).
function elementIds(xml: string): string[] {
	return [...xml.matchAll(/<[^>]*\s(?:xml:id|draw:id)="([^"]*)"[^>]*>/gu)].map(match => match[1] ?? "")
}

function content(bytes: Uint8Array): string {
	return strFromU8(unzipSync(bytes, { filter: file => file.name === "content.xml" })["content.xml"] ?? new Uint8Array(0))
}

async function fadeAdded(
	name: string,
	variant: "newSlide" | "picture" | "table"
): Promise<{ readonly source: string; readonly saved: string; readonly targets: unknown }> {
	const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, "odp", name)))
	const d = await driveSession(bytes, "odp")

	await odpParts(d.session.deck)?.parseAll()

	const deck = d.session.deck
	let host = deck.slides[0] as SlideRef

	if (variant === "newSlide") {
		const before = new Set(deck.slides)
		const layout = deck.nodes.get(host)?.parent as SlideRef

		expect((await d.command({ family: "slide", kind: "add", at: deck.slides.length, layout })).ok).toBe(true)
		host = deck.slides.find(ref => !before.has(ref)) as SlideRef
	} else if (variant === "picture") expect((await d.command(insertPictureOp(deck, host, image(40, 30), 0, "fade.png"))).ok).toBe(true)
	else expect((await d.command(insertTableOp(deck, host, 2, 2, 0) as never)).ok).toBe(true)

	const shapes = deck.nodes.get(host)?.shapes ?? []
	const target = variant !== "newSlide" ? shapes[shapes.length - 1] : shapes[0]
	const effects = slideEffects(deck.nodes.get(host)?.timing)
	const op = addEffectsOp(host, effects.kind === "effects" ? effects.rows : [], [{ id: target?.id as number }], {
		preset: effectPreset("entr", 10) as never,
		aspect: 16 / 9
	})

	expect((await d.command(op as never)).ok).toBe(true)

	const out = await d.save()

	expect(out.result).toEqual(expect.objectContaining({ kind: "written" }))

	const again = await driveSession(out.bytes as Uint8Array, "odp")

	await odpParts(again.session.deck)?.parseAll()

	const index = deck.slides.indexOf(host)
	const reopened = again.session.deck.nodes.get(again.session.deck.slides[index] as SlideRef)
	const rows = slideEffects(reopened?.timing)
	const named = reopened?.shapes.find(shape => shape.name === target?.name)

	return {
		source: content(bytes),
		saved: content(out.bytes as Uint8Array),
		targets: { rows: rows.kind === "effects" ? rows.rows.map(row => row.shape) : rows.kind, shape: named?.id }
	}
}

const has = (name: string): boolean => existsSync(join(CORPUS_DIR, "odp", name))

describe("an effect added to an ODP deck in the session", () => {
	it.runIf(has("govuk__bbfa-11-business-lifecycle.odp"))(
		"on a new slide of a deck binding anim: per page: the saved timing is namespace-well-formed and reopens on its shape",
		{ timeout: 120_000 },
		async () => {
			const result = await fadeAdded("govuk__bbfa-11-business-lifecycle.odp", "newSlide")

			expect([...unbound(result.saved)]).toEqual([...unbound(result.source)])
			expect((result.targets as { rows: unknown[] }).rows).toContain((result.targets as { shape: number }).shape)
		}
	)

	for (const [name, kind] of [
		["lo__tdf90627.odp", "picture"],
		["lo__fdo71075.odp", "picture"],
		["lo__tdf90627.odp", "table"]
	] as const)
		it.runIf(has(name))(
			`on a ${kind} inserted in the same session of ${name}: the effect's target id is the frame's`,
			{ timeout: 120_000 },
			async () => {
				const result = await fadeAdded(name, kind)
				const defined = new Set(ids(result.saved))
				const targets = [...result.saved.matchAll(/smil:targetElement="([^"]*)"/gu)].map(match => match[1] ?? "")

				expect(targets.filter(target => !defined.has(target))).toEqual([])
				expect((result.targets as { rows: unknown[] }).rows).toContain((result.targets as { shape: number }).shape)
			}
		)

	for (const name of ["lo__tdf90627.odp", "lo__tdf66228.odp"])
		it.runIf(has(name))(
			`on a placeholder of a new slide of ${name}: the id it is given is unique in the document`,
			{ timeout: 120_000 },
			async () => {
				const result = await fadeAdded(name, "newSlide")
				const count = (list: readonly string[]) =>
					list.reduce((map, id) => map.set(id, (map.get(id) ?? 0) + 1), new Map<string, number>())
				const before = count(elementIds(result.source))
				const repeated = [...count(elementIds(result.saved))]
					.filter(([id, n]) => n > 1 && n > (before.get(id) ?? 0))
					.map(([id]) => id)

				expect(repeated).toEqual([])
				expect((result.targets as { rows: unknown[] }).rows).toContain((result.targets as { shape: number }).shape)
			}
		)
})
