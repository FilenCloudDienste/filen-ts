import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Transition } from "../core/anim/model"
import {
	durationOf,
	odfPageTransition,
	presetTransition,
	TRANSITION_PRESETS,
	writtenOptions
} from "../core/anim/presets/transitions/catalog"
import { emitPptx } from "../core/pptx/write/emit"
import type { DeckOp } from "../core/presentation/edit/ops"
import { convertWith, offices } from "./interop/soffice"
import { odpBytes } from "./odpFixtures"
import { odpApplier, openOdpDeck, saveDeck, slideAt } from "./odpWriteFixtures"
import { loadAllowlist, newSdkErrors, OpenXmlSdk, openXmlSdkMissing, sdkErrorCounts } from "./oracles/openXmlSdk"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { openDeck, saveEdits, slideNode } from "./pptxWriteFixtures"
import { editHarness } from "./presentationEditFixtures"

// Every transition of the catalog, twice (its defaults, and every option at its last value with an advance time),
// authored through the transition op into a pptx and an ODP and saved: each saved deck reads back the transitions
// written. Opt-in oracles (each skipped when unset):
// - FILEN_OFFICE_OOXML_VALIDATOR (with FILEN_OFFICE_DOTNET): the saved pptx has no Open XML SDK error its source has not;
// - FILEN_OFFICE_ODFVALIDATOR=<odfvalidator jar>: the saved ODP has no conformance error (-1.3);
// - FILEN_OFFICE_SOFFICE naming a 7.5 install: LibreOffice reads every transition with an ODF equivalent as the SMIL
//   type, subtype and direction we map it to (pptx through its import, ODP through its own round trip), except the
//   documented gaps of its pptx import below.
// FILEN_OFFICE_TRANSITIONS_OUT: a directory the decks are written to (jing against the ODF 1.3 schema).

const OUT = process.env["FILEN_OFFICE_TRANSITIONS_OUT"] || undefined
const SDK_MISSING = openXmlSdkMissing()
const ODF_VALIDATOR = process.env["FILEN_OFFICE_ODFVALIDATOR"] ?? ""
const OFFICE = offices().find(office => office.version.startsWith("7.5."))

const CASES: readonly Transition[] = TRANSITION_PRESETS.flatMap(entry => {
	const options: Record<string, string | boolean> = {}

	for (const spec of entry.options) options[spec.name] = spec.kind === "boolean" ? true : (spec.values[spec.values.length - 1] ?? "")

	const plain = presetTransition(entry)

	return [plain, { ...plain, options, durationMs: 1300, advance: { onClick: true, afterMs: 2500 } }]
})

function label(transition: Transition): string {
	return `${transition.namespace}:${transition.kind} ${JSON.stringify(writtenOptions(transition))}`
}

const TITLE = (index: number): string => sp(2, "Title 1", 'type="title"', "", body(para(`Slide ${String(index + 1)}`)))

function pptxDeck(): Uint8Array {
	return buildPptx({ slides: CASES.map((_, index) => ({ shapes: TITLE(index) })) })
}

function odpDeck(): Uint8Array {
	return odpBytes({
		body: CASES.map(
			(_, index) =>
				`<draw:page draw:name="p${String(index + 1)}" draw:master-page-name="M" presentation:presentation-page-layout-name="AL1T0">` +
				`<draw:frame draw:name="Title" presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>Slide ${String(index + 1)}</text:p></draw:text-box></draw:frame>` +
				"</draw:page>"
		).join("")
	})
}

const set = (slide: Parameters<typeof slideAt>[0]["deck"]["slides"][number], transition: Transition): DeckOp => ({
	family: "transition",
	kind: "set",
	slides: [slide],
	transition
})

// What a reader gives back of a transition: its kind, written options, duration and advance.
function written(transition: Transition | undefined): unknown {
	return transition === undefined
		? undefined
		: [transition.namespace, transition.kind, writtenOptions(transition), durationOf(transition), transition.advance]
}

// The SMIL transition of an ODP page as read (type, subtype, direction), "" for a subtype of "default" or none.
function smilOf(transition: Transition | undefined): string {
	const type = transition?.options["smilType"]

	if (transition === undefined || typeof type !== "string") return "none"

	const subtype = transition.options["smilSubtype"]
	// No subtype, the SMIL "default" and random's own name are one.
	const own = subtype === undefined || subtype === "default" || subtype === type ? "" : String(subtype)

	return `${type}/${own}${transition.options["smilDirection"] === "reverse" ? " reverse" : ""}`
}

function expectedSmil(transition: Transition): string {
	const mapped = odfPageTransition(transition)

	if (mapped === undefined) return "none"

	const { type, subtype, reverse } = mapped.odf

	return `${type}/${subtype === "default" || subtype === type ? "" : subtype}${reverse ? " reverse" : ""}`
}

describe("every transition authored and saved", () => {
	let pptx: Uint8Array
	let odp: Uint8Array
	let scratch: string

	beforeAll(async () => {
		const h = await editHarness(pptxDeck(), { emit: emitPptx })

		try {
			for (const [index, transition] of CASES.entries()) {
				const slide = await h.slide(index)
				const result = await h.command(set(slide.ref, transition))

				if (!result.ok) throw new Error(`${label(transition)}: ${JSON.stringify(result)}`)
			}

			pptx = await saveEdits(h, CASES.length)
		} finally {
			h.close()
		}

		const opened = await openOdpDeck(odpDeck())
		const apply = odpApplier(opened)

		for (const [index, transition] of CASES.entries()) {
			const refusal = apply(set(slideAt(opened, index).ref, transition))

			if (refusal !== undefined) throw new Error(`${label(transition)}: ${refusal.reason} ${refusal.detail ?? ""}`)
		}

		const saved = await saveDeck(opened)

		if (saved.outcome.kind !== "written") throw new Error(JSON.stringify(saved.outcome))

		odp = saved.bytes

		if (OUT !== undefined) mkdirSync(OUT, { recursive: true })

		scratch = OUT ?? mkdtempSync(join(tmpdir(), "filen-office-transitions-"))
		writeFileSync(join(scratch, "transitions.pptx"), pptx)
		writeFileSync(join(scratch, "transitions.odp"), odp)
		writeFileSync(join(scratch, "transitions-source.pptx"), pptxDeck())
	}, 120_000)

	afterAll(() => {
		if (OUT === undefined && scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
	})

	it("covers the 53 transitions twice", () => {
		expect(new Set(CASES.map(transition => `${transition.namespace}:${transition.kind}`)).size).toBe(53)
		expect(CASES).toHaveLength(106)
	})

	it("reads every pptx slide back with the transition written", { timeout: 60_000 }, async () => {
		const reopened = await openDeck(pptx)

		for (const [index, transition] of CASES.entries())
			expect(written(slideNode(reopened, index).transition), label(transition)).toEqual(written(transition))
	})

	it("reads every ODP page back with the SMIL transition it maps to, its duration and its advance", { timeout: 60_000 }, async () => {
		const reopened = await openOdpDeck(odp)

		for (const [index, transition] of CASES.entries()) {
			const read = slideAt(reopened, index).transition

			expect(smilOf(read), label(transition)).toBe(expectedSmil(transition))

			if (expectedSmil(transition) !== "none") expect(read?.durationMs, label(transition)).toBe(transition.durationMs)

			expect(read?.advance.afterMs, label(transition)).toBe(transition.advance.afterMs)
		}
	})

	it.skipIf(SDK_MISSING !== undefined)("adds no Open XML SDK error", { timeout: 300_000 }, async () => {
		const sdk = new OpenXmlSdk()

		try {
			const before = sdkErrorCounts(await sdk.validate(join(scratch, "transitions-source.pptx")))
			const after = sdkErrorCounts(await sdk.validate(join(scratch, "transitions.pptx")))

			expect(newSdkErrors(before, after, loadAllowlist())).toEqual([])
		} finally {
			await sdk.close()
		}
	})

	it.skipIf(ODF_VALIDATOR === "")("has no odfvalidator conformance error", { timeout: 300_000 }, () => {
		const run = spawnSync("java", ["-jar", ODF_VALIDATOR, "-1.3", join(scratch, "transitions.odp")], {
			encoding: "utf8",
			maxBuffer: 1 << 26
		})
		const errors = `${run.stdout}\n${run.stderr}`.split("\n").filter(line => /(?:Error|Fatal):/u.test(line))

		expect(errors).toEqual([])
	})

	it.skipIf(OFFICE === undefined)("LibreOffice reads back the SMIL transition each one maps to", { timeout: 900_000 }, async () => {
		const office = OFFICE as NonNullable<typeof OFFICE>
		const profile = process.env["FILEN_OFFICE_LO_PROFILE"] || join(scratch, "lo-profile")
		const out = join(scratch, "lo")
		const fromPptx = await convertWith(office, profile, "odp:impress8", [join(scratch, "transitions.pptx")], join(out, "pptx"), 600_000)
		const fromOdp = await convertWith(office, profile, "odp:impress8", [join(scratch, "transitions.odp")], join(out, "odp"), 600_000)

		expect(fromPptx.timedOut || fromOdp.timedOut).toBe(false)

		const misses: string[] = []

		for (const format of ["pptx", "odp"] as const) {
			const read = await openOdpDeck(new Uint8Array(readFileSync(join(out, format, "transitions.odp"))))

			for (const [index, transition] of CASES.entries()) {
				const mapped = odfPageTransition(transition)
				// A kind ODF has no equivalent for is written to ODP as its fallback, which LibreOffice reads as written;
				// through pptx LibreOffice reads the Choice, and draws none (or its own stand-in) for a p14/p15 kind it lacks.
				const expected = expectedSmil(transition)
				const got = smilOf(slideAt(read, index).transition)
				const fallback = format === "pptx" && mapped?.exact === false

				if (got !== expected && !(fallback && got === "none")) misses.push(`${format} ${label(transition)}: ${got} vs ${expected}`)
			}
		}

		if (OUT !== undefined) writeFileSync(join(OUT, "lo-misses.txt"), misses.join("\n"))

		expect(misses.filter(miss => !LIBREOFFICE_GAPS.some(gap => gap.test(miss)))).toEqual([])
	})
})

// LibreOffice 7.5's pptx import, measured over UNO: what it reads otherwise than the mapping table says.
const LIBREOFFICE_GAPS: readonly RegExp[] = [
	// p:strips becomes slideWipe from the opposite corner (the table, as LibreOffice's own ODF names it: waterfallWipe).
	/^pptx p:strips .*: slideWipe\/from\w+ vs waterfallWipe\//u,
	// p:zoom becomes zoom without a subtype (the table: irisWipe rectangle, reversed for "in").
	/^pptx p:zoom .*: zoom\/ vs irisWipe\/rectangle/u,
	// push, cover and pull moving left, right, up or down come from the edge they move to (ST_TransitionSideDirectionType
	// is the way the slide moves: "l" enters from the right); their corners come from the opposite corner, as the table.
	/^pptx p:(?:push|cover|pull) (?:\[\]|.*"dir","[lrud]").*: (?:pushWipe|slideWipe)\/from(Left|Right|Top|Bottom)( reverse)? vs (?:pushWipe|slideWipe)\/from(?!\1)(?:Left|Right|Top|Bottom)\2$/u
]
