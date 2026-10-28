import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { openOdp } from "../core/odp/read/document"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { Deck, ShapeNode, Xfrm } from "../core/presentation/model"
import { blankOdpParts } from "../core/templates/odp"
import { zipParts, type TemplatePart } from "../core/templates/zip"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, text } from "./odpWriteFixtures"

// A scaled slide size change on an ODP deck moves the master pages' shapes in styles.xml. A group (draw:g, ODF 1.3
// Part 3 §10.3.15) takes no svg:x, svg:width or svg:height: its box is its members' bounds, so the change scales
// each member, as the reader derives the group's box. A line takes its ends. A member whose box the save cannot
// write (a skew transform) refuses the save, never writing the group half-moved.

const FIT: DeckOp = { family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "ensureFit" }

function deckWith(masterShapes: string): Promise<Uint8Array> {
	return zipParts(
		blankOdpParts({ locale: "en-US", title: "Page 1" }).map(([name, markup, stored]): TemplatePart => {
			if (stored !== undefined) return [name, markup, stored]
			if (name !== "styles.xml") return [name, markup]

			return [name, markup.replace(/(<style:master-page [^>]*>)/u, `$1${masterShapes}`)]
		})
	)
}

const GROUP =
	'<draw:g draw:name="Pair"><draw:rect draw:layer="backgroundobjects" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="2cm"/>' +
	'<draw:rect draw:layer="backgroundobjects" svg:x="6cm" svg:y="3cm" svg:width="2cm" svg:height="2cm"/></draw:g>' +
	'<draw:line draw:name="Rule" draw:layer="backgroundobjects" svg:x1="1cm" svg:y1="10cm" svg:x2="8cm" svg:y2="12cm"/>'

function masterGroups(styles: string): string[] {
	const masters = styles.slice(styles.indexOf("<office:master-styles"))

	return [...masters.matchAll(/<draw:g\b[^>]*>/gu)].map(match => match[0])
}

async function reopened(bytes: Uint8Array): Promise<Deck> {
	const opened = await openOdp(bytesSource(bytes))

	if (opened.kind !== "opened") throw new Error(JSON.stringify(opened))

	return opened.deck
}

function named(deck: Deck, name: string): ShapeNode {
	for (const ref of deck.masters) {
		const shape = deck.nodes.get(ref)?.shapes.find(each => each.name === name)

		if (shape !== undefined) return shape
	}

	throw new Error(`no master shape ${name}`)
}

// A box as drawn: a group's members placed through its child space.
function drawn(shape: ShapeNode): Xfrm[] {
	const xfrm = shape.xfrm as Xfrm

	if (shape.children === undefined) return [xfrm]

	const sx = xfrm.cx / (xfrm.chCx ?? xfrm.cx)
	const sy = xfrm.cy / (xfrm.chCy ?? xfrm.cy)

	return shape.children.flatMap(drawn).map(child => ({
		...child,
		x: xfrm.x + (child.x - (xfrm.chX ?? xfrm.x)) * sx,
		y: xfrm.y + (child.y - (xfrm.chY ?? xfrm.y)) * sy,
		cx: child.cx * sx,
		cy: child.cy * sy
	}))
}

function close(a: readonly Xfrm[], b: readonly Xfrm[]): void {
	expect(a.length).toBe(b.length)

	for (const [index, box] of a.entries()) {
		const other = b[index] as Xfrm

		for (const key of ["x", "y", "cx", "cy"] as const) expect(Math.abs(box[key] - other[key])).toBeLessThanOrEqual(400)
	}
}

describe("a scaled slide size change on an ODP deck with a group on its master page", () => {
	it("scales the group's members and writes no box on draw:g; the reopened group is where the session has it", async () => {
		const d = await driveSession(await deckWith(GROUP))
		const applied = await d.command(FIT)

		expect(applied.ok).toBe(true)

		const session = d.session.deck
		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const styles = text((await entriesOf(saved.bytes as Uint8Array)).get("styles.xml"))
		const groups = masterGroups(styles)

		expect(groups).toHaveLength(1)
		for (const group of groups) expect(group).not.toMatch(/svg:(x|y|width|height)=/u)

		const line = /<draw:line\b[^>]*draw:name="Rule"[^>]*>/u.exec(styles)?.[0] ?? ""

		expect(line).toMatch(/svg:x1="/u)
		expect(line).not.toMatch(/svg:(x|y|width|height)=/u)

		const back = await reopened(saved.bytes as Uint8Array)

		close(drawn(named(back, "Pair")), drawn(named(session, "Pair")))
		close(drawn(named(back, "Rule")), drawn(named(session, "Rule")))
	})

	it("writes a member placed by a skew transform with the size change's mapping after its own; it reopens where the session has it", async () => {
		const skewed = GROUP.replace('svg:x="6cm" svg:y="3cm"', 'draw:transform="skewX (0.2) translate (6cm 3cm)"')
		const d = await driveSession(await deckWith(skewed))

		expect((await d.command(FIT)).ok).toBe(true)

		const session = d.session.deck
		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const styles = text((await entriesOf(saved.bytes as Uint8Array)).get("styles.xml"))

		expect(styles).toMatch(/draw:transform="skewX \(0\.2\) translate \(6cm 3cm\) scale \([^)]+\) translate \([^)]+\)"/u)
		close(drawn(named(await reopened(saved.bytes as Uint8Array), "Pair")), drawn(named(session, "Pair")))
	})

	it("keeps a turned master shape's angle as written and moves its translation", async () => {
		const turned =
			'<draw:custom-shape draw:name="Turned" draw:layer="backgroundobjects" svg:width="10.969cm" svg:height="6.951cm" ' +
			'draw:transform="rotate (0.00453785605518526) translate (2.5cm 7.049cm)"><draw:enhanced-geometry draw:type="rectangle"/></draw:custom-shape>'
		const d = await driveSession(await deckWith(turned))

		expect((await d.command(FIT)).ok).toBe(true)

		const session = d.session.deck
		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const styles = text((await entriesOf(saved.bytes as Uint8Array)).get("styles.xml"))
		const shape = /<draw:custom-shape\b[^>]*draw:name="Turned"[^>]*>/u.exec(styles)?.[0] ?? ""

		expect(shape).toMatch(/draw:transform="rotate \(0\.00453785605518526\) translate \([^)]+\)"/u)
		expect(shape).not.toContain("translate (2.5cm 7.049cm)")

		const back = named(await reopened(saved.bytes as Uint8Array), "Turned")

		close(drawn(back), drawn(named(session, "Turned")))
		expect(back.xfrm?.rot).toBe(named(session, "Turned").xfrm?.rot)
	})

	it("maps a transform by every size change since the file was read, an undone one taken back", async () => {
		const skewed = GROUP.replace('svg:x="6cm" svg:y="3cm"', 'draw:transform="skewX (0.2) translate (6cm 3cm)"')
		const d = await driveSession(await deckWith(skewed))

		expect((await d.command(FIT)).ok).toBe(true)
		expect((await d.command({ family: "design", kind: "setSize", cx: 12_192_000, cy: 6_858_000, scale: "maximize" })).ok).toBe(true)
		expect((await d.command({ family: "design", kind: "setSize", cx: 9_144_000, cy: 9_144_000, scale: "ensureFit" })).ok).toBe(true)
		expect((await d.undo()).ok).toBe(true)

		const session = d.session.deck
		const saved = await d.save()

		expect(saved.result.kind).toBe("written")
		close(drawn(named(await reopened(saved.bytes as Uint8Array), "Pair")), drawn(named(session, "Pair")))
	})

	it("maps a transform by a size change undone and done again", async () => {
		const skewed = GROUP.replace('svg:x="6cm" svg:y="3cm"', 'draw:transform="skewX (0.2) translate (6cm 3cm)"')
		const d = await driveSession(await deckWith(skewed))

		expect((await d.command(FIT)).ok).toBe(true)
		expect((await d.undo()).ok).toBe(true)
		expect((await d.redo()).ok).toBe(true)

		const session = d.session.deck
		const saved = await d.save()

		expect(saved.result.kind).toBe("written")
		close(drawn(named(await reopened(saved.bytes as Uint8Array), "Pair")), drawn(named(session, "Pair")))
		close(drawn(named(await reopened(saved.bytes as Uint8Array), "Rule")), drawn(named(session, "Rule")))
	})

	it("refuses a scaled size change at the command over a routed connector on a master page, changing nothing", async () => {
		const routed =
			'<draw:connector draw:name="Route" draw:layer="backgroundobjects" svg:x1="1cm" svg:y1="1cm" svg:x2="5cm" svg:y2="4cm" ' +
			'svg:d="M1000 1000h2000v3000h2000" svg:viewBox="0 0 4001 3001"/>'
		const d = await driveSession(await deckWith(routed))
		const size = { ...d.session.deck.size }
		const box = { ...named(d.session.deck, "Route").xfrm }
		const applied = await d.command(FIT)

		expect(applied).toMatchObject({ ok: false, refusal: "unsupported" })
		expect(d.session.deck.size).toEqual(size)
		expect(named(d.session.deck, "Route").xfrm).toEqual(box)
		expect((await d.command({ family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "none" })).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
	})

	it("writes a size change that moves nothing over a member placed by a transform, the member as it was", async () => {
		const skewed = GROUP.replace('svg:x="6cm" svg:y="3cm"', 'draw:transform="skewX (0.2) translate (6cm 3cm)"')
		const source = await deckWith(skewed)
		const d = await driveSession(source)

		expect((await d.command({ family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "none" })).ok).toBe(true)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const entries = await entriesOf(saved.bytes as Uint8Array)
		const styles = text(entries.get("styles.xml"))

		expect(styles).toContain('draw:transform="skewX (0.2) translate (6cm 3cm)"')
		expect(styles).toContain('fo:page-width="25.4cm"')
		// Only styles.xml changed: content.xml is written as the file has it.
		expect(text(entries.get("content.xml"))).toBe(text((await entriesOf(source)).get("content.xml")))
	})
})

const TIKA = join(CORPUS_DIR, "odp", "tika__LibreOfficeImpress_odp_1.3.odp")

describe.skipIf(!existsSync(TIKA))("Ensure fit on a LibreOffice deck whose master page groups shapes", () => {
	it("writes the master page's groups without box attributes", async () => {
		const d = await driveSession(new Uint8Array(readFileSync(TIKA)))

		expect((await d.command(FIT)).ok).toBe(true)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const groups = masterGroups(text((await entriesOf(saved.bytes as Uint8Array)).get("styles.xml")))

		expect(groups.length).toBeGreaterThan(0)
		for (const group of groups) expect(group).not.toMatch(/svg:(x|y|width|height)=/u)
	}, 60_000)
})
