import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { presetToOdf } from "../core/anim/odf"
import { EFFECT_PRESETS, type EffectPreset } from "../core/anim/presets/effects/index"
import { addEffectsOp, slideEffects, type EffectRow, type EffectStart } from "../core/presentation/edit/commands/timing"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { SlideNode } from "../core/presentation/model"
import { EMIT, stepEnds } from "./animAuthoringFixtures"
import { convertWith, offices } from "./interop/soffice"
import { odpApplier, openOdpDeck, saveDeck, slideAt } from "./odpWriteFixtures"
import { odpBytes } from "./odpFixtures"
import { loadAllowlist, newSdkErrors, OpenXmlSdk, openXmlSdkMissing, sdkErrorCounts } from "./oracles/openXmlSdk"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { openDeck, saveEdits, slideNode } from "./pptxWriteFixtures"
import { editHarness } from "./presentationEditFixtures"

// Every effect preset with every subtype it offers, one per slide, authored through the timing ops into a pptx and an
// ODP and saved: each saved deck reads back the effects we wrote and plays the same at every step end. Opt-in oracles
// (each skipped when unset):
// - FILEN_OFFICE_OOXML_VALIDATOR (with FILEN_OFFICE_DOTNET): the saved pptx has no Open XML SDK error its source does not;
// - FILEN_OFFICE_ODFVALIDATOR=<odfvalidator jar>: the saved ODP has no conformance error (-1.3);
// - FILEN_OFFICE_SOFFICE naming a 7.5 install: LibreOffice reads back the presets, subtypes, starts and timings we
//   wrote (pptx through its import, ODP through its own round trip), for at least 98% of the slides, and every slide
//   it reads otherwise is one of the documented mapping gaps below.
// FILEN_OFFICE_ANIM_PRESETS_OUT: a directory the decks are written to (jing against the ODF 1.3 schema).

const OUT = process.env["FILEN_OFFICE_ANIM_PRESETS_OUT"] || undefined
const SDK_MISSING = openXmlSdkMissing()
const ODF_VALIDATOR = process.env["FILEN_OFFICE_ODFVALIDATOR"] ?? ""
const OFFICE = offices().find(office => office.version.startsWith("7.5."))
const STARTS: readonly EffectStart[] = ["click", "with", "after"]

interface Case {
	readonly preset: EffectPreset
	readonly subtype: number
	readonly start: EffectStart
	readonly byParagraph: boolean
	readonly shape: number
}

const CASES: readonly Case[] = EFFECT_PRESETS.flatMap(preset =>
	(preset.subtypes.length === 0 ? [0] : preset.subtypes).map((subtype, index) => {
		const text = preset.needs === "text" || index % 2 === 1

		return {
			preset,
			subtype,
			start: STARTS[(preset.id + index) % 3] ?? "click",
			byParagraph: text && preset.presetClass !== "path" && index % 4 === 1,
			shape: text ? 3 : 4
		}
	})
)

function label(c: Case): string {
	return `${c.preset.presetClass} ${String(c.preset.id)} ${c.preset.name} subtype ${String(c.subtype)}`
}

function pptxDeck(): Uint8Array {
	const slide = {
		shapes:
			sp(2, "Title 1", 'type="title"', xfrm(457200, 274638, 8229600, 1143000), body(para("Preset"))) +
			sp(3, "Body 2", 'idx="1"', xfrm(457200, 1600200, 8229600, 4525963), body(para("One") + para("Two"))) +
			sp(
				4,
				"Box 3",
				undefined,
				`${xfrm(6000000, 1000000, 1000000, 1000000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>`
			)
	}

	return buildPptx({ slides: CASES.map(() => slide) })
}

const ODP_PAGE = (index: number): string =>
	`<draw:page draw:name="p${String(index + 1)}" draw:master-page-name="M" presentation:presentation-page-layout-name="AL1T0">` +
	'<draw:frame draw:name="Title" presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>Preset</text:p></draw:text-box></draw:frame>' +
	'<draw:frame draw:name="Body" presentation:class="outline" svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="9cm"><draw:text-box><text:list><text:list-item><text:p>One</text:p></text:list-item><text:list-item><text:p>Two</text:p></text:list-item></text:list></draw:text-box></draw:frame>' +
	'<draw:custom-shape draw:name="Box" draw:style-name="gr1" svg:x="18cm" svg:y="15cm" svg:width="4cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle" draw:enhanced-path="M 0 0 L 21600 0 21600 21600 0 21600 Z N"/></draw:custom-shape>' +
	"</draw:page>"

function odpDeck(): Uint8Array {
	return odpBytes({
		automatic:
			'<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#4472c4" draw:stroke="solid" svg:stroke-color="#000000"/></style:style>',
		body: CASES.map((_, index) => ODP_PAGE(index)).join("")
	})
}

function rowsOf(slide: SlideNode): readonly EffectRow[] {
	const effects = slideEffects(slide.timing)

	if (effects.kind !== "effects") throw new Error(effects.detail)

	return effects.rows
}

// What a reader must give back of each effect: its preset, subtype, start and timing.
function written(rows: readonly EffectRow[]): unknown[] {
	return rows.map(row => [
		row.presetClass,
		row.presetID,
		row.presetSubtype ?? 0,
		row.start,
		row.step,
		row.delayMs,
		row.durationMs,
		row.paragraph ?? -1
	])
}

// The op that authors case `c` on `slide` (the box, or the body's text by paragraph).
function caseOp(c: Case, slide: SlideNode, aspect: number, paragraphs = c.byParagraph): DeckOp {
	const op = addEffectsOp(
		slide.ref,
		[],
		[{ id: shapeIdOf(slide, c.shape), paragraphs: paragraphs ? 2 : 0 }],
		{ preset: c.preset, subtype: c.subtype, byParagraph: paragraphs, aspect },
		c.start
	)

	if (op === undefined) throw new Error(label(c))

	return op
}

// The fixture's shapes by position (title, body, box): ODP readers give their own ids.
function shapeIdOf(slide: SlideNode, fixtureId: number): number {
	const shape = slide.shapes.filter(candidate => candidate.ph?.type !== "ftr" && candidate.ph?.type !== "sldNum")[fixtureId - 2]

	if (shape === undefined) throw new Error(`no shape ${String(fixtureId)}`)

	return shape.id
}

interface Authored {
	readonly bytes: Uint8Array
	// Per case: the effects as authored, their step ends.
	readonly rows: unknown[][]
	readonly ends: ReturnType<typeof stepEnds>[]
}

async function authoredPptx(): Promise<Authored> {
	const h = await editHarness(pptxDeck(), EMIT)
	const rows: unknown[][] = []
	const ends: ReturnType<typeof stepEnds>[] = []

	try {
		for (const [index, c] of CASES.entries()) {
			const slide = await h.slide(index)
			const result = await h.command(caseOp(c, slide, 4 / 3))

			if (!result.ok) throw new Error(`${label(c)}: ${JSON.stringify(result)}`)

			const after = await h.slide(index)

			rows.push(written(rowsOf(after)))
			ends.push(stepEnds(after))
		}

		return { bytes: await saveEdits(h, CASES.length), rows, ends }
	} finally {
		h.close()
	}
}

async function authoredOdp(): Promise<Authored> {
	const opened = await openOdpDeck(odpDeck())
	const apply = odpApplier(opened)
	const rows: unknown[][] = []
	const ends: ReturnType<typeof stepEnds>[] = []

	for (const [index, c] of CASES.entries()) {
		const slide = slideAt(opened, index)
		const refusal = apply(caseOp(c, slide, 28 / 21))

		if (refusal !== undefined) throw new Error(`${label(c)}: ${refusal.reason} ${refusal.detail ?? ""}`)

		rows.push(written(rowsOf(slide)))
		ends.push(stepEnds(slide))
	}

	const saved = await saveDeck(opened)

	if (saved.outcome.kind !== "written") throw new Error(JSON.stringify(saved.outcome))

	return { bytes: saved.bytes, rows, ends }
}

describe("every effect preset authored and saved", () => {
	let pptx: Authored
	let odp: Authored
	let scratch: string

	beforeAll(async () => {
		;[pptx, odp] = await Promise.all([authoredPptx(), authoredOdp()])

		if (OUT !== undefined) mkdirSync(OUT, { recursive: true })

		scratch = OUT ?? mkdtempSync(join(tmpdir(), "filen-office-anim-presets-"))
		writeFileSync(join(scratch, "presets.pptx"), pptx.bytes)
		writeFileSync(join(scratch, "presets.odp"), odp.bytes)
		writeFileSync(join(scratch, "presets-source.pptx"), pptxDeck())

		// What each slide's effects are, in LibreOffice's preset names, for a UNO read of the decks.
		if (OUT !== undefined)
			writeFileSync(
				join(OUT, "cases.json"),
				JSON.stringify(
					[pptx, odp].map(authored =>
						authored.rows.map(rows =>
							(rows as [EffectRow["presetClass"], number, number, EffectStart, number, number, number, number][]).map(
								([presetClass, id, subtype, start, , delay, duration]) => ({
									...presetToOdf(presetClass, id, subtype),
									start,
									delay,
									duration
								})
							)
						)
					)
				)
			)
	}, 120_000)

	afterAll(() => {
		if (OUT === undefined) rmSync(scratch, { recursive: true, force: true })
	})

	it("covers all 104 presets", () => {
		expect(new Set(CASES.map(c => `${c.preset.presetClass}:${String(c.preset.id)}`)).size).toBe(104)
	})

	it("reads every pptx slide back with the effects written and the same step ends", { timeout: 120_000 }, async () => {
		const reopened = await openDeck(pptx.bytes)

		for (const [index, c] of CASES.entries()) {
			const slide = slideNode(reopened, index)

			expect(written(rowsOf(slide)), label(c)).toEqual(pptx.rows[index])
			expect(stepEnds(slide), label(c)).toEqual(pptx.ends[index])
		}
	})

	it("reads every ODP slide back with the effects written and the same step ends", { timeout: 120_000 }, async () => {
		const reopened = await openOdpDeck(odp.bytes)

		for (const [index, c] of CASES.entries()) {
			const slide = slideAt(reopened, index)

			expect(written(rowsOf(slide)), label(c)).toEqual(odp.rows[index])
			expect(stepEnds(slide), label(c)).toEqual(odp.ends[index])
		}
	})

	it.skipIf(SDK_MISSING !== undefined)("adds no Open XML SDK error", { timeout: 300_000 }, async () => {
		const sdk = new OpenXmlSdk()

		try {
			const before = sdkErrorCounts(await sdk.validate(join(scratch, "presets-source.pptx")))
			const after = sdkErrorCounts(await sdk.validate(join(scratch, "presets.pptx")))

			expect(newSdkErrors(before, after, loadAllowlist())).toEqual([])
		} finally {
			await sdk.close()
		}
	})

	it.skipIf(ODF_VALIDATOR === "")("has no odfvalidator conformance error", { timeout: 300_000 }, () => {
		const run = spawnSync("java", ["-jar", ODF_VALIDATOR, "-1.3", join(scratch, "presets.odp")], {
			encoding: "utf8",
			maxBuffer: 1 << 26
		})
		const errors = `${run.stdout}\n${run.stderr}`.split("\n").filter(line => /(?:Error|Fatal):/u.test(line))

		expect(errors).toEqual([])
	})

	it.skipIf(OFFICE === undefined)("LibreOffice reads back the presets and timings written", { timeout: 900_000 }, async () => {
		const office = OFFICE as NonNullable<typeof OFFICE>
		const profile = process.env["FILEN_OFFICE_LO_PROFILE"] || join(scratch, "lo-profile")
		const out = join(scratch, "lo")
		const fromPptx = await convertWith(office, profile, "odp:impress8", [join(scratch, "presets.pptx")], join(out, "pptx"), 600_000)
		const fromOdp = await convertWith(office, profile, "odp:impress8", [join(scratch, "presets.odp")], join(out, "odp"), 600_000)

		expect(fromPptx.timedOut || fromOdp.timedOut).toBe(false)

		const misses: string[] = []

		for (const [format, authored] of [
			["pptx", pptx],
			["odp", odp]
		] as const) {
			const read = await openOdpDeck(new Uint8Array(readFileSync(join(out, format, "presets.odp"))))

			for (const [index, c] of CASES.entries()) {
				const got = written(rowsOf(slideAt(read, index)))

				if (JSON.stringify(got) !== JSON.stringify(authored.rows[index]))
					misses.push(`${format} ${label(c)}: ${JSON.stringify(got)} vs ${JSON.stringify(authored.rows[index])}`)
			}
		}

		if (OUT !== undefined) writeFileSync(join(OUT, "lo-misses.txt"), misses.join("\n"))

		expect(misses.length / (CASES.length * 2)).toBeLessThanOrEqual(0.02)
		expect(misses.filter(miss => !LIBREOFFICE_GAPS.some(gap => gap.test(miss)))).toEqual([])
	})
})

// LibreOffice 7.5 mapping gaps (measured): what it reads otherwise than the file says.
const LIBREOFFICE_GAPS: readonly RegExp[] = []
