// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type SlideMediaInfo } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection, type PresentationStore } from "@filen/office/react/presentation"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import { PresentationMediaFrames } from "@/features/presentation/components/mediaFrame"
import { insertMediaGroups } from "@/features/presentation/components/ribbon/insertMedia"
import { videoGroups } from "@/features/presentation/components/ribbon/video"
import { audioGroups } from "@/features/presentation/components/ribbon/audio"
import { presentationTabs, type PresentationGroups, type PresentationRibbonContext } from "@/features/presentation/components/ribbon/tabs"
import { mediaBox, mediaStreams } from "@/features/presentation/hooks/useMediaInsert"
import "@/lib/i18n"

// Media on slides, the page's side: the play control over a medium fetches nothing until pressed; the Video and Audio
// tabs set playback as one op each on the selected medium and show what it has; Insert ▸ Media offers both sources.

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2000, height: 40 }) }))
// The service worker's registration, as far as the page's side goes: the open callback serves the port it is given;
// holds on the worker's life are counted.
const alive = vi.hoisted(() => ({ held: 0, released: 0 }))

vi.mock("@/features/preview/lib/previewStream", () => ({
	holdPreviewStreamAlive: () => {
		alive.held++

		return () => {
			alive.released++
		}
	},
	registerPortStream: async (id: string, open: (port: MessagePort) => Promise<unknown>) => {
		await open(new MessageChannel().port1)

		return `/sw/preview/${id}`
	},
	releasePreviewStream: () => undefined,
	previewStreamUrl: () => Promise.reject(new Error("no service worker")),
	previewStreamIdOf: (url: string) => url
}))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const EMU = 9525
const ref = slideRef(256)

function layerOf(id: number, media: SlideMediaInfo | undefined, alt?: string): SlideLayer {
	return {
		shape: { slide: ref, id },
		role: "picture",
		drawing: { width: 320, height: 180 },
		matrix: [1, 0, 0, 1, 40, 30],
		box: { id, xfrm: { x: 40 * EMU, y: 30 * EMU, cx: 320 * EMU, cy: 180 * EMU, rot: 0, flipH: false, flipV: false } },
		...(alt === undefined ? {} : { alt }),
		...(media === undefined ? {} : { media })
	} as unknown as SlideLayer
}

function renderOf(layers: readonly SlideLayer[]): SlideRender {
	return { ref, index: 0, revision: 1, hidden: false, background: {}, layers, notesText: "", animated: false } as unknown as SlideRender
}

const VIDEO: SlideMediaInfo = {
	kind: "video",
	part: "/ppt/media/media1.mp4",
	contentType: "video/mp4",
	playback: { volume: 50_000, loop: true }
}
const AUDIO: SlideMediaInfo = { kind: "audio", part: "/ppt/media/media2.mp3", contentType: "audio/mpeg" }

const INFO = {
	slides: [{ ref, hidden: false }],
	size: { cx: 960 * EMU, cy: 540 * EMU },
	customShows: [],
	editable: true
} as unknown as OpenInfo

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

describe("media frames over the slide", () => {
	it("shows a named play control and fetches nothing before it is pressed", async () => {
		const media = vi.fn(() => Promise.resolve({ kind: "refused" as const, reason: "notFound" as const }))
		const session = { media } as unknown as PresentationSessionApi

		render(
			<PresentationMediaFrames
				render={renderOf([layerOf(4, VIDEO, "Intro clip"), layerOf(5, undefined)])}
				session={session}
				scale={1}
				notices={[]}
			/>
		)

		const play = screen.getByRole("button", { name: "Play Intro clip" })

		expect(screen.getAllByRole("button")).toHaveLength(1)
		expect(media).not.toHaveBeenCalled()

		fireEvent.click(play)

		// The worker could not serve it: the frame says so.
		expect(await screen.findByText("This media isn't available.")).toBeTruthy()
		expect(media).toHaveBeenCalledTimes(1)
	})

	it("puts the play control in the layer above the editor's selection layer, where a press reaches it", async () => {
		const media = vi.fn(() => Promise.resolve({ kind: "refused" as const, reason: "notFound" as const }))
		const session = { media } as unknown as PresentationSessionApi
		const above = document.createElement("div")
		const selection = document.createElement("div")

		document.body.append(selection, above)
		render(
			<PresentationMediaFrames
				render={renderOf([layerOf(4, VIDEO, "Intro clip")])}
				session={session}
				scale={0.5}
				notices={[]}
				controlsHost={above}
			/>
		)

		const play = within(above).getByRole("button", { name: "Play Intro clip" })

		fireEvent.click(play)

		expect(await screen.findByText("This media isn't available.")).toBeTruthy()
		// The medium itself stays under the selection layer, in place.
		expect(above.querySelector("[data-fo-media-box]")).toBeNull()
		above.remove()
		selection.remove()
	})

	it("offers a linked web video as a link through the deck's activator, never fetching it", () => {
		const media = vi.fn()
		const action = vi.fn(() => "confirming" as const)
		const linked: SlideMediaInfo = { kind: "video", external: "https://example.com/talk", contentType: "video/unknown" }

		render(
			<PresentationMediaFrames
				render={renderOf([layerOf(4, linked, "Talk")])}
				session={{ media } as unknown as PresentationSessionApi}
				scale={1}
				notices={[]}
				actions={{ action, link: () => "inert" }}
			/>
		)

		expect(screen.queryByRole("button", { name: "Play Talk" })).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Open link" }))

		expect(action).toHaveBeenCalledWith(
			{ kind: "url", href: "https://example.com/talk" },
			{ via: "click", mode: "view", modifier: false, shape: { slide: ref, id: 4 } }
		)
		expect(media).not.toHaveBeenCalled()
	})

	it("shows the preparation's progress of a deflated medium", async () => {
		const session = { media: () => Promise.resolve({ kind: "refused", reason: "preparing" }) } as unknown as PresentationSessionApi

		render(
			<PresentationMediaFrames
				render={renderOf([layerOf(4, VIDEO, "Intro clip")])}
				session={session}
				scale={1}
				notices={[{ kind: "media", part: "/ppt/media/media1.mp4", reason: "preparing", progress: 0.4 }]}
			/>
		)

		fireEvent.click(screen.getByRole("button", { name: "Play Intro clip" }))

		await waitFor(() => {
			expect(screen.getByRole("status").textContent).toMatch(/Preparing media/u)
		})
	})
})

function ribbon(groups: PresentationGroups, layers: readonly SlideLayer[] | undefined, selected: readonly number[]): DeckOp[] {
	const ops: DeckOp[] = []
	const selection = createShapeSelection()

	selection.show(ref)
	selection.set(selected)

	const context: PresentationRibbonContext = {
		editable: true,
		phone: false,
		selection: new Set(["video"]),
		t: i18n.t.bind(i18n),
		editor: {
			info: INFO,
			render: layers === undefined ? undefined : renderOf(layers),
			selection,
			session: {} as PresentationSessionApi,
			command: (op: DeckOp): Promise<CommandResult> => {
				ops.push(op)

				return Promise.resolve({ ok: true, revision: ops.length, dirty: true })
			}
		}
	}

	render(
		<OfficeRibbon
			label="Ribbon"
			commandsLabel="Commands"
			tabs={[{ id: "video", label: "Video" }]}
			tab="video"
			onTab={() => undefined}
			file={null}
			groups={groups(context)}
		/>
	)

	return ops
}

describe("media streams", () => {
	it("keeps the service worker alive while a medium's stream is registered", async () => {
		alive.held = 0
		alive.released = 0

		const session = {
			media: () => Promise.resolve({ size: 1000, contentType: "video/mp4", seekable: true })
		} as unknown as PresentationSessionApi
		const stream = await mediaStreams(undefined, undefined).url(session, VIDEO)

		expect(stream.kind).toBe("url")
		expect(alive).toEqual({ held: 1, released: 0 })

		if (stream.kind === "url") stream.release()

		expect(alive).toEqual({ held: 1, released: 1 })

		// A refused stream lets go of its hold at once.
		const refused = { media: () => Promise.resolve({ kind: "refused", reason: "preparing" }) } as unknown as PresentationSessionApi

		expect(await mediaStreams(undefined, undefined).url(refused, VIDEO)).toEqual({ kind: "refused", reason: "preparing" })
		expect(alive).toEqual({ held: 2, released: 2 })
	})

	it("follows a preparing medium's progress through the deck's store", () => {
		const listeners = new Set<() => void>()
		let notices: unknown[] = [{ kind: "media", part: "/ppt/media/media1.mp4", reason: "preparing", progress: 0.3 }]
		const store = {
			getSnapshot: () => ({ notices }),
			subscribe: (listener: () => void) => {
				listeners.add(listener)

				return () => listeners.delete(listener)
			}
		} as unknown as PresentationStore
		const seen: number[] = []
		const off = mediaStreams(undefined, undefined, store).prepared?.(VIDEO, progress => seen.push(progress))

		notices = [...notices, { kind: "media", part: "/ppt/media/media1.mp4", reason: "preparing", progress: 1 }]

		for (const listener of listeners) listener()

		expect(seen).toEqual([0.3, 1])

		off?.()

		expect(listeners.size).toBe(0)
	})
})

describe("the Video and Audio tabs", () => {
	it("sets looping, hiding and full screen of the selected video as one op each, showing what it has", () => {
		const ops = ribbon(videoGroups, [layerOf(4, VIDEO)], [4])
		const commands = screen.getByRole("toolbar", { name: "Commands" })
		const loop = within(commands).getByRole("button", { name: "Loop until stopped" })

		expect(loop.getAttribute("aria-pressed")).toBe("true")

		fireEvent.click(loop)
		fireEvent.click(within(commands).getByRole("button", { name: "Hide while not playing" }))
		fireEvent.click(within(commands).getByRole("button", { name: "Play full screen" }))

		expect(ops).toEqual([
			{ family: "media", kind: "setPlayback", target: { slide: ref, id: 4 }, playback: { loop: false } },
			{ family: "media", kind: "setPlayback", target: { slide: ref, id: 4 }, playback: { hideWhenStopped: true } },
			{ family: "media", kind: "setPlayback", target: { slide: ref, id: 4 }, playback: { fullScreen: true } }
		])
	})

	it("sets the volume from its menu", async () => {
		const ops = ribbon(videoGroups, [layerOf(4, VIDEO)], [4])

		fireEvent.click(within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("button", { name: "Volume" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Mute" }))

		expect(ops).toEqual([{ family: "media", kind: "setPlayback", target: { slide: ref, id: 4 }, playback: { mute: true } }])
	})

	it("has no full screen for audio, and nothing to act on when the selection is no medium", () => {
		ribbon(audioGroups, [layerOf(4, AUDIO)], [4])

		const commands = screen.getByRole("toolbar", { name: "Commands" })

		expect(within(commands).queryByRole("button", { name: "Play full screen" })).toBeNull()
		expect(within(commands).getByRole("button", { name: "Loop until stopped" }).hasAttribute("disabled")).toBe(false)

		cleanup()
		ribbon(audioGroups, [layerOf(4, undefined)], [4])
		expect(
			within(screen.getByRole("toolbar", { name: "Commands" }))
				.getByRole("button", { name: "Loop until stopped" })
				.hasAttribute("disabled")
		).toBe(true)
	})

	it("is shown for a selected video or audio clip", () => {
		const base = { editable: true, phone: false, t: i18n.t.bind(i18n) }

		expect(presentationTabs({ ...base, selection: new Set(["video"]) }).map(tab => tab.id)).toContain("video")
		expect(presentationTabs({ ...base, selection: new Set(["audio"]) }).map(tab => tab.id)).toContain("audio")
		expect(presentationTabs({ ...base, selection: new Set(["picture"]) }).map(tab => tab.id)).not.toContain("video")
	})
})

describe("Insert ▸ Media", () => {
	it("offers video and audio from this device and from the drive", async () => {
		ribbon(insertMediaGroups, [], [])

		fireEvent.click(within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("button", { name: "Video" }))

		expect(await screen.findByRole("menuitem", { name: "From this device…" })).toBeTruthy()
		expect(screen.getByRole("menuitem", { name: "From Filen…" })).toBeTruthy()
	})

	it("offers video and audio with nothing selected, onto the slide in view", async () => {
		// The ribbon's render reaches it only while shapes are selected; the slide in view is the selection store's.
		ribbon(insertMediaGroups, undefined, [])

		const video = within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("button", { name: "Video" })

		expect(video.hasAttribute("disabled") || video.getAttribute("aria-disabled") === "true").toBe(false)
		fireEvent.click(video)
		expect(await screen.findByRole("menuitem", { name: "From this device…" })).toBeTruthy()
	})

	it("places a new video within 60% of the slide at its aspect, centred, and audio as a half-inch icon", () => {
		const slide = { cx: 960 * EMU, cy: 540 * EMU }

		expect(mediaBox(slide, "video", 1920, 1080)).toEqual({
			x: 192 * EMU,
			y: 108 * EMU,
			cx: 576 * EMU,
			cy: 324 * EMU,
			rot: 0,
			flipH: false,
			flipV: false
		})
		expect(mediaBox(slide, "audio", 256, 256)).toMatchObject({ cx: 457_200, cy: 457_200 })
	})
})
