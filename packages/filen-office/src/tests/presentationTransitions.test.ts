import { describe, expect, it } from "vitest"
import type { Transition } from "../core/anim/model"
import {
	ecmaFallback,
	isEcmaTransition,
	kindFromOdf,
	odfPageTransition,
	playableTransition,
	presetTransition,
	TRANSITION_PRESETS,
	transitionOption,
	writtenOptions
} from "../core/anim/presets/transitions/catalog"
import { transitionToOdf } from "../core/anim/transitions"
import { odpTransitionPar, odpTransitionStyle } from "../core/odp/write/emit/transition"
import { styleChanges } from "../core/odp/write/styles"
import { Relationships } from "../core/opc/index"
import { DeckTally, DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { applyTransition, transitionRaw } from "../core/presentation/edit/apply/transition"
import type { ApplyContext } from "../core/presentation/edit/apply"
import { refused, slideRef, type Deck, type SlideNode } from "../core/presentation/model"
import { readTransition, transitionAt } from "../core/pptx/read/transition"
import { G, partReader } from "../core/pptx/read/xml"
import { pptxTransitionPieces } from "../core/pptx/write/emit/transition"
import type { EmitContext } from "../core/pptx/write/emit/shape"
import type { EmitPiece } from "../core/pptx/write/types"
import { decodeUtf8, encodeUtf8, parseXml } from "../core/xml/index"

// Transition authoring: the catalog of every ECMA, p14, p15 and morph transition, the ECMA fallback each p14/p15
// one is written with, the PresentationML each one becomes and reads back as, the ODF it becomes, and the apply.

const NS =
	'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
	'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

function relationships(): Relationships {
	return new Relationships([
		{
			id: "rId1",
			type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio",
			target: "../media/audio1.wav",
			external: false,
			partName: "ppt/media/audio1.wav"
		}
	])
}

function slideXml(inner: string): string {
	return `<p:sld ${NS}><p:cSld><p:spTree/></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${inner}</p:sld>`
}

function read(xml: string): Transition | undefined {
	const document = parseXml(encodeUtf8(xml))
	const reader = partReader(document)

	return readTransition(
		{
			reader,
			part: "/ppt/slides/slide1.xml",
			epoch: 0,
			relationships: relationships(),
			tally: new DeckTally(DEFAULT_PRESENTATION_BUDGETS),
			action: () => undefined
		},
		document.documentElement()
	)
}

// A model-mode emit context: no source part, relationships made on request.
function emitContext(): { readonly context: EmitContext; readonly related: string[] } {
	const related: string[] = []
	const context: EmitContext = {
		deck: undefined as unknown as Deck,
		document: undefined,
		parts: {
			owner: "/ppt/slides/slide1.xml",
			addPart: () => ({ part: "", rId: "" }),
			relate: target => {
				related.push(target)

				return `rId${String(related.length + 10)}`
			},
			target: () => undefined,
			removePart: () => undefined,
			editor: () => {
				throw new Error("no editor")
			}
		}
	}

	return { context, related }
}

function piecesOf(transition: Transition, context: EmitContext): readonly EmitPiece[] {
	const pieces = pptxTransitionPieces(transition, context)

	if (!Array.isArray(pieces)) throw new Error("refused")

	return pieces as readonly EmitPiece[]
}

function markup(transition: Transition): string {
	const { context } = emitContext()

	return piecesOf(transition, context)
		.map(piece => (typeof piece === "string" ? piece : piece instanceof Uint8Array ? decodeUtf8(piece) : ""))
		.join("")
}

// A transition without its source refs and spd, its options as written (defaults left out).
const comparable = (transition: Transition | undefined): unknown => {
	if (transition === undefined) return undefined

	const { src: _src, fallback: _fallback, speed: _speed, options: _options, ...rest } = transition

	return { ...rest, options: writtenOptions(transition) }
}

describe("transition catalog", () => {
	it("lists the 21 ECMA, 19 p14 and 12 p15 transitions and morph, each once", () => {
		const count = (namespace: Transition["namespace"]): number =>
			TRANSITION_PRESETS.filter(entry => entry.namespace === namespace).length

		expect(count("p")).toBe(21)
		expect(count("p14")).toBe(19)
		expect(count("p15")).toBe(12)
		expect(count("morph")).toBe(1)
		expect(new Set(TRANSITION_PRESETS.map(entry => `${entry.namespace}:${entry.kind}`)).size).toBe(TRANSITION_PRESETS.length)
	})

	it("falls every p14, p15 and morph transition back to an ECMA one, and an ECMA one to itself", () => {
		for (const entry of TRANSITION_PRESETS) {
			const fallback = ecmaFallback(presetTransition(entry))

			expect(isEcmaTransition(fallback.kind, "p"), entry.kind).toBe(true)
			if (entry.namespace === "p") expect(fallback.kind).toBe(entry.kind)
		}
	})

	it("chooses the fallback by the effect's motion and direction", () => {
		const of = (kind: string, namespace: Transition["namespace"], options: Transition["options"] = {}): unknown =>
			ecmaFallback({ kind, namespace, options, advance: { onClick: true } })

		expect(of("morph", "morph")).toEqual({ kind: "fade", options: {} })
		expect(of("vortex", "p14", { dir: "r" })).toEqual({ kind: "fade", options: {} })
		expect(of("pan", "p14", { dir: "d" })).toEqual({ kind: "push", options: { dir: "d" } })
		expect(of("pan", "p14")).toEqual({ kind: "push", options: { dir: "u" } })
		expect(of("doors", "p14", { dir: "vert" })).toEqual({ kind: "split", options: { orient: "vert", dir: "out" } })
		expect(of("warp", "p14", { dir: "out" })).toEqual({ kind: "zoom", options: { dir: "out" } })
		expect(of("reveal", "p14", { thruBlk: true })).toEqual({ kind: "fade", options: { thruBlk: true } })
		expect(of("wheelReverse", "p14", { spokes: "8" })).toEqual({ kind: "wheel", options: { spokes: "8" } })
		expect(of("peelOff", "p15", { invX: true })).toEqual({ kind: "pull", options: { dir: "r" } })
		expect(of("ripple", "p14")).toEqual({ kind: "circle", options: {} })
	})

	it("reads options as the schema types them, with the schema's defaults", () => {
		const prism: Transition = { kind: "prism", namespace: "p14", options: { isContent: "1" }, advance: { onClick: true } }

		expect(transitionOption(prism, "isContent")).toBe(true)
		expect(transitionOption(prism, "isInverted")).toBe(false)
		expect(transitionOption(prism, "dir")).toBe("l")
		expect(writtenOptions(prism)).toEqual([["isContent", "1"]])
		expect(writtenOptions({ kind: "wipe", namespace: "p", options: { dir: "l" } })).toEqual([])
		expect(writtenOptions({ kind: "wipe", namespace: "p", options: { dir: "bogus" } })).toEqual([])
	})

	it("maps every ECMA transition to the SMIL of core/anim/transitions.ts, and an instant cut to none", () => {
		for (const entry of TRANSITION_PRESETS.filter(each => each.namespace === "p")) {
			const transition = presetTransition(entry)
			const mapped = odfPageTransition(transition)

			if (entry.kind === "cut") {
				expect(mapped).toBeUndefined()
				expect(odfPageTransition({ ...transition, options: { thruBlk: true } })?.odf.type).toBe("barWipe")

				continue
			}

			expect({ type: mapped?.odf.type, subtype: mapped?.odf.subtype, reverse: mapped?.odf.reverse }).toEqual(
				transitionToOdf(entry.kind, transition.options)
			)
			expect(mapped?.exact).toBe(true)
		}
	})

	it("writes the p14 and p15 kinds LibreOffice draws with its own SMIL names, and reads them back", () => {
		const cases: readonly (readonly [string, Transition["namespace"], Transition["options"], string, string])[] = [
			["vortex", "p14", {}, "miscShapeWipe", "vertical"],
			["ripple", "p14", {}, "miscShapeWipe", "horizontal"],
			["honeycomb", "p14", {}, "miscShapeWipe", "heart"],
			["glitter", "p14", {}, "miscShapeWipe", "diamond"],
			["prism", "p14", {}, "miscShapeWipe", "cornersOut"],
			["prism", "p14", { isInverted: true }, "miscShapeWipe", "cornersIn"],
			["flash", "p14", {}, "fade", "fadeOverColor"],
			["fallOver", "p15", {}, "miscShapeWipe", "leftToRight"]
		]

		for (const [kind, namespace, options, type, subtype] of cases) {
			const mapped = odfPageTransition({ kind, namespace, options, advance: { onClick: true } })

			expect(mapped?.exact, kind).toBe(true)
			expect([mapped?.odf.type, mapped?.odf.subtype]).toEqual([type, subtype])
			expect(kindFromOdf(type, subtype, mapped?.odf.fadeColor)?.kind).toBe(kind)
		}

		// One LibreOffice cannot draw goes to ODP as its fallback.
		const doors = odfPageTransition({ kind: "doors", namespace: "p14", options: {}, advance: { onClick: true } })

		expect(doors).toEqual({ odf: { type: "barnDoorWipe", subtype: "horizontal", reverse: false }, exact: false })
	})

	it("plays a kind the player draws as itself, else the file's fallback, else ours with the transition's timing", () => {
		const vortex: Transition = {
			kind: "vortex",
			namespace: "p14",
			options: {},
			durationMs: 2500,
			advance: { onClick: false, afterMs: 3000 }
		}
		const ecma = (kind: string): boolean => isEcmaTransition(kind, "p")
		const drawable = (kind: string, namespace: Transition["namespace"]): boolean => isEcmaTransition(kind, namespace)

		expect(playableTransition(vortex, () => true)).toBe(vortex)

		const file: Transition = { kind: "wipe", namespace: "p", options: {}, advance: { onClick: true } }

		expect(playableTransition(vortex, drawable, file)).toBe(file)
		expect(playableTransition(vortex, drawable)).toEqual({ ...vortex, kind: "fade", namespace: "p", options: {} })
		expect(ecma("fade")).toBe(true)
	})
})

describe("pptx transition markup", () => {
	it("writes every transition so that it reads back the same, its Fallback the catalog's", () => {
		for (const entry of TRANSITION_PRESETS) {
			const options: Record<string, string | boolean> = {}

			for (const spec of entry.options)
				options[spec.name] = spec.kind === "boolean" ? true : (spec.values[spec.values.length - 1] ?? "")

			const transition: Transition = {
				...presetTransition(entry),
				options,
				durationMs: 1300,
				advance: { onClick: false, afterMs: 2500 }
			}
			const xml = markup(transition)
			const back = read(slideXml(xml))

			expect(comparable(back), entry.kind).toEqual(comparable(transition))

			const document = parseXml(encodeUtf8(slideXml(xml)))
			const r = partReader(document)
			const ac = r.child(document.documentElement(), G.MC, "AlternateContent")
			const fallback = r.child(r.child(ac, G.MC, "Fallback"), G.P, "transition")
			const played = transitionAt(document, fallback)
			const expected = ecmaFallback(transition)

			expect(played?.kind, entry.kind).toBe(expected.kind)
			expect(writtenOptions({ kind: played?.kind ?? "", namespace: "p", options: played?.options ?? {} })).toEqual(
				writtenOptions({ kind: expected.kind, namespace: "p", options: expected.options })
			)
			// The Fallback says spd only: its duration is the spd's.
			expect(played?.durationMs).toBe(1000)
			expect(played?.speed).toBe("slow")
			expect(played?.advance).toEqual({ onClick: false, afterMs: 2500 })
		}
	})

	it("writes an ECMA transition at its speed's duration as a bare p:transition", () => {
		const fade: Transition = { kind: "fade", namespace: "p", options: {}, durationMs: 750, advance: { onClick: true } }

		expect(markup(fade)).toBe('<p:transition spd="med"><p:fade/></p:transition>')
		expect(markup({ kind: "cut", namespace: "p", options: {}, advance: { onClick: true } })).toBe(
			"<p:transition><p:cut/></p:transition>"
		)
		expect(markup({ ...fade, durationMs: 700 })).toBe(
			'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">' +
				'<p:transition spd="med" p14:dur="700"><p:fade/></p:transition></mc:Choice><mc:Fallback><p:transition spd="med"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>'
		)
	})

	it("writes morph as PowerPoint does: a p159 Choice with p14:dur and a fade Fallback", () => {
		const xml = markup({
			kind: "morph",
			namespace: "morph",
			options: { option: "byWord" },
			durationMs: 2000,
			advance: { onClick: true }
		})

		expect(xml).toContain('Requires="p159"')
		expect(xml).toContain('<p:transition spd="slow" p14:dur="2000"><p159:morph option="byWord"/></p:transition>')
		expect(xml).toContain('<mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback>')
	})

	it("writes an embedded sound through a relationship, and stop sound", () => {
		const { context, related } = emitContext()
		const sound: Transition = {
			kind: "fade",
			namespace: "p",
			options: {},
			advance: { onClick: true },
			sound: { kind: "embedded", part: "/ppt/media/audio1.wav", name: "chime.wav", loop: true }
		}
		const pieces = piecesOf(sound, context).join("")

		expect(pieces).toBe(
			'<p:transition><p:fade/><p:sndAc><p:stSnd loop="1"><p:snd r:embed="rId11" name="chime.wav"/></p:stSnd></p:sndAc></p:transition>'
		)
		expect(related).toEqual(["/ppt/media/audio1.wav"])
		expect(markup({ ...sound, sound: { kind: "stop" } })).toBe("<p:transition><p:fade/><p:sndAc><p:endSnd/></p:sndAc></p:transition>")
	})

	it("reads a file's transition: the Choice it understands, its Fallback, its sound", () => {
		const ripple = read(
			slideXml(
				'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">' +
					'<p:transition spd="slow" p14:dur="1500"><p14:ripple dir="ld"/><p:sndAc><p:stSnd><p:snd r:embed="rId1" name="a.wav"/></p:stSnd></p:sndAc></p:transition></mc:Choice>' +
					'<mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>'
			)
		)

		expect(comparable(ripple)).toEqual({
			kind: "ripple",
			namespace: "p14",
			options: [["dir", "ld"]],
			durationMs: 1500,
			advance: { onClick: true },
			sound: { kind: "embedded", part: "/ppt/media/audio1.wav", name: "a.wav", loop: false }
		})
		expect(ripple?.fallback?.node).toBeGreaterThan(0)

		// A Choice in a namespace we do not read: the Fallback.
		const unknown = read(
			slideXml(
				'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:x="urn:x" Requires="x"><p:transition><x:y/></p:transition></mc:Choice>' +
					'<mc:Fallback><p:transition advTm="3000"><p:push dir="u"/></p:transition></mc:Fallback></mc:AlternateContent>'
			)
		)

		expect(comparable(unknown)).toEqual({
			kind: "push",
			namespace: "p",
			options: [["dir", "u"]],
			durationMs: 500,
			advance: { onClick: true, afterMs: 3000 }
		})
		expect(read(slideXml(""))).toBeUndefined()
	})
})

describe("ODP transition markup", () => {
	it("writes the page style properties and the timing root's transition par", () => {
		const changes = styleChanges()
		const pull: Transition = {
			kind: "pull",
			namespace: "p",
			options: { dir: "d" },
			durationMs: 1600,
			advance: { onClick: true, afterMs: 2500 }
		}

		odpTransitionStyle(changes, pull)

		expect(Object.fromEntries(changes.attributes.get("drawing-page") ?? [])).toEqual({
			"smil:type": "slideWipe",
			"smil:subtype": "fromTop",
			"smil:direction": "reverse",
			"smil:fadeColor": null,
			"presentation:transition-speed": "slow",
			"presentation:transition-type": "automatic",
			"presentation:duration": "PT2.5S"
		})
		expect(odpTransitionPar(pull, "id3")).toBe(
			'<anim:par smil:begin="id3.begin"><anim:transitionFilter smil:dur="1.6s" smil:type="slideWipe" smil:subtype="fromTop" smil:direction="reverse"/></anim:par>'
		)
	})

	it("removes every transition property, and writes no par for an instant cut", () => {
		const changes = styleChanges()

		odpTransitionStyle(changes, undefined)

		expect([...(changes.attributes.get("drawing-page")?.values() ?? [])].every(value => value === null)).toBe(true)
		expect(odpTransitionPar({ kind: "cut", namespace: "p", options: {}, advance: { onClick: true } }, "id1")).toBeUndefined()
		expect(odpTransitionPar(undefined, "id1")).toBeUndefined()
	})
})

describe("transition apply", () => {
	function deckOf(format: Deck["format"], count: number): Deck {
		const nodes = new Map<ReturnType<typeof slideRef>, SlideNode>()
		const slides = []

		for (let index = 0; index < count; index++) {
			const ref = slideRef(index + 1)

			slides.push(ref)
			nodes.set(ref, {
				ref,
				kind: "slide",
				part: `/ppt/slides/slide${String(index + 1)}.xml`,
				showMasterShapes: true,
				hidden: false,
				shapes: [],
				comments: [],
				revision: 0
			})
		}

		return { format, slides, nodes } as unknown as Deck
	}

	const source = encodeUtf8('<p:transition xmlns:p="urn:p"><p:wipe/></p:transition>')
	const context: ApplyContext = {
		sourceBytes: () => source,
		newShapeId: () => 1,
		newSlideRef: () => slideRef(99)
	}
	const fade: Transition = { kind: "fade", namespace: "p", options: {}, durationMs: 700, advance: { onClick: true } }

	it("sets one transition on every slide, each its own copy, and undoes each back with the file's bytes", () => {
		const deck = deckOf("pptx", 3)
		const first = deck.nodes.get(slideRef(1)) as SlideNode

		first.transition = {
			kind: "wipe",
			namespace: "p",
			options: {},
			advance: { onClick: true },
			src: { format: "pptx", part: first.part, node: 9, epoch: 0 }
		}

		const result = applyTransition.apply(deck, { family: "transition", kind: "set", slides: deck.slides, transition: fade }, context)

		if (result.kind !== "applied") throw new Error(result.reason)

		const set = deck.slides.map(ref => deck.nodes.get(ref)?.transition)

		expect(set.every(transition => transition?.kind === "fade" && transition !== fade && transition.src === undefined)).toBe(true)
		expect(new Set(set).size).toBe(3)
		expect(result.inverse.ops).toHaveLength(3)

		for (const back of result.inverse.ops) applyTransition.apply(deck, back as never, context)

		expect(first.transition?.kind).toBe("wipe")
		expect(transitionRaw(first.transition as Transition)).toBe(source)
		expect(deck.nodes.get(slideRef(2))?.transition).toBeUndefined()
		expect(applyTransition.touches({ family: "transition", kind: "set", slides: deck.slides, transition: fade })).toHaveLength(3)
	})

	it("refuses a kind outside the catalog, a duration past PowerPoint's limit and a sound the session does not hold", () => {
		const op = (transition: Transition, format: Deck["format"] = "pptx") =>
			applyTransition.apply(deckOf(format, 1), { family: "transition", kind: "set", slides: [slideRef(1)], transition }, context)

		expect(op({ ...fade, kind: "sparkle" })).toEqual(refused("unsupported", "transition p:sparkle"))
		expect(op({ ...fade, durationMs: 60_000 }).kind).toBe("refused")
		expect(op({ ...fade, advance: { onClick: true, afterMs: -1 } }).kind).toBe("refused")
		expect(op({ ...fade, sound: { kind: "embedded", part: "inserted:4", loop: false } }).kind).toBe("refused")
		expect(op({ ...fade, sound: { kind: "embedded", part: "media/a.wav", loop: false } }).kind).toBe("refused")
		expect(op({ ...fade, sound: { kind: "stop" } }, "odp").kind).toBe("applied")
		expect(op(fade, "odp").kind).toBe("applied")
	})
})
