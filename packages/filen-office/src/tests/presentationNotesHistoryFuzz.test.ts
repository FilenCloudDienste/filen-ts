import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, ShapeRef, SlideNode, SlideRef, TextBody } from "../core/presentation/model"
import { editCapability, sessionEdits } from "../dom/presentation/engine/edit"
import { review } from "../dom/presentation/engine/review"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { modelVsFile } from "./modelVsFile"
import { danglingReferences, partsOf } from "./pptxWriteFixtures"

// The deck history over notes (notes started, their first text continuing that step, typing bursts, retract), slide
// text, moves, duplicates, undo, redo and saves, against a reference timeline of states: coming back to a state already
// saved writes the same bytes, a state equal to the saved one is clean, merges never cross a save, and every save is
// whole. Notes started and not yet typed in (provisional) are taken back by a save of other edits and by an undo first.
const nb = (...t: string[]): TextBody => ({
	bodyPr: {},
	paragraphs: t.map(x => ({ pPr: {}, runs: x === "" ? [] : [{ kind: "r" as const, text: x, rPr: {} }] }))
})

function rng(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (s + 0x6d2b79f5) >>> 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

type Format = "pptx" | "odp"
function deckOf(name: string): { bytes: Uint8Array; format: Format } {
	if (name === "synthetic.pptx")
		return {
			format: "pptx",
			bytes: buildPptx({
				slides: [0, 1, 2].map(i => ({
					shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${i}`)))
				}))
			})
		}
	if (name === "synthetic.odp")
		return {
			format: "odp",
			bytes: odpBytes({
				body: [0, 1, 2]
					.map(
						i =>
							`<draw:page draw:name="P${i}" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T${i}</text:p></draw:text-box></draw:frame></draw:page>`
					)
					.join("")
			})
		}
	const format = name.endsWith(".odp") ? "odp" : "pptx"
	return { format, bytes: new Uint8Array(readFileSync(join(CORPUS_DIR, format, name))) }
}

function textShapes(shapes: readonly ShapeNode[], out: ShapeNode[] = []): ShapeNode[] {
	for (const s of shapes) {
		if (s.kind === "sp" && s.text !== undefined && s.xfrm !== undefined) out.push(s)
		if (s.children) textShapes(s.children, out)
	}
	return out
}

// The content types item's overrides in name order: their order carries nothing (OPC, ECMA-376 Part 2 §10.1.2.2), and a
// part a later save adds again lands at the end.
function contentTypes(bytes: Uint8Array): string {
	const text = new TextDecoder().decode(bytes)

	return [...text.matchAll(/<(?:Default|Override) [^>]*\/>/gu)]
		.map(match => match[0])
		.sort()
		.join("")
}

// ODP automatic style names renumbered by order of first use (a save may pick fresh names for the same styles).
function norm(bytes: Uint8Array): string {
	const text = new TextDecoder().decode(bytes)
	const names = new Map<string, string>()
	return text.replace(
		/(style:name|style-name|draw:text-style-name|style:parent-style-name)="([A-Za-z]+)(\d+)"/gu,
		(_m, a: string, p: string, n: string) => {
			const key = p + n
			if (!names.has(key)) names.set(key, `${p}#${names.size}`)
			return `${a}="${names.get(key)}"`
		}
	)
}

const CORPUS_DECKS = ["govuk__Shaping_the_Qualifications_Landscape.pptx", "lo__tdf90627.odp"].filter(name =>
	existsSync(join(CORPUS_DIR, name.endsWith(".odp") ? "odp" : "pptx", name))
)
const DECKS = ["synthetic.pptx", "synthetic.odp", ...CORPUS_DECKS]
// Seeds 1–24, and seeds a longer run found (kept as regressions).
const SEEDS = [...Array.from({ length: 24 }, (_, k) => k + 1), 162, 1014, 1018, 1066, 1128, 1188, 1189]
const STEPS = 40

describe("notes across the deck history: undo, redo, retract and saves", () => {
	for (const name of DECKS)
		for (const seed of SEEDS)
			it(`${name} seed ${String(seed)}`, { timeout: 120_000 }, async () => {
				const { bytes, format } = deckOf(name)
				const d = await driveSession(bytes, format)
				const history = sessionEdits(d.session).history
				const r = rng(seed * 104729 + name.length)
				const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T
				let nextState = 1
				// Reference timeline of state ids.
				let S = [0]
				let c = 0
				let savedState = 0
				const savedBytes = new Map<number, Map<string, Uint8Array>>()
				const problems: string[] = []
				const trace: string[] = []
				let lastPush: { S: number[]; c: number; revision: number; provisional: boolean } | undefined
				let lastWasSetNotes: SlideRef | undefined
				// Notes started and not typed in: a save of other edits or an undo takes them back first.
				// The notes body a save took back (dormant: the review still answers it, the next text on it makes it again,
				// continued by that text: one step, not retractable).
				let provisionalBody: ShapeRef | undefined
				const dormant: ShapeRef[] = []
				const takeBackProvisional = (bySave: boolean): void => {
					if (lastPush?.provisional !== true) return

					S = lastPush.S
					c = lastPush.c
					lastPush = undefined
					if (bySave && provisionalBody !== undefined) dormant.push(provisionalBody)
					trace.push("(taken back)")
				}
				const push = async (op: DeckOp, label: string, provisional = false): Promise<void> => {
					const revived = op.family === "text" && "target" in op ? dormant.findIndex(body => body.slide === op.target.slide) : -1
					const reviving = revived >= 0
					const before = history.depth.undo
					const snapshot = { S: [...S], c }
					const atSave = S[c] === savedState
					const res = await d.command(op)
					if (!res.ok) {
						trace.push(`${label}:${(res as { refusal?: string }).refusal ?? "no"}`)
						return
					}
					const merged = history.depth.undo === before && before > 0
					S.length = c + 1
					if (merged) {
						if (atSave) problems.push(`${label} merged onto the saved state`)
						S[c] = nextState++
						lastPush = undefined
					} else {
						S.push(nextState++)
						c++
						lastPush = reviving ? undefined : { ...snapshot, revision: res.revision, provisional }
					}
					if (reviving) dormant.splice(revived, 1)
					trace.push(`${label}${merged ? "[m]" : ""}${reviving ? "[revived]" : ""}`)
				}
				for (let n = 0; n < STEPS && problems.length === 0; n++) {
					const slides = d.session.deck.slides as SlideRef[]
					const slide = pick(slides)
					const x = r()
					const prevSetNotes = lastWasSetNotes
					lastWasSetNotes = undefined
					if (prevSetNotes !== undefined && x < 0.5) {
						// The first text in the notes just made (continues the setNotes step).
						const target = (await review(d.context, prevSetNotes, { comments: false })).notes
						if (target !== undefined)
							await push(
								{ family: "text", kind: "setText", target, body: nb(`first${n}`), burst: 1000 + n } as DeckOp,
								"notes.first"
							)
						continue
					}
					if (x < 0.15) {
						const rv = await review(d.context, slide, { comments: false })
						if (rv.notes !== undefined) {
							trace.push("skip")
							continue
						}
						await push(
							{ family: "notes", kind: "setNotes", slide, body: nb() } as DeckOp,
							`setNotes@${String(slides.indexOf(slide))}`,
							true
						)
						if (lastPush?.provisional === true) provisionalBody = (await review(d.context, slide, { comments: false })).notes
						if (lastPush !== undefined) lastWasSetNotes = slide
					} else if (x < 0.3) {
						const target = (await review(d.context, slide, { comments: false })).notes
						if (target === undefined) continue
						const burst = r() < 0.6 ? 1 + Math.floor(r() * 2) : undefined
						await push(
							{
								family: "text",
								kind: "setText",
								target,
								body: nb(`note${n}`, r() < 0.3 ? "line2" : "x"),
								...(burst === undefined ? {} : { burst })
							} as DeckOp,
							`notes.text${burst ?? ""}`
						)
					} else if (x < 0.42) {
						await review(d.context, slide, { comments: false })
						const shape = textShapes((d.session.deck.nodes.get(slide) as SlideNode).shapes)[0]
						if (shape === undefined) continue
						const burst = r() < 0.6 ? 7 : undefined
						await push(
							{
								family: "text",
								kind: "setText",
								target: { slide, id: shape.id },
								body: nb(`slide${n}`),
								...(burst === undefined ? {} : { burst })
							} as DeckOp,
							`text${burst ?? ""}`
						)
					} else if (x < 0.5) {
						await review(d.context, slide, { comments: false })
						const shape = textShapes((d.session.deck.nodes.get(slide) as SlideNode).shapes)[0]
						if (shape?.xfrm === undefined) continue
						await push(
							{
								family: "shape",
								kind: "setXfrm",
								target: { slide, id: shape.id },
								xfrm: { ...shape.xfrm, x: shape.xfrm.x + 12700 }
							} as DeckOp,
							"move"
						)
					} else if (x < 0.55) {
						await push({ family: "slide", kind: "duplicate", slide } as DeckOp, `dup@${slides.indexOf(slide)}`)
					} else if (x < 0.63) {
						const expected = lastPush !== undefined
						const res = await editCapability.retract(d.context, lastPush?.revision ?? history.revision)
						if (res.ok !== expected) problems.push(`retract ok ${res.ok} expected ${expected}`)
						if (res.ok && lastPush !== undefined) {
							S = lastPush.S
							c = lastPush.c
						}
						lastPush = undefined
						trace.push(`retract:${res.ok}`)
					} else if (x < 0.75) {
						takeBackProvisional(false)
						const res = await d.undo()
						if (!res.ok && c > 0) problems.push(`undo refused ${JSON.stringify(res)} (${trace.slice(-8).join(",")})`)
						if (res.ok && c > 0) {
							c--
							lastPush = undefined
						}
						trace.push("undo")
					} else if (x < 0.85) {
						const res = await d.redo()
						if (!res.ok && c < S.length - 1) problems.push(`redo refused ${JSON.stringify(res)} (${trace.slice(-8).join(",")})`)
						if (res.ok && c < S.length - 1) {
							c++
							lastPush = undefined
						}
						trace.push("redo")
					} else {
						// Only the provisional notes on top of the saved state (or of one the file matches: a retracted step made
						// again): clean, nothing written, nothing taken back.
						if (lastPush?.provisional === true && (lastPush.S[lastPush.c] === savedState || !history.dirty)) {
							if (history.dirty) problems.push(`dirty with only notes started (${trace.slice(-6).join(",")})`)
							const s = await d.save()
							trace.push(`save:${s.result.kind}`)
							if (s.result.kind !== "unchanged") problems.push(`saved only notes started: ${s.result.kind}`)
							savedState = lastPush.S[lastPush.c] as number
							continue
						}
						takeBackProvisional(true)
						const state = S[c] as number
						const dirty = history.dirty
						if (state === savedState && dirty) problems.push(`dirty at the saved state (${trace.slice(-6).join(",")})`)
						const s = await d.save()
						trace.push(`save:${s.result.kind}`)
						if (s.result.kind === "written") {
							// The file holds what the session shows.
							const differs = await modelVsFile(d, s.bytes!, format)
							if (differs !== "") problems.push(`file differs from the model: ${differs.slice(0, 600)}`)
							const bad = format === "pptx" ? await danglingReferences(s.bytes!) : []
							if (bad.length > 0) problems.push(`dangling ${bad.join(";")}`)
							const parts = await partsOf(s.bytes!)
							const prior = savedBytes.get(state)
							if (prior !== undefined) {
								const diff: string[] = []
								for (const k of new Set([...prior.keys(), ...parts.keys()])) {
									const a = prior.get(k)
									const b = parts.get(k)
									if (a === undefined || b === undefined) diff.push(k)
									else if (!Buffer.from(a).equals(Buffer.from(b)))
										diff.push(
											(format === "odp" && norm(a) === norm(b)) ||
												(k === "[Content_Types].xml" && contentTypes(a) === contentTypes(b))
												? `${k}(order or auto-style names only)`
												: k
										)
								}
								if (diff.every(k => k.endsWith("(order or auto-style names only)"))) {
									if (diff.length > 0) trace.push("[renumbered or reordered only]")
									diff.length = 0
								}
								if (diff.length > 0) {
									const k = diff[0]!.replace(/\(.*$/u, "")
									const la = norm(prior.get(k) ?? new Uint8Array()).split("><")
									const lb = norm(parts.get(k) ?? new Uint8Array()).split("><")
									const sa = new Set(la)
									const sb = new Set(lb)
									problems.push(
										`state ${state} saved again differs: ${diff.join(",")} -[${la
											.filter(x => !sb.has(x))
											.slice(0, 3)
											.join(" || ")
											.slice(0, 600)}] +[${lb
											.filter(x => !sa.has(x))
											.slice(0, 3)
											.join(" || ")
											.slice(0, 600)}]`
									)
								}
							} else savedBytes.set(state, parts)
							savedState = state
						} else if (s.result.kind === "refused") problems.push(`save ${JSON.stringify(s.result).slice(0, 200)}`)
						else if (state !== savedState && dirty) problems.push(`dirty but save ${s.result.kind}`)
						else savedState = state
					}
				}
				expect(problems, trace.join(",")).toEqual([])
			})
})
