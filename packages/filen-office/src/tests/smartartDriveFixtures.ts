import { expect } from "vitest"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import type { SmartArtRenderer } from "../core/presentation/render/services"
import type { EngineSession } from "../dom/presentation/engine"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { review } from "../dom/presentation/engine/review"
import { smartArtRenderer } from "../dom/presentation/engine/smartart"
import { driveSession } from "./odpWriteDrive"
import { danglingReferences, partsOf } from "./pptxWriteFixtures"

// SmartArt session helpers shared by the diagram drive tests.

type Drive = Awaited<ReturnType<typeof driveSession>>

// The first diagram frame in `shapes`, groups included.
export function frameIn(shapes: readonly ShapeNode[]): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.frame?.kind === "smartart") return shape

		const child = shape.children === undefined ? undefined : frameIn(shape.children)

		if (child !== undefined) return child
	}

	return undefined
}

// The session's diagram renderer, reading parts from its package and resolving no relationships or content types.
export function diagramRenderer(session: EngineSession): SmartArtRenderer {
	return smartArtRenderer(session, {
		services: { xml: part => pptxParts(session.deck)?.document(part), relationship: () => undefined, contentType: () => undefined }
	})
}

// A pptx session with the diagram renderer, and the first slide holding a diagram with that frame.
export async function openedDiagram(bytes: Uint8Array): Promise<{ d: Drive; slide: SlideRef; frame: ShapeNode }> {
	const d = await driveSession(bytes, "pptx")

	diagramRenderer(d.session)

	for (const slide of d.session.deck.slides) {
		await review(d.context, slide)

		const frame = frameIn((d.session.deck.nodes.get(slide) as SlideNode).shapes)

		if (frame !== undefined) return { d, slide, frame }
	}

	throw new Error("no diagram")
}

// Saves the session: written, with every reference resolving.
export async function written(d: Drive): Promise<Uint8Array> {
	const saved = await d.save()

	expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))

	if (saved.bytes === undefined) throw new Error("not saved")

	expect(await danglingReferences(saved.bytes)).toEqual([])

	return saved.bytes
}

// The parts whose bytes differ, sorted.
export async function differingBytes(a: Uint8Array, b: Uint8Array): Promise<string[]> {
	const left = await partsOf(a)
	const right = await partsOf(b)
	const same = (x: Uint8Array | undefined, y: Uint8Array | undefined): boolean =>
		x !== undefined && y !== undefined && x.length === y.length && x.every((byte, at) => byte === y[at])

	return [...new Set([...left.keys(), ...right.keys()])].filter(name => !same(left.get(name), right.get(name))).sort()
}
