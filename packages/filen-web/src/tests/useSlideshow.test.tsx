// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@testing-library/react"
import { use, useEffect, useState } from "react"
import type { File } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { ImageShownContext, type ShownImage } from "@/features/preview/lib/imageDisplay"
import { SlideSignalsContext, type SlideSignals, type SlideshowSlotValue } from "@/features/preview/lib/slideSignals"
import { testUuid } from "@/tests/support/uuid"

// The slideshow's engine over a host pager: when a slide is due, what stops its clock, the wake lock, full screen, the
// list changing under it, and the next image loaded ahead.

const lock = vi.hoisted(() => ({ set: vi.fn<(wanted: boolean) => void>(), dispose: vi.fn() }))

vi.mock("@/lib/media/wakeLock", () => ({ createScreenWakeLock: () => lock }))

const prefetch = vi.hoisted(() => ({ log: [] as string[], calls: [] as string[] }))

vi.mock("@/features/preview/lib/previewPrefetch", () => ({
	prefetchPreviewImage: (item: DriveItem) => {
		const name = item.data.uuid.slice(0, 1)

		prefetch.calls.push(name)

		return () => {
			prefetch.log.push(`dispose ${name}`)
		}
	}
}))

vi.mock("@/features/drive/lib/thumbnails", () => ({ peekThumbnailUrl: (uuid: string) => `blob:thumb-${uuid}` }))

const { useSlideshow } = await import("@/features/preview/hooks/useSlideshow")
const { SlideshowSlot } = await import("@/features/preview/components/slideshowSlot")
const { setSlideshowPrefs } = await import("@/features/preview/lib/slideshowPrefs")

type Slideshow = ReturnType<typeof useSlideshow>

function fileNamed(name: string): DriveItem {
	const file: File = {
		uuid: testUuid(name.replace(/\W/g, "")),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 1000n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name, mime: "application/octet-stream", modified: 1_700_000_000_000n, size: 1000n, key: "k", version: 2 }
		}
	}

	return narrowItem(file)
}

const A = fileNamed("a.jpg")
const B = fileNamed("b.jpg")
const C = fileNamed("c.jpg")
const V = fileNamed("v.mp4")
const DOC = fileNamed("doc.pdf")

interface Seen {
	uuid: string
	shown: ((image: ShownImage) => void) | null
	signals: SlideSignals | null
}

let show: Slideshow
let index = 0
let seen: Seen = { uuid: "", shown: null, signals: null }
let leavable = true

function Viewer({ uuid }: { uuid: string }) {
	const shown = use(ImageShownContext)
	const signals = use(SlideSignalsContext)

	useEffect(() => {
		seen = { uuid, shown, signals }
	})

	useEffect(() => {
		prefetch.log.push(`mount ${uuid.slice(0, 1)}`)
	}, [uuid])

	return <div data-testid="viewer">{uuid}</div>
}

// A pager as the hosts are: a replaced list keeps the open item where it still is, else the same index.
function Host({ items, start }: { items: readonly DriveItem[]; start: number }) {
	const [current, setCurrent] = useState(start)
	const [listed, setListed] = useState(items)

	if (listed !== items) {
		const open = listed[current]?.data.uuid
		const kept = items.findIndex(item => item.data.uuid === open)

		setListed(items)
		setCurrent(kept === -1 ? Math.min(current, Math.max(0, items.length - 1)) : kept)
	}

	const slideshow = useSlideshow({
		items,
		index: current,
		step: delta => {
			setCurrent(previous => previous + delta)
		},
		canLeave: () => leavable,
		cacheScope: "authed",
		access: "authed"
	})

	useEffect(() => {
		show = slideshow
		index = current
	})

	const uuid = items[current]?.data.uuid ?? ""

	return (
		<SlideshowSlot value={slideshow.running ? slideshow.slot : null}>
			<Viewer
				key={uuid}
				uuid={uuid}
			/>
		</SlideshowSlot>
	)
}

function mount(items: readonly DriveItem[], start = 0) {
	const view = render(
		<Host
			items={items}
			start={start}
		/>
	)

	return {
		...view,
		update: (next: readonly DriveItem[]) => {
			view.rerender(
				<Host
					items={next}
					start={start}
				/>
			)
		}
	}
}

function advance(ms: number): void {
	act(() => {
		vi.advanceTimersByTime(ms)
	})
}

function shownNow(): void {
	act(() => {
		seen.shown?.({ width: 10, height: 10 })
	})
}

function seenUuid(): string {
	return seen.uuid
}

function startShow(): void {
	act(() => {
		show.start()
	})
}

function setFullscreen(element: Element | null): void {
	Object.defineProperty(document, "fullscreenElement", { configurable: true, value: element, writable: true })
}

function setVisibility(state: DocumentVisibilityState): void {
	Object.defineProperty(document, "visibilityState", { configurable: true, value: state })
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"))
	})
}

const requestFullscreen = vi.fn(() => {
	setFullscreen(document.documentElement)

	return Promise.resolve()
})
const exitFullscreen = vi.fn(() => {
	setFullscreen(null)

	return Promise.resolve()
})

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] })
	leavable = true
	prefetch.log.length = 0
	prefetch.calls.length = 0
	setFullscreen(null)
	Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true })
	requestFullscreen.mockClear()
	exitFullscreen.mockClear()
	document.documentElement.requestFullscreen = requestFullscreen
	document.exitFullscreen = exitFullscreen
})

afterEach(() => {
	setSlideshowPrefs({ shuffle: false })
	vi.useRealTimers()
	Reflect.deleteProperty(document, "fullscreenElement")
	Reflect.deleteProperty(document, "fullscreenEnabled")
	Reflect.deleteProperty(document, "visibilityState")
})

describe("useSlideshow", () => {
	it("advances after the interval from the shown signal", () => {
		mount([A, B, C])
		startShow()

		expect(show.running).toBe(true)
		expect(show.position).toBe(1)
		expect(show.total).toBe(3)

		// The slide it starts on is on screen already: its interval runs from the start.
		advance(4_999)
		expect(index).toBe(0)

		advance(1)
		expect(index).toBe(1)
		expect(show.position).toBe(2)

		advance(2_000)
		shownNow()
		advance(4_999)
		expect(index).toBe(1)

		advance(1)
		expect(index).toBe(2)
	})

	it("an unshown slide advances after 15 s", () => {
		// Opened on a document: the show starts by paging to the first slide, which has not shown.
		mount([DOC, A, B, C])
		startShow()
		expect(index).toBe(1)

		advance(14_999)
		expect(index).toBe(1)

		advance(1)
		expect(index).toBe(2)
	})

	it("a video slide advances on its end, not the interval", () => {
		mount([V, A, B])
		startShow()
		shownNow()
		advance(60_000)
		expect(index).toBe(0)

		act(() => {
			seen.signals?.mediaEnded()
		})
		advance(0)
		expect(index).toBe(1)
	})

	it("a video that fails before it showed is left at once", () => {
		mount([DOC, V, A])
		startShow()
		expect(index).toBe(1)

		act(() => {
			seen.signals?.mediaEnded()
		})
		advance(0)
		expect(index).toBe(2)
	})

	it("keeps one signals object per slide, and a slide's signals reach only that slide", () => {
		mount([A, B, C])
		startShow()

		const first = seen.signals

		act(() => {
			show.togglePause()
		})
		act(() => {
			show.togglePause()
		})
		expect(seen.signals).toBe(first)

		// An animated image: due only once its loop ended and the interval passed; repeats are no-ops.
		act(() => {
			first?.animating()
			first?.animating()
		})
		shownNow()
		advance(10_000)
		expect(index).toBe(0)

		act(() => {
			first?.mediaEnded()
		})
		advance(0)
		expect(index).toBe(1)
		expect(seen.signals).not.toBe(first)

		// The last slide's late or repeated signals change nothing on this one.
		shownNow()
		act(() => {
			first?.animating()
			first?.mediaEnded()
		})
		advance(4_999)
		expect(index).toBe(1)
		advance(1)
		expect(index).toBe(2)
	})

	it("pauses instead of stepping while the slot cannot be left", () => {
		mount([A, B, C])
		startShow()
		shownNow()
		leavable = false
		advance(5_000)
		expect(index).toBe(0)
		expect(show.paused).toBe(true)

		advance(60_000)
		expect(index).toBe(0)

		// Resumed while still dirty: paused again, never stepped.
		act(() => {
			show.togglePause()
		})
		advance(0)
		expect(show.paused).toBe(true)
		expect(index).toBe(0)

		leavable = true
		act(() => {
			show.togglePause()
		})
		advance(0)
		expect(index).toBe(1)
	})

	it("stops the clock while the tab is hidden and resumes after", () => {
		mount([A, B, C])
		startShow()
		shownNow()
		advance(2_000)
		setVisibility("hidden")
		advance(30_000)
		expect(index).toBe(0)

		setVisibility("visible")
		advance(2_999)
		expect(index).toBe(0)
		advance(1)
		expect(index).toBe(1)
	})

	it("wake lock held only while running and not paused", () => {
		const view = mount([A, B, C])

		expect(lock.set).not.toHaveBeenCalledWith(true)

		startShow()
		expect(lock.set).toHaveBeenLastCalledWith(true)

		act(() => {
			show.togglePause()
		})
		expect(lock.set).toHaveBeenLastCalledWith(false)

		act(() => {
			show.togglePause()
		})
		expect(lock.set).toHaveBeenLastCalledWith(true)

		act(() => {
			show.stop()
		})
		expect(lock.set).toHaveBeenLastCalledWith(false)

		view.unmount()
		expect(lock.dispose).toHaveBeenCalled()
	})

	it("leaving fullscreen ends it; leaving it to close the bar's menu does not", async () => {
		mount([A, B, C])
		startShow()
		await act(async () => {
			await Promise.resolve()
		})
		expect(requestFullscreen).toHaveBeenCalledTimes(1)

		// Escape with the menu open closes the menu, the browser leaves full screen for the same key.
		act(() => {
			show.setMenuOpen(true)
		})
		act(() => {
			setFullscreen(null)
			document.dispatchEvent(new Event("fullscreenchange"))
		})
		expect(show.running).toBe(true)

		act(() => {
			show.stop()
		})
		advance(0)
		startShow()
		await act(async () => {
			await Promise.resolve()
		})

		// Closed a moment ago.
		act(() => {
			show.setMenuOpen(true)
			show.setMenuOpen(false)
		})
		advance(500)
		act(() => {
			setFullscreen(null)
			document.dispatchEvent(new Event("fullscreenchange"))
		})
		expect(show.running).toBe(true)

		act(() => {
			show.stop()
		})
		advance(2_000)
		startShow()
		await act(async () => {
			await Promise.resolve()
		})
		act(() => {
			setFullscreen(null)
			document.dispatchEvent(new Event("fullscreenchange"))
		})
		expect(show.running).toBe(false)
		expect(index).toBe(0)
	})

	it("does not end on leaving a full screen it did not enter", async () => {
		setFullscreen(document.documentElement)
		mount([A, B, C])
		startShow()
		await act(async () => {
			await Promise.resolve()
		})
		expect(requestFullscreen).not.toHaveBeenCalled()

		act(() => {
			setFullscreen(null)
			document.dispatchEvent(new Event("fullscreenchange"))
		})
		expect(show.running).toBe(true)
	})

	it("leaves the full screen it entered when it stops", async () => {
		mount([A, B, C])
		startShow()
		await act(async () => {
			await Promise.resolve()
		})

		act(() => {
			show.stop()
		})
		await act(async () => {
			await Promise.resolve()
		})
		expect(exitFullscreen).toHaveBeenCalledTimes(1)
	})

	it("wraps at the end", () => {
		mount([A, B, C], 2)
		startShow()
		expect(show.position).toBe(3)

		shownNow()
		advance(5_000)
		expect(index).toBe(0)
		expect(show.position).toBe(1)
	})

	it("starts on the next slideable item and skips unslideable ones", () => {
		mount([DOC, A, DOC, B])
		startShow()
		expect(index).toBe(1)
		expect(show.total).toBe(2)

		shownNow()
		advance(5_000)
		expect(index).toBe(3)
	})

	it("go steps either way and follows the host's own paging", () => {
		mount([A, B, C])
		startShow()

		act(() => {
			show.go(-1)
		})
		expect(index).toBe(2)

		act(() => {
			show.go(1)
		})
		expect(index).toBe(0)
	})

	it("a removed next item is skipped", () => {
		const view = mount([A, B, C])

		startShow()
		view.update([A, C])
		expect(show.running).toBe(true)
		expect(show.total).toBe(2)

		shownNow()
		advance(5_000)
		expect(index).toBe(1)
		expect(seen.uuid).toBe(C.data.uuid)
	})

	it("stops when one slideable item remains", () => {
		const view = mount([A, B, C])

		startShow()
		view.update([A, DOC])
		expect(show.running).toBe(false)

		advance(60_000)
		expect(index).toBe(0)
	})

	it("does not start with fewer than two slideable items", () => {
		mount([A, DOC])
		startShow()
		expect(show.running).toBe(false)
	})

	it("prefetches the next native image once and releases it only after the next slot mounted", () => {
		mount([A, B, V, C])
		startShow()
		expect(prefetch.calls).toEqual(["b"])

		act(() => {
			show.togglePause()
		})
		act(() => {
			show.togglePause()
		})
		expect(prefetch.calls).toEqual(["b"])

		prefetch.log.length = 0
		shownNow()
		advance(5_000)
		expect(index).toBe(1)
		expect(prefetch.log).toEqual(["mount b", "dispose b"])
		// The next is a video: nothing loaded ahead.
		expect(prefetch.calls).toEqual(["b"])
	})

	it("drops a prefetch whose item is no longer next, and on stop", () => {
		const view = mount([A, B, C])

		startShow()
		expect(prefetch.calls).toEqual(["b"])

		view.update([A, C])
		expect(prefetch.log).toContain("dispose b")
		expect(prefetch.calls).toEqual(["b", "c"])

		act(() => {
			show.stop()
		})
		expect(prefetch.log).toContain("dispose c")
	})
	it("shows a slide that has not reported shown once the show pauses on it", () => {
		mount([DOC, A, B])
		startShow()
		expect(index).toBe(1)

		const content = (): string => document.querySelector("[data-testid=viewer]")?.parentElement?.className ?? ""

		expect(content()).toContain("opacity-0")

		act(() => {
			show.togglePause()
		})
		expect(content()).toContain("opacity-100")
	})

	it("shows a slide that never showed when its time runs out", () => {
		mount([DOC, A, B])
		startShow()

		const slot = show.slot

		expect(slot.visible()).toBe(false)

		advance(15_000)
		expect(index).toBe(2)
		expect(slot.visible()).toBe(true)
	})

	it("starts paused without paging when the item it starts on cannot be left", () => {
		leavable = false
		mount([DOC, A, B])
		startShow()
		expect(show.running).toBe(true)
		expect(show.paused).toBe(true)
		expect(index).toBe(0)

		// Still dirty: resuming does not page either.
		act(() => {
			show.togglePause()
		})
		expect(show.paused).toBe(true)
		expect(index).toBe(0)

		leavable = true
		act(() => {
			show.togglePause()
		})
		expect(show.paused).toBe(false)
		expect(index).toBe(1)
	})

	it("a shuffled order keeps its sequence when an item goes and another comes", () => {
		const D = fileNamed("d.jpg")
		const E = fileNamed("e.jpg")
		const view = mount([A, B, C, D])

		act(() => {
			setSlideshowPrefs({ shuffle: true })
		})
		startShow()

		const lap = [seenUuid()]

		for (let i = 0; i < 3; i++) {
			act(() => {
				show.go(1)
			})
			lap.push(seenUuid())
		}

		expect(lap[0]).toBe(A.data.uuid)
		expect([...lap].sort()).toEqual([A, B, C, D].map(item => item.data.uuid).sort())

		// The second slide of the lap goes, a new item comes.
		const gone = lap[1]
		const remaining = [A, B, C, D].filter(item => item.data.uuid !== gone)

		view.update([...remaining, E])
		expect(show.total).toBe(4)

		act(() => {
			show.go(1)
		})
		expect(seenUuid()).toBe(E.data.uuid)

		const back: string[] = []

		for (let i = 0; i < 3; i++) {
			act(() => {
				show.go(-1)
			})
			back.push(seenUuid())
		}

		expect(back).toEqual([lap[3], lap[2], lap[0]])
	})

	it("toggling shuffle while running keeps the current slide", () => {
		const D = fileNamed("d.jpg")

		mount([A, B, C, D], 1)
		startShow()
		expect(show.position).toBe(2)

		act(() => {
			setSlideshowPrefs({ shuffle: true })
		})
		expect(show.running).toBe(true)
		expect(index).toBe(1)
		expect(show.position).toBe(1)
		expect(show.total).toBe(4)

		act(() => {
			setSlideshowPrefs({ shuffle: false })
		})
		expect(index).toBe(1)
		expect(show.position).toBe(2)
	})

	it("goes on from the host's new index when the current item is removed", () => {
		const view = mount([A, B, C])

		startShow()
		// The host keeps its index: B is there now.
		view.update([B, C])
		expect(show.running).toBe(true)
		expect(show.position).toBe(1)
		expect(seenUuid()).toBe(B.data.uuid)

		shownNow()
		advance(5_000)
		expect(seenUuid()).toBe(C.data.uuid)
	})

	it("stops when the list empties", () => {
		const view = mount([A, B, C])

		startShow()
		view.update([])
		expect(show.running).toBe(false)

		advance(60_000)
		expect(lock.set).toHaveBeenLastCalledWith(false)
	})
})

// A slot value whose visibility the test sets, as the hook's records do.
function slotValue(visible: boolean): { value: SlideshowSlotValue; show: () => void; shown: ReturnType<typeof vi.fn> } {
	let seenNow = visible
	const listeners = new Set<() => void>()
	const shown = vi.fn()

	return {
		value: {
			shown,
			signals: { active: true, mediaEnded: vi.fn(), animating: vi.fn() },
			placeholderUrl: "blob:thumb",
			visible: () => seenNow,
			subscribe: listener => {
				listeners.add(listener)

				return () => {
					listeners.delete(listener)
				}
			}
		},
		show: () => {
			seenNow = true

			for (const listener of listeners) listener()
		},
		shown
	}
}

describe("SlideshowSlot", () => {
	it("SlideshowSlot keeps its child mounted across renders", () => {
		let mounts = 0

		function Child() {
			useEffect(() => {
				mounts++
			}, [])

			return <span data-testid="child" />
		}

		const { value } = slotValue(false)
		const view = render(
			<SlideshowSlot value={null}>
				<Child />
			</SlideshowSlot>
		)
		const outer = view.container.firstElementChild
		const inner = view.getByTestId("child").parentElement

		// Outside a slideshow the wrappers lay nothing out.
		expect(outer?.className).toBe("contents")
		expect(inner?.className).toBe("contents")

		view.rerender(
			<SlideshowSlot value={value}>
				<Child />
			</SlideshowSlot>
		)
		expect(view.container.firstElementChild).toBe(outer)
		expect(outer?.className).toContain("size-full")
		// Its own stacking context: nothing the viewer raises rises over the bar beside the slot.
		expect(outer?.className).toContain("isolate")
		expect(view.getByTestId("child").parentElement).toBe(inner)
		view.rerender(
			<SlideshowSlot value={null}>
				<Child />
			</SlideshowSlot>
		)
		expect(mounts).toBe(1)
	})

	it("shows the thumbnail under a slide until it is to be seen, fades the slide in, then drops the thumbnail", () => {
		let report: ((image: ShownImage) => void) | null = null

		function Child() {
			const provided = use(ImageShownContext)

			useEffect(() => {
				report = provided
			})

			return <span data-testid="child" />
		}

		const slide = slotValue(false)
		const view = render(
			<SlideshowSlot value={slide.value}>
				<Child />
			</SlideshowSlot>
		)
		const content = view.getByTestId("child").parentElement

		expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:thumb")
		expect(content?.className).toContain("opacity-0")

		act(() => {
			report?.({ width: 1, height: 1 })
		})
		expect(slide.shown).toHaveBeenCalledWith({ width: 1, height: 1 })

		act(() => {
			slide.show()
		})
		expect(content?.className).toContain("opacity-100")
		expect(content?.className).toContain("duration-200")
		expect(view.container.querySelector("img")).not.toBeNull()

		advance(200)
		expect(view.container.querySelector("img")).toBeNull()
	})

	it("an item that is no slide is never hidden", () => {
		const value: SlideshowSlotValue = { ...slotValue(false).value, signals: null }
		const view = render(
			<SlideshowSlot value={value}>
				<span data-testid="child" />
			</SlideshowSlot>
		)

		expect(view.getByTestId("child").parentElement?.className).toContain("opacity-100")
		expect(view.container.querySelector("img")).toBeNull()
	})
})
