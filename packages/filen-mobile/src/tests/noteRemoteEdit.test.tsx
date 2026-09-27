// @vitest-environment happy-dom

// The open note's answer to an edit made elsewhere (components/content onContentEditedRemotely): a clean
// editor takes the event's content without a request, and one being edited holds its sync until the user
// answers.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "eventemitter3"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const { emitter, state, confirm3, refetch, contentUpdate, hold, release, settled, syncDebounced, getContent, editor, attachEditor } =
	vi.hoisted(() => ({
		emitter: { current: null as EventEmitter | null },
		state: {
			inflight: {} as Record<string, { timestamp: number; content: string; note: unknown; baseContentHash?: string }[]>,
			cached: "old" as string | undefined,
			readSinceGap: false,
			unlocked: Promise.resolve() as Promise<void>
		},
		getContent: vi.fn<() => Promise<string | undefined>>(),
		attachEditor: vi.fn(() => () => undefined),
		editor: { onValueChange: null as ((value: string) => Promise<void>) | null },
		confirm3: vi.fn<() => Promise<"primary" | "destructive" | "cancel">>(),
		refetch: vi.fn(() => Promise.resolve({})),
		contentUpdate: vi.fn(),
		hold: vi.fn(),
		release: vi.fn(),
		settled: { current: Promise.resolve() },
		syncDebounced: vi.fn()
	}))

vi.mock("@filen/sdk-rs", () => ({
	NoteType: {
		Text: "text",
		Md: "md",
		Code: "code",
		Rich: "rich",
		Checklist: "checklist"
	}
}))
vi.mock("react-native-reanimated", () => ({ FadeOut: {}, default: {} }))
vi.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 0 }))
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }))
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({ color: "#000" }) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("zustand/shallow", () => ({ useShallow: (selector: unknown) => selector }))
vi.mock("@/components/ui/view", () => ({ default: ({ children }: { children?: unknown }) => children ?? null }))
vi.mock("@/components/ui/listEmpty", () => ({ default: () => null }))
vi.mock("@/components/ui/button", () => ({ default: () => null }))
vi.mock("@/components/ui/animated", () => ({ AnimatedView: () => null }))
vi.mock("@/components/textEditor", () => ({
	default: (props: { onValueChange: (value: string) => Promise<void> }) => {
		editor.onValueChange = props.onValueChange

		return null
	}
}))
vi.mock("@/features/notes/components/content/checklist", () => ({ default: () => null }))
vi.mock("@/features/notes/utils", () => ({ noteTypeToEditorType: () => "text", noteCodeTitleExtension: () => null }))
vi.mock("@/features/notes/checklistView", () => ({ useChecklistHideCompleted: () => [false] }))
vi.mock("@/features/notes/queries/useNoteContent.query", () => ({
	default: () => ({ isFetching: false, isPending: false, isError: false, dataUpdatedAt: 1, refetch }),
	noteContentQueryGet: () => state.cached,
	noteContentQueryUpdate: contentUpdate,
	noteContentQueryReadSinceSocketGap: () => state.readSinceGap
}))
vi.mock("@/lib/unlockedForeground", () => ({ whenUnlockedForeground: () => state.unlocked }))
vi.mock("@/features/notes/components/sync", async () => ({
	sync: {
		flushToDisk: () => Promise.resolve(true),
		clearRejections: vi.fn(),
		syncDebounced,
		hold,
		attachEditor
	},
	hashNoteContent: (content: string) => `h(${content})`,
	buildInflightEntries: (await vi.importActual<typeof import("@filen/shared")>("@filen/shared")).buildInflightEntries
}))
vi.mock("@/lib/auth", () => ({ useStringifiedClient: () => ({ userId: 1 }) }))
vi.mock("@/features/notes/queries/useNotesQuery", () => ({ notesQueryGet: () => [] }))
vi.mock("@/features/notes/store/useNotesInflight.store", () => {
	const getState = () => ({
		inflightContent: state.inflight,
		setInflightContent: (updater: (prev: typeof state.inflight) => typeof state.inflight) => {
			state.inflight = updater(state.inflight)
		}
	})

	return {
		default: Object.assign((selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState()), { getState })
	}
})
vi.mock("@/features/notes/store/useNotesOffline.store", () => ({
	default: { getState: () => ({ openContentView: () => undefined, closeContentView: () => undefined }) }
}))
vi.mock("@/stores/useTextEditor.store", () => ({ default: () => false }))
vi.mock("@/lib/events", () => ({
	default: {
		subscribe: (name: string, listener: (payload: unknown) => void) => {
			emitter.current?.on(name, listener)

			return { remove: () => emitter.current?.off(name, listener) }
		}
	}
}))
vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key }, t: (key: string) => key }))
vi.mock("@/lib/prompts", () => ({ default: { confirm3 } }))
vi.mock("@/features/notes/notes", () => ({ default: { create: vi.fn(), getContent } }))
vi.mock("@/components/ui/fullScreenLoadingModal", () => ({ runWithLoading: vi.fn() }))
vi.mock("@/lib/decryption", () => ({ noteDisplayTitle: () => "" }))
vi.mock("@/hooks/useIsOnline", () => ({ default: () => true }))
vi.mock("@filen/shared", async () => ({
	...(await import("@/tests/mocks/filenShared")),
	conflictCopyStamp: () => "stamp",
	runEffect: (fn: (defer: (cleanup: () => void) => void) => void) => {
		const cleanups: (() => void)[] = []

		fn(cleanup => cleanups.push(cleanup))

		return { cleanup: () => cleanups.forEach(c => c()) }
	}
}))

import { act, cleanup, render } from "@testing-library/react"
import { createElement } from "react"
import Content from "@/features/notes/components/content"
import alerts from "@/lib/alerts"
import useSocketStore from "@/stores/useSocket.store"
import type { Note } from "@/types"

const note = { uuid: "n1", noteType: "text", title: "t", ownerId: 1, participants: [] } as unknown as Note

function edited(content: string | undefined): void {
	emitter.current?.emit("noteContentEdited", { noteUuid: "n1", contentEdited: {}, content })
}

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

// A background (or a dropped connection) and the socket coming back.
function socketReconnected(): void {
	act(() => {
		useSocketStore.getState().setState("disconnected")
		useSocketStore.getState().setState("connected")
	})
}

async function flush(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

beforeEach(() => {
	emitter.current = new EventEmitter()
	state.inflight = {}
	state.cached = "old"
	state.readSinceGap = false
	state.unlocked = Promise.resolve()
	settled.current = Promise.resolve()
	vi.clearAllMocks()
	useSocketStore.setState({ state: "connected", connectedAt: 1 })
	hold.mockImplementation(() => ({ settled: settled.current, release }))
	attachEditor.mockImplementation(() => () => undefined)
	render(createElement(Content, { note }))
})

afterEach(() => {
	cleanup()
	emitter.current = null
})

describe("a note edited elsewhere while open", () => {
	it("not being edited: takes the event's content at once, with no request", async () => {
		edited("theirs")
		await flush()

		expect(contentUpdate).toHaveBeenCalledWith({ params: { uuid: "n1" }, updater: "theirs" })
		expect(refetch).not.toHaveBeenCalled()
		expect(alerts.normal).toHaveBeenCalledWith("remote_change_updated")
	})

	it("not being edited, content undecryptable: re-reads it", async () => {
		edited(undefined)
		await flush()

		expect(contentUpdate).not.toHaveBeenCalled()
		expect(refetch).toHaveBeenCalledTimes(1)
	})

	it("being edited: holds the note's sync while asking, and releases it on the answer", async () => {
		state.inflight = { n1: [{ timestamp: 1, content: "mine", note }] }

		let answer: (value: "cancel") => void = () => undefined

		confirm3.mockReturnValue(new Promise(resolve => (answer = resolve)))

		edited("theirs")
		await flush()

		expect(hold).toHaveBeenCalledWith("n1")
		expect(release).not.toHaveBeenCalled()

		answer("cancel")
		await flush()

		expect(release).toHaveBeenCalledTimes(1)
	})

	it("Load theirs reloads only after a push already sent has landed", async () => {
		state.inflight = { n1: [{ timestamp: 1, content: "mine", note }] }

		let landed: () => void = () => undefined

		settled.current = new Promise(resolve => (landed = resolve))
		confirm3.mockResolvedValue("destructive")

		edited("theirs")
		await flush()

		expect(refetch).not.toHaveBeenCalled()
		expect(state.inflight["n1"]).toHaveLength(1)

		landed()
		await flush()

		expect(state.inflight["n1"]).toBeUndefined()
		expect(refetch).toHaveBeenCalledTimes(1)
		expect(release).toHaveBeenCalledTimes(1)
	})

	it("Keep mine rebases unsynced edits onto theirs, so their push raises no overwrite warning", async () => {
		state.inflight = {
			n1: [
				{ timestamp: 1, content: "mine 1", note, baseContentHash: "h(old)" },
				{ timestamp: 2, content: "mine 2", note, baseContentHash: "h(old)" }
			]
		}
		confirm3.mockResolvedValue("cancel")

		edited("theirs")
		await flush()

		expect(state.inflight["n1"]?.map(entry => entry.baseContentHash)).toEqual(["h(theirs)", "h(theirs)"])
		expect(state.inflight["n1"]?.map(entry => entry.content)).toEqual(["mine 1", "mine 2"])
		expect(release).toHaveBeenCalledTimes(1)
	})

	it("Keep mine over undecryptable content pushes unsynced edits unchecked", async () => {
		state.inflight = { n1: [{ timestamp: 1, content: "mine", note, baseContentHash: "h(old)" }] }
		confirm3.mockResolvedValue("cancel")

		edited(undefined)
		await flush()

		expect(state.inflight["n1"]).toEqual([{ timestamp: 1, content: "mine", note }])
	})

	it("edits already synced leave the editor clean: takes theirs with no prompt", async () => {
		await act(async () => {
			await editor.onValueChange?.("typed")
		})

		expect(state.inflight["n1"]).toHaveLength(1)

		// The push landed: sync pruned the outbox and wrote the pushed content into the cache.
		state.inflight = {}
		state.cached = "typed"

		edited("theirs")
		await flush()

		expect(confirm3).not.toHaveBeenCalled()
		expect(contentUpdate).toHaveBeenCalledWith({ params: { uuid: "n1" }, updater: "theirs" })
		expect(alerts.normal).toHaveBeenCalledWith("remote_change_updated")
	})

	it("a prompt queued behind Load theirs finds the editor clean: takes theirs, re-queuing nothing", async () => {
		state.inflight = { n1: [{ timestamp: 1, content: "mine", note, baseContentHash: "h(old)" }] }

		const first = deferred<"destructive">()

		confirm3.mockReturnValueOnce(first.promise)

		edited("theirs 1")
		await flush()
		edited("theirs 2")
		await flush()

		first.resolve("destructive")
		await flush()
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(1)
		expect(state.inflight["n1"]).toBeUndefined()
		expect(contentUpdate).toHaveBeenCalledWith({ params: { uuid: "n1" }, updater: "theirs 2" })
	})

	it("an edit superseded while it waited is never asked about: the newest one is", async () => {
		state.inflight = { n1: [{ timestamp: 1, content: "mine", note, baseContentHash: "h(old)" }] }

		const first = deferred<"cancel">()

		confirm3.mockReturnValueOnce(first.promise).mockResolvedValueOnce("cancel")

		edited("theirs 1")
		await flush()
		edited("theirs 2")
		edited("theirs 3")
		await flush()

		first.resolve("cancel")
		await flush()
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(2)
		expect(state.inflight["n1"]?.map(entry => entry.baseContentHash)).toEqual(["h(theirs 3)"])
	})

	it("after a socket gap, re-reads a clean note once and takes an edit made meanwhile", async () => {
		getContent.mockResolvedValue("theirs")

		socketReconnected()
		await flush()

		expect(getContent).toHaveBeenCalledTimes(1)
		expect(hold).toHaveBeenCalledWith("n1")
		expect(release).toHaveBeenCalledTimes(1)
		expect(contentUpdate).toHaveBeenCalledWith({ params: { uuid: "n1" }, updater: "theirs" })
		expect(alerts.normal).toHaveBeenCalledWith("remote_change_updated")
	})

	it("after a socket gap, an unchanged note is left alone", async () => {
		getContent.mockResolvedValue("old")

		socketReconnected()
		await flush()

		expect(getContent).toHaveBeenCalledTimes(1)
		expect(contentUpdate).not.toHaveBeenCalled()
		expect(alerts.normal).not.toHaveBeenCalled()
	})

	it("after a socket gap, asks when the note moved past the base of unsynced edits", async () => {
		state.inflight = { n1: [{ timestamp: 1, content: "mine", note, baseContentHash: "h(old)" }] }
		getContent.mockResolvedValue("theirs")
		confirm3.mockResolvedValue("cancel")

		socketReconnected()
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(1)
		expect(state.inflight["n1"]?.map(entry => entry.baseContentHash)).toEqual(["h(theirs)"])
	})

	it("after a socket gap, unsynced edits on an unchanged base are not asked about", async () => {
		state.inflight = { n1: [{ timestamp: 1, content: "mine", note, baseContentHash: "h(old)" }] }
		getContent.mockResolvedValue("old")

		socketReconnected()
		await flush()

		expect(confirm3).not.toHaveBeenCalled()
	})

	it("registers as the note's editor, so a pass hands it an edit found under unsynced edits", () => {
		expect(attachEditor).toHaveBeenCalledWith("n1")
	})

	it("asks only once the app is unlocked and in front, and toasts no earlier", async () => {
		let unlock: () => void = () => undefined

		state.unlocked = new Promise(resolve => (unlock = resolve))
		state.inflight = { n1: [{ timestamp: 1, content: "mine", note, baseContentHash: "h(old)" }] }
		confirm3.mockResolvedValue("cancel")

		edited("theirs")
		await flush()

		expect(hold).toHaveBeenCalledWith("n1")
		expect(confirm3).not.toHaveBeenCalled()

		unlock()
		await flush()

		expect(confirm3).toHaveBeenCalledTimes(1)
	})

	it("a clean note takes theirs at once and says so once unlocked", async () => {
		let unlock: () => void = () => undefined

		state.unlocked = new Promise(resolve => (unlock = resolve))

		edited("theirs")
		await flush()

		expect(contentUpdate).toHaveBeenCalledWith({ params: { uuid: "n1" }, updater: "theirs" })
		expect(alerts.normal).not.toHaveBeenCalled()

		unlock()
		await flush()

		expect(alerts.normal).toHaveBeenCalledWith("remote_change_updated")
	})

	it("never asks twice about content the unsynced edits were already kept over", async () => {
		state.inflight = { n1: [{ timestamp: 1, content: "mine", note, baseContentHash: "h(theirs)" }] }

		edited("theirs")
		await flush()

		expect(confirm3).not.toHaveBeenCalled()
	})

	it("after a socket gap, reuses the content query's own read instead of reading again", async () => {
		state.readSinceGap = true

		socketReconnected()
		await flush()

		expect(getContent).not.toHaveBeenCalled()
		expect(hold).not.toHaveBeenCalled()
	})
})
