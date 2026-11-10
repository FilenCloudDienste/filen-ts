// @vitest-environment happy-dom

import "@/tests/support/officeKeys"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type SlideMediaInfo } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection, noteMediaDuration } from "@filen/office/react/presentation"
import { exposeRangePort } from "@/lib/media/rangePort"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import { distinctShapeNames } from "@/features/presentation/components/ribbon/animations"
import { audioGroups } from "@/features/presentation/components/ribbon/audio"
import {
	BookmarkTriggerItems,
	bookmarkTriggerOf,
	bookmarkTriggerValue,
	parseMediaSeconds,
	readMediaDuration
} from "@/features/presentation/components/ribbon/mediaTiming"
import type { PresentationGroups, PresentationRibbonContext } from "@/features/presentation/components/ribbon/tabs"
import { videoGroups } from "@/features/presentation/components/ribbon/video"
import "@/lib/i18n"

// The Video and Audio tabs' Editing and Bookmarks groups: Trim and Fade set two durations as one op from a dialog,
// Add bookmark suggests a free name and refuses a taken name or time, Remove bookmark lists the clip's bookmarks; and
// the Animations ▸ Trigger menu's bookmark items name each clip's bookmarks on the slide.

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2000, height: 40 }) }))
// The page's media streams: none here (a clip whose length the player has not learnt cannot be read).
vi.mock("@/features/presentation/hooks/useMediaInsert", async original => ({
	...(await original<Record<string, unknown>>()),
	mediaStreams: () => ({ url: () => Promise.resolve({ kind: "refused", reason: "notFound" }) })
}))

const EMU = 9525
const ref = slideRef(256)

function layerOf(id: number, media: SlideMediaInfo | undefined): SlideLayer {
	return {
		shape: { slide: ref, id },
		role: "picture",
		drawing: { width: 320, height: 180 },
		matrix: [1, 0, 0, 1, 40, 30],
		box: { id, xfrm: { x: 40 * EMU, y: 30 * EMU, cx: 320 * EMU, cy: 180 * EMU, rot: 0, flipH: false, flipV: false } },
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
	timing: {
		trim: { startMs: 1500, endMs: 250 },
		bookmarks: [
			{ name: "Bookmark 1", timeMs: 750 },
			{ name: "Chorus", timeMs: 4000 }
		]
	}
}
const AUDIO: SlideMediaInfo = { kind: "audio", part: "/ppt/media/media2.mp3", contentType: "audio/mpeg" }

const INFO = {
	format: "pptx",
	slides: [{ ref, hidden: false }],
	size: { cx: 960 * EMU, cy: 540 * EMU },
	customShows: [],
	editable: true
} as unknown as OpenInfo

let session = {} as PresentationSessionApi

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

function ribbon(
	groups: PresentationGroups,
	layers: readonly SlideLayer[],
	selected: readonly number[],
	info: OpenInfo = INFO,
	duration?: (session: PresentationSessionApi) => void
): DeckOp[] {
	const ops: DeckOp[] = []
	const selection = createShapeSelection()

	session = {} as PresentationSessionApi
	duration?.(session)
	selection.show(ref)
	selection.set(selected)

	const context: PresentationRibbonContext = {
		editable: true,
		phone: false,
		selection: new Set(["video"]),
		t: i18n.t.bind(i18n),
		editor: {
			info,
			render: renderOf(layers),
			selection,
			session,
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

function commands(): HTMLElement {
	return screen.getByRole("toolbar", { name: "Commands" })
}

describe("media times as typed", () => {
	it("reads seconds, decimal commas and minutes, and nothing else", () => {
		expect(["1.5", "1,5", "2 s", "1:05.5", "1:00:00", "0"].map(parseMediaSeconds)).toEqual([1.5, 1.5, 2, 65.5, 3600, 0])
		expect(["", "-1", "abc", "1:2:3:4", "1e3", "25:00:00"].map(parseMediaSeconds)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined
		])
	})
})

describe("the Editing and Bookmarks groups", () => {
	it("trims the selected video by its start and end times within the clip's length, stored as the cuts", async () => {
		const ops = ribbon(videoGroups, [layerOf(4, VIDEO)], [4], INFO, known => {
			// The player learnt the clip's length (10 s) when it loaded it.
			noteMediaDuration(known, "/ppt/media/media1.mp4", 10)
		})
		const trim = within(commands()).getByRole("button", { name: "Trim" })

		expect(trim.getAttribute("aria-pressed")).toBe("true")

		fireEvent.click(trim)

		const start = await screen.findByLabelText<HTMLInputElement>("Start time (seconds)")
		const end = screen.getByLabelText<HTMLInputElement>("End time (seconds)")

		expect([start.value, end.value]).toEqual(["1.5", "9.75"])
		expect(screen.getByText(/The clip is 10 s long/u)).toBeTruthy()

		// Nothing is said while typing ("1." on the way to "1.5", a cleared field).
		fireEvent.change(end, { target: { value: "1." } })
		fireEvent.change(end, { target: { value: "" } })
		expect(screen.queryByRole("alert")).toBeNull()

		// Past the clip's end, once the field is left: in the clip's own length, linked to the field.
		fireEvent.change(end, { target: { value: "99999" } })
		fireEvent.blur(end)

		const beyond = screen.getByText("Enter a time within the clip's 10 s")

		expect(end.getAttribute("aria-describedby")).toBe(beyond.id)

		// Not after the start: held back on Apply, with the reason.
		fireEvent.change(end, { target: { value: "1" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(screen.getByText("The end time must come after the start time")).toBeTruthy()
		expect(ops).toEqual([])

		fireEvent.change(end, { target: { value: "9.75" } })
		fireEvent.change(start, { target: { value: "2,25" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))

		// The end left as shown keeps its cut exactly.
		expect(ops).toEqual([{ family: "mediaTiming", kind: "setTrim", target: { slide: ref, id: 4 }, startMs: 2250, endMs: 250 }])

		cleanup()

		const again = ribbon(videoGroups, [layerOf(4, VIDEO)], [4], INFO, known => {
			noteMediaDuration(known, "/ppt/media/media1.mp4", 10)
		})

		fireEvent.click(within(commands()).getByRole("button", { name: "Trim" }))
		fireEvent.change(await screen.findByLabelText("End time (seconds)"), { target: { value: "8" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))

		expect(again).toEqual([{ family: "mediaTiming", kind: "setTrim", target: { slide: ref, id: 4 }, startMs: 1500, endMs: 2000 }])
	})

	it("asks for the cuts from each end when the clip's length cannot be read", async () => {
		const ops = ribbon(videoGroups, [layerOf(4, VIDEO)], [4])

		fireEvent.click(within(commands()).getByRole("button", { name: "Trim" }))

		const start = await screen.findByLabelText<HTMLInputElement>("Cut from the start (seconds)")

		expect(screen.getByText("The clip's length couldn't be read, so enter how much to cut from each end.")).toBeTruthy()
		expect(start.value).toBe("1.5")
		expect(screen.getByLabelText<HTMLInputElement>("Cut from the end (seconds)").value).toBe("0.25")

		fireEvent.change(start, { target: { value: "2,25" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))

		expect(ops).toEqual([{ family: "mediaTiming", kind: "setTrim", target: { slide: ref, id: 4 }, startMs: 2250, endMs: 250 }])
	})

	it("sets the fade of the selected audio clip and holds an invalid time back", async () => {
		const ops = ribbon(audioGroups, [layerOf(7, AUDIO)], [7])

		fireEvent.click(within(commands()).getByRole("button", { name: "Fade" }))

		const fadeIn = await screen.findByLabelText("Fade in (seconds)")

		fireEvent.change(fadeIn, { target: { value: "-1" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(screen.getByText("Enter seconds from 0 to 86400")).toBeTruthy()
		expect(ops).toEqual([])

		fireEvent.change(fadeIn, { target: { value: "1" } })
		fireEvent.change(screen.getByLabelText("Fade out (seconds)"), { target: { value: "0.5" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))

		expect(ops).toEqual([{ family: "mediaTiming", kind: "setFade", target: { slide: ref, id: 7 }, inMs: 1000, outMs: 500 }])
	})

	it("adds a bookmark under a free name and refuses a taken name or time", async () => {
		const ops = ribbon(videoGroups, [layerOf(4, VIDEO)], [4])

		fireEvent.click(within(commands()).getByRole("button", { name: "Add bookmark" }))

		const name = await screen.findByLabelText("Name")
		const dialog = screen.getByRole("dialog")
		const add = within(dialog).getByRole("button", { name: "Add bookmark" })

		// "Bookmark 1" is taken: the next number.
		expect((name as HTMLInputElement).value).toBe("Bookmark 3")

		fireEvent.change(name, { target: { value: "Chorus" } })
		fireEvent.blur(name)
		expect(screen.getByText("Another bookmark has this name")).toBeTruthy()

		// An empty name says why it cannot be added.
		fireEvent.change(name, { target: { value: " " } })
		fireEvent.click(add)
		expect(screen.getByText("Enter a name of up to 255 characters")).toBeTruthy()

		fireEvent.change(name, { target: { value: "Bridge" } })
		fireEvent.change(screen.getByLabelText("Time from the start (seconds)"), { target: { value: "4" } })
		fireEvent.click(add)
		expect(screen.getByText("Another bookmark is at this time")).toBeTruthy()
		expect(ops).toEqual([])

		fireEvent.change(screen.getByLabelText("Time from the start (seconds)"), { target: { value: "0:06" } })
		fireEvent.click(add)

		expect(ops).toEqual([{ family: "mediaTiming", kind: "addBookmark", target: { slide: ref, id: 4 }, name: "Bridge", timeMs: 6000 }])
	})

	it("says a clip's list is full, and keeps Add bookmark off", async () => {
		const bookmarks = Array.from({ length: 256 }, (_, k) => ({ name: `B${String(k)}`, timeMs: k }))

		ribbon(videoGroups, [layerOf(4, { ...VIDEO, timing: { bookmarks } })], [4])
		fireEvent.click(within(commands()).getByRole("button", { name: "Add bookmark" }))

		expect(await screen.findByText("This clip already has 256 bookmarks, the most it can hold")).toBeTruthy()
		expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Add bookmark" }).hasAttribute("disabled")).toBe(true)
	})

	it("says once that the clip's length is being read", async () => {
		const streams = await import("@/features/presentation/hooks/useMediaInsert")
		const never = vi.spyOn(streams, "mediaStreams").mockReturnValue({ url: () => new Promise(() => undefined) } as never)

		ribbon(videoGroups, [layerOf(4, VIDEO)], [4])
		fireEvent.click(within(commands()).getByRole("button", { name: "Trim" }))

		expect(await screen.findByRole("status")).toBeTruthy()
		expect(screen.getAllByText("Reading the clip's length…")).toHaveLength(1)
		expect(screen.getByText("The part of the clip that plays.")).toBeTruthy()

		never.mockRestore()
	})

	it("keeps a bookmark an animation's trigger names, saying why, with no other message", async () => {
		const ops = ribbon(videoGroups, [layerOf(4, { ...VIDEO, triggered: ["Chorus"] })], [4])

		fireEvent.click(within(commands()).getByRole("button", { name: "Remove bookmark" }))

		const used = await screen.findByRole("menuitem", {
			name: "Chorus (4 s): Used by an animation's trigger. Change the trigger first."
		})

		expect(used.getAttribute("aria-disabled")).toBe("true")

		fireEvent.click(used)
		expect(ops).toEqual([])
	})

	it("removes a bookmark from the clip's list", async () => {
		const ops = ribbon(videoGroups, [layerOf(4, VIDEO)], [4])

		fireEvent.click(within(commands()).getByRole("button", { name: "Remove bookmark" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Chorus (4 s)" }))

		expect(ops).toEqual([{ family: "mediaTiming", kind: "removeBookmark", target: { slide: ref, id: 4 }, name: "Chorus" }])
	})

	it("shows its commands off in an OpenDocument deck, saying why", () => {
		ribbon(videoGroups, [layerOf(4, VIDEO)], [4], { ...INFO, format: "odp" })

		for (const name of ["Trim", "Fade", "Add bookmark", "Remove bookmark"]) {
			const button = within(commands()).getByRole("button", {
				name: `${name}: Trim, fade and bookmarks can only be set in PowerPoint (.pptx) presentations`
			})

			expect(button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true").toBe(true)
		}
	})

	it("has nothing to act on when the selection is no medium", () => {
		ribbon(videoGroups, [layerOf(4, undefined)], [4])

		for (const name of ["Trim", "Fade", "Add bookmark", "Remove bookmark"])
			expect(within(commands()).getByRole("button", { name }).hasAttribute("disabled")).toBe(true)
	})
})

describe("a clip's length", () => {
	it("reuses what the player learnt, without streaming the clip again", async () => {
		const known = {} as PresentationSessionApi
		const url = vi.fn()

		noteMediaDuration(known, "/ppt/media/media1.mp4", 12.3456)

		expect(await readMediaDuration(known, VIDEO, { url })).toBe(12_346)
		expect(url).not.toHaveBeenCalled()
	})

	it("streams only the metadata into a detached element, lets the stream go, and gives up on no answer", async () => {
		const release = vi.fn()
		const url = vi.fn(() => Promise.resolve({ kind: "url" as const, url: "/sw/preview/x", release }))

		expect(await readMediaDuration({} as PresentationSessionApi, VIDEO, { url }, 20)).toBeUndefined()
		// Never put on the page, and its stream let go.
		expect(document.querySelector("video, audio")).toBeNull()
		expect(release).toHaveBeenCalledTimes(1)
	})

	it("lets the stream go without cutting the element's request (the service worker ends the response itself)", async () => {
		const release = vi.fn()
		const url = vi.fn(() => Promise.resolve({ kind: "url" as const, url: "/sw/preview/y", release }))
		const unlink = vi.spyOn(Element.prototype, "removeAttribute")

		expect(await readMediaDuration({} as PresentationSessionApi, VIDEO, { url }, 20)).toBeUndefined()
		expect(release).toHaveBeenCalledTimes(1)
		// Firefox reports a request cut while its service-worker response still streams as a failed load.
		expect(unlink.mock.calls.filter(([name]) => name === "src")).toEqual([])

		unlink.mockRestore()
	})

	it("reads an MP4's length from its container through the session's range port, with no media element", async () => {
		const url = vi.fn()
		const { session: reading, reads } = containerSession(mp4WithDuration(1000, 12_345))

		expect(await readMediaDuration(reading, VIDEO, { url })).toBe(12_345)
		expect(url).not.toHaveBeenCalled()
		expect(reads.length).toBeGreaterThan(0)
	})

	it("gives up on a container it cannot read, never loading it into an element (an unreadable clip)", async () => {
		const url = vi.fn()
		const junk = new Uint8Array(4096)

		junk.set(box("ftyp", new Uint8Array(8)))
		junk.set(new TextEncoder().encode("moov"), 20)

		expect(await readMediaDuration(containerSession(junk).session, VIDEO, { url })).toBeUndefined()
		expect(url).not.toHaveBeenCalled()
	})

	it("loads a clip no container read knows (an MP3) into an element for its metadata", async () => {
		const url = vi.fn(() => Promise.resolve({ kind: "refused" as const, reason: "notFound" as const }))
		const mp3 = new Uint8Array(4096).fill(0xff)

		expect(await readMediaDuration(containerSession(mp3).session, AUDIO, { url })).toBeUndefined()
		expect(url).toHaveBeenCalledTimes(1)
	})

	it("reads nothing of a linked clip", async () => {
		const url = vi.fn()
		const linked: SlideMediaInfo = { kind: "video", external: "https://example.com/v", contentType: "video/mp4" }

		expect(await readMediaDuration({} as PresentationSessionApi, linked, { url })).toBeUndefined()
		expect(url).not.toHaveBeenCalled()
	})
})

describe("the bookmark triggers", () => {
	it("round-trips a bookmark through the trigger menu's value", () => {
		expect(bookmarkTriggerOf(bookmarkTriggerValue(4, "A: b"))).toEqual({ kind: "bookmark", shape: 4, bookmark: "A: b" })
		expect(bookmarkTriggerOf("5")).toBeUndefined()
	})

	it("lists each bookmark of each clip on the slide", async () => {
		render(
			<DropdownMenu defaultOpen>
				<DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuRadioGroup value="sequence">
						<BookmarkTriggerItems
							render={renderOf([layerOf(4, VIDEO), layerOf(7, AUDIO)])}
							name={id => `Clip ${String(id)}`}
						/>
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		)

		expect((await screen.findAllByRole("menuitemradio")).map(item => item.textContent)).toEqual([
			"Bookmark 1 of Clip 4",
			"Chorus of Clip 4"
		])
	})
})

// A layer whose shape is named (its alt text, as an inserted clip has its file name).
function named(layer: SlideLayer, name: string): SlideLayer {
	return { ...layer, box: { ...(layer.box as object), alt: { descr: name } } } as unknown as SlideLayer
}

describe("two clips of one name", () => {
	it("are numbered in slide order wherever a list names them", () => {
		const editor = {
			info: INFO,
			render: renderOf([
				named(layerOf(4, VIDEO), "clip.mp4"),
				named(layerOf(6, VIDEO), "clip.mp4"),
				named(layerOf(7, AUDIO), "song.mp3")
			]),
			selection: createShapeSelection(),
			session,
			command: () => Promise.resolve({ ok: true, revision: 1, dirty: true })
		} as unknown as Parameters<typeof distinctShapeNames>[1]

		expect([...distinctShapeNames(i18n.getFixedT(null, "preview"), editor, [4, 6, 7]).values()]).toEqual([
			"clip.mp4 (1)",
			"clip.mp4 (2)",
			"song.mp3"
		])
	})
})

describe("an inserted clip", () => {
	it("is selected once the slide shows it, and its length is kept for Trim", async () => {
		const { insertMediaShape } = await import("@/features/presentation/hooks/useMediaInsert")
		const order: string[] = []
		const selection = createShapeSelection()
		const selectNew = vi.spyOn(selection, "selectNew").mockImplementation(() => {
			order.push("select")

			return () => {
				order.push("withdraw")
			}
		})
		const live = {} as PresentationSessionApi
		const editor = {
			info: INFO,
			render: renderOf([layerOf(2, undefined)]),
			selection,
			session: live,
			command: () => {
				order.push("insert")

				return Promise.resolve({ ok: true, revision: 1, dirty: true })
			}
		} as unknown as Parameters<typeof insertMediaShape>[0]
		const shape = { id: 0, name: "clip.mp4", hidden: false, kind: "pic" } as Parameters<typeof insertMediaShape>[2]

		await insertMediaShape(editor, ref, shape, { id: 3, kind: "video", contentType: "video/mp4", size: 1, crc32: 0, durationMs: 4200 })

		expect(selectNew).toHaveBeenCalledWith(ref, [2])
		expect(order).toEqual(["select", "insert"])
		expect(await readMediaDuration(live, { kind: "video", part: "inserted:3", contentType: "video/mp4" })).toBe(4200)
	})
})

describe("a picked clip's object URL", () => {
	it("is let go only once the probe's element has emptied and the insert is over", async () => {
		const { letGo, releaseAfter } = await import("@/features/presentation/hooks/useMediaInsert")
		const order: string[] = []
		const element = Object.assign(new EventTarget(), {
			preload: "metadata",
			pause: () => {
				order.push("paused")
			},
			removeAttribute: () => {
				order.push("unlinked")
			},
			load: () => undefined
		})

		element.load = () => {
			order.push("reset")
			// The element empties later, as WebKit's does once its pending reads are cancelled.
			setTimeout(() => {
				order.push("emptied")
				element.dispatchEvent(new Event("emptied"))
			}, 30)
		}

		const released = letGo(element as never, 1000, 40)
		const insert = Promise.withResolvers<undefined>()

		releaseAfter([released, insert.promise], () => order.push("revoked"))
		insert.resolve(undefined)
		await new Promise(resolve => setTimeout(resolve, 50))
		// Emptied, and the insert over: the player still settling, nothing revoked yet.
		expect(order).toEqual(["paused", "unlinked", "reset", "emptied"])
		expect(element.preload).toBe("none")

		await new Promise(resolve => setTimeout(resolve, 40))
		expect(order).toEqual(["paused", "unlinked", "reset", "emptied", "revoked"])
	})

	it("is let go after a bounded wait when the element never says it emptied, and after a failed insert", async () => {
		const { letGo, releaseAfter } = await import("@/features/presentation/hooks/useMediaInsert")
		const silent = Object.assign(new EventTarget(), {
			removeAttribute: () => undefined,
			load: () => undefined,
			pause: () => undefined,
			preload: ""
		})
		const revoked = vi.fn()

		releaseAfter([letGo(silent as never, 20, 0), Promise.reject(new Error("refused"))], revoked)
		await new Promise(resolve => setTimeout(resolve, 10))
		expect(revoked).not.toHaveBeenCalled()
		await new Promise(resolve => setTimeout(resolve, 30))
		expect(revoked).toHaveBeenCalledTimes(1)
	})
})

// An ISO BMFF box.
function box(type: string, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(8 + payload.length)

	new DataView(out.buffer).setUint32(0, out.length)
	out.set(new TextEncoder().encode(type), 4)
	out.set(payload, 8)

	return out
}

// An MP4 (ftyp, then moov with an mvhd of `duration` at `timescale`) padded to 8 KiB.
function mp4WithDuration(timescale: number, duration: number): Uint8Array {
	const mvhd = new Uint8Array(100)
	const view = new DataView(mvhd.buffer)

	view.setUint32(12, timescale)
	view.setUint32(16, duration)
	view.setUint32(96, 2)

	const head = [box("ftyp", new TextEncoder().encode("isom\u0000\u0000\u0002\u0000isom")), box("moov", box("mvhd", mvhd))]
	const out = new Uint8Array(8192)
	let at = 0

	for (const part of head) {
		out.set(part, at)
		at += part.length
	}

	out.set(box("mdat", new Uint8Array(8192 - at - 8)), at)

	return out
}

// A session whose media(part, port) serves `bytes` on the port, as the worker does. happy-dom's navigator has a null
// Web Locks API, which the range port uses where it exists: the test's navigator has none.
function containerSession(bytes: Uint8Array): { session: PresentationSessionApi; reads: [number, number][] } {
	const reads: [number, number][] = []

	vi.stubGlobal("navigator", { userAgent: "test" })
	const session = {
		media: (_part: string, port: MessagePort) => {
			exposeRangePort(
				port,
				(start, end) => {
					reads.push([start, end])

					return Promise.resolve(bytes.slice(start, end))
				},
				new AbortController()
			)

			return Promise.resolve({ size: bytes.length, contentType: "video/mp4", seekable: true })
		}
	} as unknown as PresentationSessionApi

	return { session, reads }
}
