import { describe, expect, it } from "vitest"
import type { SlideShowInfo } from "../core/ppt/slides"
import { transitionXml } from "../core/ppt/transitions"

// SlideShowSlideInfoAtom ([MS-PPT] §2.6.6) to p:transition (ECMA-376 Part 1 §19.3.1.50).

function info(
	effectType: number,
	effectDirection: number,
	options: { flags?: number; speed?: number; slideTime?: number; sound?: number } = {}
): SlideShowInfo {
	const raw = new Uint8Array(16)
	const view = new DataView(raw.buffer)

	view.setInt32(0, options.slideTime ?? 0, true)
	view.setUint32(4, options.sound ?? 0, true)
	raw[8] = effectDirection
	raw[9] = effectType
	view.setUint16(10, options.flags ?? 0x1, true)
	raw[12] = options.speed ?? 2

	return {
		raw,
		hidden: false,
		effectType,
		effectDirection,
		flags: options.flags ?? 0x1,
		speed: options.speed ?? 2,
		slideTime: options.slideTime ?? 0
	}
}

const noSound = (): undefined => undefined

describe("ppt transitions", () => {
	it.each([
		[0, 1, '<p:cut thruBlk="1"/>'],
		[1, 0, "<p:random/>"],
		[2, 0, '<p:blinds dir="vert"/>'],
		[2, 1, '<p:blinds dir="horz"/>'],
		[3, 0, '<p:checker dir="horz"/>'],
		[4, 6, '<p:cover dir="ld"/>'],
		[5, 0, "<p:dissolve/>"],
		[6, 0, '<p:fade thruBlk="1"/>'],
		[7, 3, '<p:pull dir="d"/>'],
		[8, 1, '<p:randomBar dir="vert"/>'],
		[9, 7, '<p:strips dir="rd"/>'],
		[10, 2, '<p:wipe dir="r"/>'],
		[11, 1, '<p:zoom dir="in"/>'],
		[13, 2, '<p:split orient="vert" dir="out"/>'],
		[13, 1, '<p:split orient="horz" dir="in"/>'],
		[17, 0, "<p:diamond/>"],
		[18, 0, "<p:plus/>"],
		[19, 0, "<p:wedge/>"],
		[20, 1, '<p:push dir="u"/>'],
		[21, 1, '<p:comb dir="vert"/>'],
		[22, 0, "<p:newsflash/>"],
		[23, 0, "<p:fade/>"],
		[26, 8, '<p:wheel spokes="8"/>'],
		[27, 0, "<p:circle/>"]
	])("writes effect %i direction %i as %s", (type, direction, element) => {
		expect(transitionXml(info(type, direction), noSound)).toEqual({
			xml: `<p:transition>${element}</p:transition>`,
			unsupported: false
		})
	})

	it("writes nothing for a cut advanced by click at the default speed", () => {
		expect(transitionXml(info(0, 0), noSound)).toEqual({ xml: "", unsupported: false })
	})

	it("writes the speed, the timed advance and a slide that does not advance by click", () => {
		expect(transitionXml(info(5, 0, { speed: 0, flags: 0x400, slideTime: 3500 }), noSound).xml).toBe(
			'<p:transition spd="slow" advClick="0" advTm="3500"><p:dissolve/></p:transition>'
		)
		expect(transitionXml(info(5, 0, { speed: 1, flags: 0x401, slideTime: 90_000_000 }), noSound).xml).toBe(
			'<p:transition spd="med" advTm="86399000"><p:dissolve/></p:transition>'
		)
	})

	it("starts the sound the slide names, looped, or stops every sound", () => {
		const sound = (id: number): { rId: string; name: string } | undefined =>
			id === 7 ? { rId: "rId9", name: "Applause & cheer" } : undefined

		expect(transitionXml(info(23, 0, { flags: 0x1 | 0x10 | 0x40, sound: 7 }), sound).xml).toBe(
			'<p:transition><p:fade/><p:sndAc><p:stSnd loop="1"><p:snd r:embed="rId9" name="Applause &amp; cheer"/></p:stSnd></p:sndAc></p:transition>'
		)
		expect(transitionXml(info(23, 0, { flags: 0x1 | 0x10, sound: 8 }), sound).xml).toBe("<p:transition><p:fade/></p:transition>")
		expect(transitionXml(info(0, 0, { flags: 0x1 | 0x100 }), sound).xml).toBe(
			"<p:transition><p:sndAc><p:endSnd/></p:sndAc></p:transition>"
		)
	})

	it("reports an effect type MS-PPT does not define and leaves it out", () => {
		expect(transitionXml(info(40, 0, { speed: 1 }), noSound)).toEqual({
			xml: '<p:transition spd="med"></p:transition>',
			unsupported: true
		})
	})
})
