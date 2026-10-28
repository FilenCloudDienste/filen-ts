import { describe, expect, it } from "vitest"
import { crc32 } from "../core/opc/index"
import { registerInsertedMedia } from "../core/presentation/edit/apply/media"
import type { Transition } from "../core/anim/model"
import { presetTransition, transitionPreset, TRANSITION_PRESETS } from "../core/anim/presets/transitions/catalog"
import { emitPptx } from "../core/pptx/write/emit"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { SlideNode } from "../core/presentation/model"
import { odpApplier, openOdpDeck, odpDeck, saveDeck, slideAt, entriesOf, text as odpText } from "./odpWriteFixtures"
import { odpBytes } from "./odpFixtures"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { changedParts, openDeck, partsOf, rebaseSession, saveEdits, slideNode, text } from "./pptxWriteFixtures"
import { editHarness, P14 } from "./presentationEditFixtures"

// Transitions authored through the transition ops and saved: written where the slide had none, in place of the
// file's own (AlternateContent included), removed, undone back to the file's bytes, set on every slide at once, and
// left byte for byte where untouched; the same through the ODP writer (page style and timing root par).

const EMIT = { emit: emitPptx }

const RIPPLE =
	'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice ' +
	P14 +
	' Requires="p14"><p:transition spd="slow" p14:dur="1500"><p14:ripple dir="ld"/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>'

function deck(): Uint8Array {
	const title = (text: string): string => sp(2, "Title 1", 'type="title"', "", body(para(text)))

	return buildPptx({
		slides: [
			{ shapes: title("One"), after: RIPPLE },
			{ shapes: title("Two"), after: '<p:transition spd="med"><p:push dir="u"/></p:transition>' },
			{ shapes: title("Three") },
			{ shapes: title("Four") }
		]
	})
}

function set(slides: readonly SlideNode[], transition: Transition | undefined): DeckOp {
	return { family: "transition", kind: "set", slides: slides.map(slide => slide.ref), transition }
}

function transitionXml(xml: string): string {
	return (
		/<mc:AlternateContent(?:(?!<\/mc:AlternateContent>).)*<p:transition.*?<\/mc:AlternateContent>|<p:transition\b.*?(?:\/>|<\/p:transition>)/su.exec(
			xml
		)?.[0] ?? ""
	)
}

const VORTEX: Transition = { kind: "vortex", namespace: "p14", options: { dir: "r" }, durationMs: 3000, advance: { onClick: true } }

describe("pptx transitions saved", () => {
	it("reads a slide's transition with the slide: the Choice, its Fallback, its timing", async () => {
		const opened = await openDeck(deck())
		const one = slideNode(opened, 0)

		expect(one.transition).toMatchObject({ kind: "ripple", namespace: "p14", durationMs: 1500, speed: "slow", options: { dir: "ld" } })
		expect(one.transition?.fallback).toBeDefined()
		expect(slideNode(opened, 1).transition).toMatchObject({ kind: "push", options: { dir: "u" }, speed: "med" })
		expect(slideNode(opened, 2).transition).toBeUndefined()
	})

	it("writes a new transition on a slide without one and reads it back; the other slides are untouched", async () => {
		const h = await editHarness(deck(), EMIT)
		const three = await h.slide(2)

		expect((await h.command(set([three], VORTEX))).ok).toBe(true)

		const saved = await saveEdits(h, 1)
		const reopened = await openDeck(saved)

		expect(slideNode(reopened, 2).transition).toMatchObject({
			kind: "vortex",
			namespace: "p14",
			durationMs: 3000,
			options: { dir: "r" }
		})
		expect(await changedParts(deck(), saved)).toEqual(["ppt/slides/slide3.xml"])

		const xml = text((await partsOf(saved)).get("ppt/slides/slide3.xml"))

		// After p:clrMapOvr (CT_Slide order), the Fallback fade.
		expect(transitionXml(xml)).toContain('<mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback>')
		expect(xml.indexOf("<mc:AlternateContent")).toBeGreaterThan(xml.indexOf("</p:cSld>"))
		h.close()
	})

	it("replaces the file's AlternateContent transition, removes one, and an undo writes the file's bytes again", async () => {
		const h = await editHarness(deck(), EMIT)
		const [one, two] = [await h.slide(0), await h.slide(1)]
		const fade = presetTransition(transitionPreset("fade", "p") as NonNullable<ReturnType<typeof transitionPreset>>)

		expect((await h.command(set([one], fade))).ok).toBe(true)
		expect((await h.command(set([two], undefined))).ok).toBe(true)

		const saved = await saveEdits(h, 2)
		const parts = await partsOf(saved)

		await rebaseSession(h, deck(), saved)

		expect(transitionXml(text(parts.get("ppt/slides/slide1.xml")))).toContain("<p:fade/>")
		expect(text(parts.get("ppt/slides/slide1.xml"))).not.toContain("ripple")
		expect(transitionXml(text(parts.get("ppt/slides/slide2.xml")))).toBe("")

		const source = await partsOf(deck())

		expect((await h.undo()).ok).toBe(true)
		expect((await h.undo()).ok).toBe(true)

		const undone = await partsOf(await saveEdits(h, 4))

		for (const name of ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]) {
			expect(transitionXml(text(undone.get(name)))).toBe(transitionXml(text(source.get(name))))
		}

		h.close()
	})

	it("keeps an untouched transition byte for byte when its slide is rewritten for another edit", async () => {
		const h = await editHarness(deck(), EMIT)
		const one = await h.slide(0)
		const title = one.shapes[0]

		if (title === undefined) throw new Error("no title")

		expect((await h.command({ family: "shape", kind: "delete", slide: one.ref, shapes: [title.id] })).ok).toBe(true)

		const saved = text((await partsOf(await saveEdits(h, 1))).get("ppt/slides/slide1.xml"))

		expect(transitionXml(saved)).toBe(RIPPLE)
		h.close()
	})

	it("sets one transition on every slide", async () => {
		const h = await editHarness(deck(), EMIT)
		const slides = await Promise.all([0, 1, 2, 3].map(index => h.slide(index)))
		const wipe: Transition = {
			kind: "wipe",
			namespace: "p",
			options: { dir: "d" },
			durationMs: 1000,
			advance: { onClick: false, afterMs: 4000 }
		}

		expect((await h.command(set(slides, wipe))).ok).toBe(true)

		const reopened = await openDeck(await saveEdits(h, 1))

		for (let index = 0; index < 4; index++) {
			expect(slideNode(reopened, index).transition).toMatchObject({
				kind: "wipe",
				options: { dir: "d" },
				advance: { onClick: false, afterMs: 4000 }
			})
		}

		h.close()
	})

	it("writes every catalog transition so that the saved deck reads it back", async () => {
		const h = await editHarness(
			buildPptx({ slides: TRANSITION_PRESETS.map(() => ({ shapes: sp(2, "T", 'type="title"', "", body(para("x"))) })) }),
			EMIT
		)

		for (const [index, entry] of TRANSITION_PRESETS.entries()) {
			const slide = await h.slide(index)

			expect((await h.command(set([slide], presetTransition(entry)))).ok, entry.kind).toBe(true)
		}

		const reopened = await openDeck(await saveEdits(h, TRANSITION_PRESETS.length))

		for (const [index, entry] of TRANSITION_PRESETS.entries()) {
			expect(slideNode(reopened, index).transition, entry.kind).toMatchObject({ kind: entry.kind, namespace: entry.namespace })
		}

		h.close()
	}, 60_000)
})

describe("ODP transitions saved", () => {
	it("writes a page's transition as its style and the timing root par, reads it back, and leaves other pages", async () => {
		const opened = await openOdpDeck(odpDeck())
		const apply = odpApplier(opened)
		const page = slideAt(opened, 1)
		const pull: Transition = {
			kind: "pull",
			namespace: "p",
			options: { dir: "d" },
			durationMs: 1600,
			advance: { onClick: true, afterMs: 2500 }
		}

		expect(apply(set([page], pull))).toBeUndefined()

		const saved = await saveDeck(opened)

		expect(saved.outcome.kind).toBe("written")

		const content = odpText((await entriesOf(saved.bytes)).get("content.xml"))
		const source = odpText((await entriesOf(opened.bytes)).get("content.xml"))

		expect(content).toMatch(/smil:type="slideWipe" smil:subtype="fromTop" smil:direction="reverse"/u)
		expect(content).toContain('<anim:par smil:begin="id2.begin"><anim:transitionFilter smil:dur="1.6s" smil:type="slideWipe"')
		// The page had no xml:id of its own: it is given one the content does not hold.
		expect(content).toMatch(/<draw:page draw:name="Middle"[^>]* xml:id="id2" draw:id="id2"/u)

		const pageOf = (xml: string, name: string): string =>
			/<draw:page [^>]*>.*?<\/draw:page>/gsu.exec(xml.slice(xml.indexOf(`draw:name="${name}"`) - 11))?.[0] ?? ""

		expect(pageOf(content, "End")).toBe(pageOf(source, "End"))

		const back = slideAt(await openOdpDeck(saved.bytes), 1).transition

		expect(back).toMatchObject({ kind: "pull", options: { dir: "d" }, durationMs: 1600, advance: { afterMs: 2500 } })
		expect((await saveDeck(await openOdpDeck(saved.bytes))).outcome.kind).toBe("unchanged")
	})

	it("writes a p14 kind LibreOffice draws with its SMIL names and reads the kind back; removes a transition", async () => {
		const opened = await openOdpDeck(odpDeck())
		const apply = odpApplier(opened)

		expect(apply(set([slideAt(opened, 0)], VORTEX))).toBeUndefined()

		const saved = await saveDeck(opened)
		const read = await openOdpDeck(saved.bytes)

		expect(slideAt(read, 0).transition).toMatchObject({ kind: "vortex", namespace: "p14", durationMs: 3000 })
		expect(odpApplier(read)(set([slideAt(read, 0)], undefined))).toBeUndefined()

		const removed = await saveDeck(read)
		const content = odpText((await entriesOf(removed.bytes)).get("content.xml"))

		expect(content).not.toContain("miscShapeWipe")
		expect(content).not.toContain("anim:transitionFilter")
		expect(slideAt(await openOdpDeck(removed.bytes), 0).transition).toBeUndefined()
	})
})

describe("ODP transition directions", () => {
	it("writes cover and pull in all eight directions and reads each back", async () => {
		const dirs = ["l", "u", "r", "d", "lu", "ru", "ld", "rd"] as const
		const cases = (["cover", "pull"] as const).flatMap(kind => dirs.map(dir => ({ kind, dir })))
		const opened = await openOdpDeck(odpDeckWith(cases.length))
		const apply = odpApplier(opened)

		for (const [index, { kind, dir }] of cases.entries()) {
			const transition: Transition = { kind, namespace: "p", options: { dir }, durationMs: 1000, advance: { onClick: true } }

			expect(apply(set([slideAt(opened, index)], transition))).toBeUndefined()
		}

		const read = await openOdpDeck((await saveDeck(opened)).bytes)

		for (const [index, { kind, dir }] of cases.entries())
			expect(slideAt(read, index).transition, `${kind} ${dir}`).toMatchObject({ kind, options: { dir } })
	})
})

function odpDeckWith(pages: number): Uint8Array {
	return odpBytes({
		body: Array.from(
			{ length: pages },
			(_, index) =>
				`<draw:page draw:name="p${String(index + 1)}" draw:master-page-name="M"><draw:frame draw:name="T" presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p>${String(index)}</text:p></draw:text-box></draw:frame></draw:page>`
		).join("")
	})
}

describe("transition sounds", () => {
	function wav(size = 4000): Uint8Array {
		const bytes = new Uint8Array(44 + size)
		const text = (at: number, value: string): void => {
			for (let k = 0; k < value.length; k++) bytes[at + k] = value.charCodeAt(k)
		}

		text(0, "RIFF")
		text(8, "WAVEfmt ")
		text(36, "data")

		for (let k = 44; k < bytes.length; k++) bytes[k] = (k * 7) & 0xff

		return bytes
	}

	function register(deck: Parameters<typeof registerInsertedMedia>[0], id: number, contentType = "audio/wav"): Uint8Array {
		const bytes = wav()

		registerInsertedMedia(deck, id, {
			bytes: {
				length: bytes.length,
				chunks: async function* () {
					yield await Promise.resolve(bytes)
				}
			},
			size: bytes.length,
			crc32: crc32(bytes),
			contentType,
			name: "chime.wav"
		})

		return bytes
	}

	const FADE: Transition = { kind: "fade", namespace: "p", options: {}, durationMs: 700, advance: { onClick: true } }
	const sounded = (id: number, loop = false): Transition => ({
		...FADE,
		sound: { kind: "embedded", part: `inserted:${String(id)}`, name: "chime.wav", loop }
	})

	it("embeds a new WAV once for every slide it plays on, and reads it back", async () => {
		const h = await editHarness(deck(), EMIT)
		const sound = register(h.session.deck, 7)
		const slides = await Promise.all([0, 1, 2, 3].map(index => h.slide(index)))
		const media = { id: 7, kind: "audio", contentType: "audio/wav", size: sound.length, crc32: crc32(sound) } as const

		expect(
			(
				await h.command({
					family: "transition",
					kind: "set",
					slides: slides.map(slide => slide.ref),
					transition: sounded(7, true),
					media
				})
			).ok
		).toBe(true)

		const saved = await saveEdits(h, 1)
		const parts = await partsOf(saved)
		const wavs = [...parts.keys()].filter(name => name.endsWith(".wav"))

		expect(wavs).toHaveLength(1)
		expect([...(parts.get(wavs[0] ?? "") ?? [])]).toEqual([...sound])

		const reopened = await openDeck(saved)

		for (let index = 0; index < 4; index++) {
			expect(slideNode(reopened, index).transition?.sound).toMatchObject({
				kind: "embedded",
				part: `/${wavs[0] ?? ""}`,
				name: "chime.wav",
				loop: true
			})
		}

		h.close()
	})

	it("refuses a sound that is not WAV, and one the registry does not hold", async () => {
		const h = await editHarness(deck(), EMIT)

		register(h.session.deck, 8, "audio/mpeg")

		const slide = await h.slide(0)

		expect(await h.command({ family: "transition", kind: "set", slides: [slide.ref], transition: sounded(8) })).toMatchObject({
			ok: false,
			refusal: "unsupported"
		})
		expect(await h.command({ family: "transition", kind: "set", slides: [slide.ref], transition: sounded(9) })).toMatchObject({
			ok: false,
			refusal: "unsupported"
		})
		h.close()
	})

	it("writes an ODP page's sound as its style's and its transition par's, once, and reads it back with stop sound", async () => {
		const opened = await openOdpDeck(odpDeck())
		const apply = odpApplier(opened)
		const sound = register(opened.deck, 3)

		expect(apply({ ...set([slideAt(opened, 0), slideAt(opened, 1)], sounded(3, true)) })).toBeUndefined()
		expect(apply(set([slideAt(opened, 2)], { ...FADE, sound: { kind: "stop" } }))).toBeUndefined()

		const saved = await saveDeck(opened)
		const entries = await entriesOf(saved.bytes)
		const media = [...entries.keys()].filter(name => name.endsWith(".wav"))
		const content = odpText(entries.get("content.xml"))

		expect(media).toHaveLength(1)
		expect([...(entries.get(media[0] ?? "") ?? [])]).toEqual([...sound])
		expect(content.match(new RegExp(`<anim:audio xlink:href="${media[0] ?? ""}" smil:repeatCount="indefinite"/>`, "gu"))).toHaveLength(
			2
		)
		expect(content).toContain(`<presentation:sound xlink:type="simple" xlink:href="${media[0] ?? ""}"`)
		expect(content).toContain('<anim:command anim:command="stop-audio"/>')
		expect(odpText(entries.get("META-INF/manifest.xml"))).toContain(`manifest:full-path="${media[0] ?? ""}"`)

		const read = await openOdpDeck(saved.bytes)

		expect(slideAt(read, 0).transition?.sound).toEqual({ kind: "embedded", part: `/${media[0] ?? ""}`, loop: true })
		expect(slideAt(read, 2).transition?.sound).toEqual({ kind: "stop" })
		expect((await saveDeck(read)).outcome.kind).toBe("unchanged")
	})
})
