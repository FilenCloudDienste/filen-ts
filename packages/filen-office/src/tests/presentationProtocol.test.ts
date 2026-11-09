import { MessageChannel } from "node:worker_threads"
import { XmlError } from "../core/xml/errors"
import { describe, expect, it } from "vitest"
import { PresentationError, refused, slideRef, type ShapeRef } from "../core/presentation/model"
import type { CompiledTimegraph } from "../core/anim/model"
import { servePresentation, type MethodHandler, type OpenCapability, type ServeOptions } from "../dom/presentation/engine"
import {
	PRESENTATION_METHODS,
	type BitmapLike,
	type FromPresentationWorker,
	type PortLike,
	type PresentationEvent,
	type PresentationMethod,
	type ToPresentationWorker
} from "../dom/presentation/protocol"
import { fixtureBody, fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"
import { fixtureTextLayout, fixtureTextPage } from "./fixtures/presentation/textPage"
import { CallRefused, loopback, LoopbackSession, type Loopback } from "./fixtures/presentation/loopback"

// The presentation protocol across a worker boundary (an in-thread loopback that structured-clones every message
// with its transferables moved): every message type, every method and every event arrives as sent, typed arrays and
// ports are transferred rather than copied, and refusals keep their reason.

const deckBytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)])

function fixtureOpener(password?: string): OpenCapability {
	return {
		open: request => {
			if (password !== undefined && request.password !== password) return Promise.resolve({ kind: "needsPassword" })

			return Promise.resolve({
				kind: "opened",
				deck: fixtureDeck(),
				package: {
					format: "pptx",
					variant: "pptx",
					bytes: request.source.size,
					source: request.source,
					sourceKind: request.sourceKind,
					locks: 1
				}
			})
		}
	}
}

function serve(options: ServeOptions = {}): { readonly channel: Loopback; readonly stop: () => void } {
	const channel = loopback()
	const stop = servePresentation(channel.worker, { openers: { pptx: fixtureOpener() }, ...options })

	return { channel, stop }
}

async function opened(
	session: LoopbackSession,
	channel: Loopback,
	message: Partial<Extract<ToPresentationWorker, { t: "open" }>> = {}
): Promise<PresentationEvent> {
	const event = session.nextEvent()

	channel.page.post({
		t: "open",
		s: session.s,
		source: { kind: "bytes", bytes: deckBytes.slice() },
		options: { format: "pptx", fileName: "Deck.pptx" },
		...message
	})

	return event
}

function port(): { readonly mine: PortLike; readonly theirs: PortLike } {
	const { port1, port2 } = new MessageChannel()

	return { mine: port1 as unknown as PortLike, theirs: port2 as unknown as PortLike }
}

// A stand-in for an ImageBitmap that structured clone can carry in Node (which has none).
function bitmap(width: number, height: number): BitmapLike {
	return { width, height } as unknown as BitmapLike
}

const shape: ShapeRef = { slide: slideRef(10), id: 2 }

const timegraph: CompiledTimegraph = {
	slide: slideRef(10),
	mainSteps: 2,
	interactive: [{ trigger: shape, seq: 1 }],
	tracks: [{ layer: 0, node: 5, attribute: "style.visibility", kind: "set" }]
}

// One handler per method, answering fixture values (or what it was asked), so each crosses both ways.
function echoHandlers(): { readonly [M in PresentationMethod]: MethodHandler<M> } {
	const deck = fixtureDeck()

	return {
		render: (_context, refs) => Promise.resolve(refs.map(ref => fixtureSlideRender(deck, deck.slides.indexOf(ref)))),
		thumbnails: (context, refs) => {
			context.session.emit({
				type: "thumbs",
				items: refs.map(ref => ({ slide: ref, revision: 0, bitmap: bitmap(192, 108) }))
			})

			return Promise.resolve()
		},
		textSeed: (_context, target) =>
			Promise.resolve({
				shape: target,
				revision: 3,
				body: fixtureBody(["Slide 1"]),
				resolved: [{ pPr: { algn: "l" }, runs: [{ sz: 4400 }] }],
				page: fixtureTextPage(["Slide 1"]),
				layout: fixtureTextLayout(["Slide 1"]),
				matrix: [1, 0, 0, 1, 88, 38]
			}),
		layoutText: (_context, _target, body) => {
			const texts = body.paragraphs.map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join(""))

			return Promise.resolve({ page: fixtureTextPage(texts), layout: fixtureTextLayout(texts), revision: 4 })
		},
		command: (_context, op) =>
			Promise.resolve(op.family === "slide" ? { ok: true, revision: 5, dirty: true } : { ok: false, refusal: "viewOnly" }),
		undo: (_context, open) =>
			Promise.resolve({
				ok: true,
				revision: 4,
				dirty: false,
				...(open === undefined
					? {}
					: {
							seed: {
								shape: open,
								revision: 4,
								body: fixtureBody(["Slide 1"]),
								resolved: [],
								page: fixtureTextPage(["Slide 1"]),
								layout: fixtureTextLayout(["Slide 1"]),
								matrix: [1, 0, 0, 1, 0, 0]
							}
						})
			}),
		redo: () => Promise.resolve({ ok: true, revision: 5, dirty: true }),
		retract: (_context, revision) => Promise.resolve({ ok: true, revision: revision + 1, dirty: false }),
		find: (_context, query) => Promise.resolve(new Int32Array([0, 2, 0, 0, query.length, 0])),
		media: (_context, part, media) => {
			media.postMessage({ part })

			return Promise.resolve({ size: 1024, contentType: "video/mp4", seekable: true })
		},
		registerMedia: () => Promise.resolve({ kind: "refused", reason: "notImplemented" }),
		image: (_context, part) =>
			Promise.resolve(part === "/ppt/media/image1.png" ? { bytes: new Uint8Array([0x89, 0x50]), type: "image/png" } : null),
		shade: (_context, meshes, scale, maxPixels) =>
			Promise.resolve(
				meshes.length === 0
					? null
					: { png: new Blob([Uint8Array.of(scale, maxPixels & 255)], { type: "image/png" }), bounds: [0, 0, 1, 1] as const }
			),
		smartArtPreview: (_context, _layout, options) => Promise.resolve(bitmap(options.widthPx, options.widthPx)),
		smartArtInfo: (_context, target) =>
			Promise.resolve({
				root: `doc${String(target.id)}`,
				nodes: [{ id: "a", level: 1, type: "node", text: "A" }],
				deckDefinitions: []
			}),
		chartData: () => Promise.resolve({ info: null, data: false }),
		timegraph: () => Promise.resolve(timegraph),
		layers: (_context, _slide, widthPx, plan) =>
			Promise.resolve(plan.shapes.map(id => ({ shape: id, bitmap: bitmap(widthPx, 10), x: 0, y: 0, width: widthPx, height: 10 }))),
		save: (context, options) => {
			context.session.emit({ type: "saveProgress", sent: 512, total: 1024 })
			options.port.postMessage({ chunk: 0 })

			return Promise.resolve({ kind: "written", bytes: 1024, revision: 5, notices: [{ kind: "saveReverted", ops: 0 }] })
		},
		commitSaved: (_context, options) => Promise.resolve({ dirty: options.revision < 6 }),
		jobsPort: (_context, jobs) => {
			jobs.postMessage({ serving: true })

			return Promise.resolve()
		},
		freshParts: (_context, target) =>
			Promise.resolve({ target, bytes: 2048, losses: [{ kind: "smartartAsGroup", count: 1, slides: [0] }] }),
		review: (_context, slide) =>
			Promise.resolve({
				slide,
				format: "modern",
				comments: [],
				notes: { slide: slideRef(30), id: 3 },
				notesText: "Speak slowly",
				can: { reply: true, resolve: true }
			})
	}
}

describe("the presentation protocol", () => {
	it("opens a deck and answers with its info", async () => {
		const { channel, stop } = serve()
		const session = new LoopbackSession(channel.page, 1)
		const event = await opened(session, channel)

		expect(event).toEqual({
			type: "opened",
			info: {
				format: "pptx",
				variant: "pptx",
				slides: [
					{ ref: slideRef(10), hidden: false },
					{ ref: slideRef(11), hidden: true },
					{ ref: slideRef(12), hidden: false }
				],
				layouts: [{ ref: slideRef(2), master: slideRef(1), type: "obj", name: "Title and Content" }],
				size: { cx: 12_192_000, cy: 6_858_000 },
				notesSize: { cx: 6_858_000, cy: 9_144_000 },
				sections: fixtureDeck().sections,
				customShows: [],
				show: fixtureDeck().show,
				// The deck sets no grid: PowerPoint's default, 1/12 inch with snapping on.
				grid: { cx: 76_200, cy: 76_200, snap: true },
				protection: { writeProtected: false, encrypted: false },
				gate: [],
				editable: true,
				locks: 1,
				packageBytes: deckBytes.length,
				source: "bytes",
				design: { themes: [{ master: slideRef(1), key: "/ppt/slideMasters/slideMaster1.xml", name: "Office Theme" }] }
			}
		})
		stop()
	})

	it("transfers the deck's bytes into the worker instead of copying them", async () => {
		const { channel, stop } = serve()
		const session = new LoopbackSession(channel.page, 1)
		const bytes = deckBytes.slice()

		await opened(session, channel, { source: { kind: "bytes", bytes } })

		expect(bytes.byteLength).toBe(0)
		stop()
	})

	it("round-trips every method with its arguments and answer", async () => {
		const { channel, stop } = serve({ handlers: echoHandlers() })
		const session = new LoopbackSession(channel.page, 1)

		await opened(session, channel)

		const deck = fixtureDeck()
		const renders = await session.call("render", [deck.slides[0] ?? slideRef(0)], { scale: 1 }).answer

		expect(renders).toEqual([fixtureSlideRender(deck, 0)])

		const thumbs = session.nextEvent()

		await session.call("thumbnails", [deck.slides[1] ?? slideRef(0)], 192).answer
		expect(await thumbs).toMatchObject({
			type: "thumbs",
			items: [{ slide: slideRef(11), revision: 0, bitmap: { width: 192, height: 108 } }]
		})

		const seed = await session.call("textSeed", shape).answer

		expect(seed.layout).toEqual(fixtureTextLayout(["Slide 1"]))
		expect(seed.page.styles[1]).toMatchObject({ paint: 1, outline: 0, effects: 0, alpha: 0.8 })

		const laid = await session.call("layoutText", shape, fixtureBody(["Edited title"]), 3).answer

		expect(laid.page.page.sourceTexts).toEqual(["Edited title"])
		expect(laid.revision).toBe(4)
		expect(await session.call("command", { family: "slide", kind: "hide", slides: [slideRef(10)], hidden: true }).answer).toEqual({
			ok: true,
			revision: 5,
			dirty: true
		})
		expect(await session.call("command", { family: "shape", kind: "delete", slide: slideRef(10), shapes: [4] }).answer).toEqual({
			ok: false,
			refusal: "viewOnly"
		})
		expect(await session.call("undo").answer).toEqual({ ok: true, revision: 4, dirty: false })

		const reseeded = await session.call("undo", shape).answer

		expect(reseeded.ok && reseeded.seed?.page.page.sourceTexts).toEqual(["Slide 1"])
		expect(await session.call("redo").answer).toEqual({ ok: true, revision: 5, dirty: true })
		expect(await session.call("retract", 4).answer).toEqual({ ok: true, revision: 5, dirty: false })
		expect(await session.call("image", "/ppt/media/image1.png").answer).toEqual({
			bytes: new Uint8Array([0x89, 0x50]),
			type: "image/png"
		})
		expect(await session.call("image", "/ppt/media/missing.png").answer).toBeNull()

		const mesh = { points: Float32Array.of(0, 0, 1, 0, 0, 1), colors: Uint32Array.of(1, 2, 3), ramp: null }
		const shaded = await session.call("shade", [mesh], 2, 1024).answer

		expect(shaded?.bounds).toEqual([0, 0, 1, 1])
		expect(Array.from(new Uint8Array((await shaded?.png.arrayBuffer()) ?? new ArrayBuffer(0)))).toEqual([2, 0])
		expect(await session.call("shade", [], 2, 1024).answer).toBeNull()
		expect(await session.call("smartArtPreview", { uniqueId: "urn:x", source: "gallery" }, { widthPx: 96 }).answer).toEqual({
			width: 96,
			height: 96
		})
		expect(await session.call("find", "point", { caseSensitive: true }).answer).toEqual(new Int32Array([0, 2, 0, 0, 5, 0]))

		const media = port()
		const mediaMessage = new Promise(resolve =>
			(media.mine as unknown as { once(event: string, listener: (value: unknown) => void): void }).once("message", resolve)
		)

		expect(await session.call("media", "/ppt/media/media1.mp4", media.theirs).answer).toEqual({
			size: 1024,
			contentType: "video/mp4",
			seekable: true
		})
		expect(await mediaMessage).toEqual({ part: "/ppt/media/media1.mp4" })
		expect(
			await session.call("registerMedia", {
				kind: "range",
				port: port().theirs,
				size: 1,
				checked: false,
				name: "a.mp4",
				type: "video/mp4"
			}).answer
		).toEqual({ kind: "refused", reason: "notImplemented" })
		expect(await session.call("smartArtInfo", shape).answer).toMatchObject({
			root: `doc${String(shape.id)}`,
			nodes: [{ id: "a", text: "A" }]
		})
		expect(await session.call("chartData", shape).answer).toEqual({ info: null, data: false })
		expect(await session.call("timegraph", slideRef(10)).answer).toEqual(timegraph)
		expect(await session.call("layers", slideRef(10), 1280, { shapes: [2, 3], dpr: 2 }).answer).toMatchObject([
			{ shape: 2, width: 1280 },
			{ shape: 3, width: 1280 }
		])

		const save = port()
		const progress = session.nextEvent()

		expect(await session.call("save", { reason: "user", port: save.theirs }).answer).toEqual({
			kind: "written",
			bytes: 1024,
			revision: 5,
			notices: [{ kind: "saveReverted", ops: 0 }]
		})
		expect(await progress).toEqual({ type: "saveProgress", sent: 512, total: 1024 })

		const commit = port()

		expect(
			await session.call("commitSaved", {
				file: { uuid: "6f1c2c8e", name: "Deck.pptx" },
				port: commit.theirs,
				size: 1024,
				revision: 5
			}).answer
		).toEqual({ dirty: true })

		const jobs = port()

		expect(await session.call("jobsPort", jobs.theirs).answer).toBeUndefined()

		const fresh = port()

		expect(await session.call("freshParts", "odp", fresh.theirs).answer).toEqual({
			target: "odp",
			bytes: 2048,
			losses: [{ kind: "smartartAsGroup", count: 1, slides: [0] }]
		})

		for (const end of [media, save, commit, jobs, fresh]) {
			end.mine.close()
		}

		expect(await session.call("review", slideRef(10)).answer).toEqual({
			slide: slideRef(10),
			format: "modern",
			comments: [],
			notes: { slide: slideRef(30), id: 3 },
			notesText: "Speak slowly",
			can: { reply: true, resolve: true }
		})

		const called = new Set(channel.toWorker.flatMap(message => (message.t === "call" ? [message.method] : [])))

		expect([...called].sort()).toEqual([...PRESENTATION_METHODS].sort())
		stop()
	})

	it("delivers every event type in the order the worker sent them", async () => {
		const events: PresentationEvent[] = [
			{ type: "fonts", faces: [{ kind: "local", face: { family: "fo-carlito", weight: 400, italic: false }, name: "Carlito" }] },
			{ type: "slides", renders: [fixtureSlideRender(fixtureDeck(), 0)], final: false },
			{ type: "thumbs", items: [{ slide: slideRef(10), revision: 1, bitmap: bitmap(192, 108) }] },
			{ type: "changed", revision: 2, dirty: true, slides: [slideRef(10)], info: { slides: [{ ref: slideRef(10), hidden: false }] } },
			{ type: "saveProgress", sent: 10 },
			{ type: "notice", notice: { kind: "gate", reason: "signed" } },
			{ type: "error", reason: "tooLarge", message: "slides" }
		]
		const { channel, stop } = serve({
			handlers: {
				render: context => {
					for (const event of events) context.session.emit(event)

					return Promise.resolve([])
				}
			}
		})
		// Plain data to compare with: the events' own typed arrays are transferred (detached) once sent.
		const plain = (value: unknown): unknown =>
			JSON.parse(JSON.stringify(value, (_key, item: unknown) => (ArrayBuffer.isView(item) ? [...(item as Uint8Array)] : item)))
		const expected = plain(events)
		const session = new LoopbackSession(channel.page, 1)

		await opened(session, channel)
		await session.call("render", []).answer

		expect(session.events.map(event => event.type)).toEqual(["opened", ...events.map(event => event.type)])
		expect(plain(session.events.slice(1))).toEqual(expected)
		stop()
	})

	it("refuses every method of a capability not built yet, typed", async () => {
		const { channel, stop } = serve()
		const session = new LoopbackSession(channel.page, 1)

		await opened(session, channel)

		const deck = fixtureDeck()
		const ports = () => port().theirs
		const calls: { readonly [M in PresentationMethod]: () => Promise<unknown> } = {
			render: () => session.call("render", deck.slides).answer,
			thumbnails: () => session.call("thumbnails", deck.slides, 192).answer,
			textSeed: () => session.call("textSeed", shape).answer,
			layoutText: () => session.call("layoutText", shape, fixtureBody(["x"])).answer,
			command: () => session.call("command", { family: "slide", kind: "reset", slide: slideRef(10) }).answer,
			undo: () => session.call("undo").answer,
			redo: () => session.call("redo").answer,
			retract: () => session.call("retract", 1).answer,
			find: () => session.call("find", "x").answer,
			media: () => session.call("media", "/ppt/media/media1.mp4", ports()).answer,
			registerMedia: () =>
				session.call("registerMedia", { kind: "range", port: ports(), size: 1, checked: false, name: "a.mp4", type: "video/mp4" })
					.answer,
			timegraph: () => session.call("timegraph", slideRef(10)).answer,
			layers: () => session.call("layers", slideRef(10), 1280, { shapes: [], dpr: 1 }).answer,
			save: () => session.call("save", { reason: "auto", port: ports() }).answer,
			commitSaved: () => session.call("commitSaved", { file: { uuid: "u", name: "n" }, port: ports(), size: 1, revision: 1 }).answer,
			image: () => session.call("image", "/ppt/media/image1.png").answer,
			shade: () =>
				session.call("shade", [{ points: Float32Array.of(0, 0, 1, 0, 0, 1), colors: Uint32Array.of(1, 2, 3), ramp: null }], 1, 1024)
					.answer,
			smartArtPreview: () => session.call("smartArtPreview", { uniqueId: "urn:x", source: "gallery" }, { widthPx: 96 }).answer,
			smartArtInfo: () => session.call("smartArtInfo", shape).answer,
			chartData: () => session.call("chartData", shape).answer,
			jobsPort: () => session.call("jobsPort", ports()).answer,
			freshParts: () => session.call("freshParts", "pptx", ports()).answer,
			review: () => session.call("review", slideRef(10)).answer
		}

		// Built by their slices: edits (command, undo, redo), saving (save, commitSaved), find, the SmartArt text pane's
		// info, shaded rasters, the jobs port, and registerMedia (it answers a typed MediaRefusal value: this host serves no range sources).
		const built: ReadonlySet<PresentationMethod> = new Set([
			"command",
			"undo",
			"redo",
			"retract",
			"save",
			"commitSaved",
			"find",
			"smartArtInfo",
			"shade",
			"registerMedia",
			"chartData",
			"jobsPort",
			"jobsPort",
			"freshParts",
			"review"
		])

		for (const method of PRESENTATION_METHODS.filter(method => !built.has(method))) {
			const error: unknown = await calls[method]().then(
				() => undefined,
				(reason: unknown) => reason
			)

			expect(error, method).toBeInstanceOf(CallRefused)
			expect((error as CallRefused).reason, method).toBe("notImplemented")
		}

		stop()
	})

	it("runs each call in its lane with a slicing, and background work on the session's scheduler", async () => {
		const seen: { method: string; lane: string; sliceMs: number }[] = []
		let ranTask = false
		const { channel, stop } = serve({
			handlers: {
				command: context => {
					seen.push({ method: "command", lane: context.lane, sliceMs: context.slicing.sliceMs })

					return Promise.resolve({ ok: true, revision: 1, dirty: true })
				},
				find: context => {
					seen.push({ method: "find", lane: context.lane, sliceMs: context.slicing.sliceMs })
					context.session.schedule("background", async slicing => {
						await slicing.pause()
						ranTask = true
					})

					return Promise.resolve(new Int32Array(0))
				}
			}
		})
		const session = new LoopbackSession(channel.page, 1)

		await opened(session, channel)
		await session.call("command", { family: "slide", kind: "reset", slide: slideRef(10) }).answer
		await session.call("find", "x").answer
		await new Promise(resolve => setTimeout(resolve, 5))

		expect(seen).toEqual([
			{ method: "command", lane: "priority", sliceMs: 8 },
			{ method: "find", lane: "background", sliceMs: 8 }
		])
		expect(ranTask).toBe(true)
		stop()
	})

	it("answers a thrown refusal with its reason, a part that is not well-formed as malformed, and any other failure as failed", async () => {
		const { channel, stop } = serve({
			handlers: {
				undo: () => Promise.reject(new PresentationError("locked", "the body is being edited")),
				redo: () => Promise.reject(new Error("boom")),
				retract: () => Promise.reject(new XmlError("invalidReference", "Invalid character reference", 12))
			}
		})
		const session = new LoopbackSession(channel.page, 1)

		await opened(session, channel)
		await expect(session.call("undo").answer).rejects.toMatchObject({ reason: "locked", message: "the body is being edited" })
		await expect(session.call("redo").answer).rejects.toMatchObject({ reason: "failed", message: "boom" })
		await expect(session.call("retract", 1).answer).rejects.toMatchObject({ reason: "malformed" })
		stop()
	})

	it("aborts a call: the page gets aborted at once and the late answer is dropped", async () => {
		let finish: (() => void) | undefined
		let heardAbort = false
		const { channel, stop } = serve({
			handlers: {
				find: context => {
					context.signal.onAbort(() => {
						heardAbort = true
					})

					return new Promise(resolve => {
						finish = () => resolve(new Int32Array(0))
					})
				}
			}
		})
		const session = new LoopbackSession(channel.page, 1)

		await opened(session, channel)

		const { id, answer } = session.call("find", "slow")

		await new Promise(resolve => setTimeout(resolve, 0))
		channel.page.post({ t: "abort", s: 1, id })

		await expect(answer).rejects.toMatchObject({ reason: "aborted" })
		expect(heardAbort).toBe(true)
		finish?.()
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(channel.fromWorker.filter(message => message.t === "result")).toEqual([])
		stop()
	})

	it("asks for a password, refuses a wrong one and opens with the right one", async () => {
		const { channel, stop } = serve({ openers: { pptx: fixtureOpener("secret") } })
		const session = new LoopbackSession(channel.page, 1)

		expect(await opened(session, channel)).toMatchObject({ type: "error", reason: "needsPassword" })

		let next = session.nextEvent()

		channel.page.post({ t: "unlock", s: 1, password: "wrong" })
		expect(await next).toMatchObject({ type: "error", reason: "wrongPassword" })
		next = session.nextEvent()
		channel.page.post({ t: "unlock", s: 1, password: "secret" })
		expect(await next).toMatchObject({ type: "opened" })
		stop()
	})

	it("aborts an open in flight", async () => {
		let release: (() => void) | undefined
		const { channel, stop } = serve({
			openers: {
				pptx: {
					open: request =>
						new Promise(resolve => {
							release = () =>
								resolve({
									kind: "opened",
									deck: fixtureDeck(),
									package: {
										format: "pptx",
										variant: "pptx",
										bytes: 1,
										source: request.source,
										sourceKind: "bytes",
										locks: 0
									}
								})
						})
				}
			}
		})
		const session = new LoopbackSession(channel.page, 1)
		const event = opened(session, channel)

		await new Promise(resolve => setTimeout(resolve, 0))
		channel.page.post({ t: "abortOpen", s: 1 })
		expect(await event).toMatchObject({ type: "error", reason: "aborted" })
		release?.()
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(session.events.map(item => item.type)).toEqual(["error"])
		stop()
	})

	it("refuses calls on a disposed session as closed", async () => {
		const { channel, stop } = serve({ handlers: echoHandlers() })
		const session = new LoopbackSession(channel.page, 1)

		await opened(session, channel)
		channel.page.post({ t: "dispose", s: 1 })
		await expect(session.call("undo").answer).rejects.toMatchObject({ reason: "closed" })
		stop()
	})

	it("reports an opener's refusal and a range source no host serves", async () => {
		const { channel, stop } = serve({ openers: { pptx: { open: () => Promise.resolve(refused("rightsManaged", "IRM")) } } })
		const first = new LoopbackSession(channel.page, 1)

		expect(await opened(first, channel)).toEqual({ type: "error", reason: "rightsManaged", message: "IRM" })

		const second = new LoopbackSession(channel.page, 2)
		const range = port()

		expect(await opened(second, channel, { source: { kind: "range", port: range.theirs, size: 10, checked: false } })).toMatchObject({
			type: "error",
			reason: "notImplemented"
		})
		range.mine.close()
		stop()
	})

	it("refuses bytes that are no presentation in every reader, typed (never notImplemented)", async () => {
		const channel = loopback()
		const stop = servePresentation(channel.worker)

		for (const [s, format] of [
			[2, "odp"],
			[3, "ppt"]
		] as const) {
			const session = new LoopbackSession(channel.page, s)
			const event = await opened(session, channel, { options: { format, fileName: `Deck.${format}` } })

			expect(event).toMatchObject({ type: "error" })
			expect(event).not.toMatchObject({ reason: "notImplemented" })
		}

		stop()
	})

	it("carries every message type across the boundary", async () => {
		const { channel, stop } = serve({ handlers: echoHandlers() })
		const session = new LoopbackSession(channel.page, 1)

		await opened(session, channel)
		await session.call("undo").answer
		channel.page.post({ t: "abort", s: 1, id: 999 })
		channel.page.post({ t: "abortOpen", s: 1 })
		channel.page.post({ t: "unlock", s: 7, password: "x" })
		channel.page.post({ t: "dispose", s: 1 })
		await session.call("redo").answer.catch(() => undefined)

		const toTypes = new Set(channel.toWorker.map(message => message.t))
		const fromTypes = new Set(channel.fromWorker.map((message: FromPresentationWorker) => message.t))

		expect([...toTypes].sort()).toEqual(["abort", "abortOpen", "call", "dispose", "open", "unlock"])
		expect([...fromTypes].sort()).toEqual(["event", "refused", "result"])
		stop()
	})
})
