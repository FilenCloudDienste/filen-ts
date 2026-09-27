// @vitest-environment happy-dom

// The open note's answer to an edit made elsewhere (components/content onContentEditedRemotely): a clean
// editor takes the event's content without a request, and one being edited holds its sync until the user
// answers.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "eventemitter3"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const { emitter, state, confirm3, refetch, contentUpdate, hold, release, settled, syncDebounced } = vi.hoisted(() => ({
	emitter: { current: null as EventEmitter | null },
	state: {
		inflight: {} as Record<string, { timestamp: number; content: string; note: unknown; baseContentHash?: string }[]>,
		cached: "old" as string | undefined
	},
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
vi.mock("@/components/ui/view", () => ({ default: () => null }))
vi.mock("@/components/ui/listEmpty", () => ({ default: () => null }))
vi.mock("@/components/ui/button", () => ({ default: () => null }))
vi.mock("@/components/ui/animated", () => ({ AnimatedView: () => null }))
vi.mock("@/components/textEditor", () => ({ default: () => null }))
vi.mock("@/features/notes/components/content/checklist", () => ({ default: () => null }))
vi.mock("@/features/notes/utils", () => ({ noteTypeToEditorType: () => "text", noteCodeTitleExtension: () => null }))
vi.mock("@/features/notes/checklistView", () => ({ useChecklistHideCompleted: () => [false] }))
vi.mock("@/features/notes/queries/useNoteContent.query", () => ({
	default: () => ({ isFetching: false, isPending: false, isError: false, dataUpdatedAt: 1, refetch }),
	noteContentQueryGet: () => state.cached,
	noteContentQueryUpdate: contentUpdate
}))
vi.mock("@/features/notes/components/sync", async () => ({
	sync: {
		flushToDisk: () => Promise.resolve(true),
		clearRejections: vi.fn(),
		syncDebounced,
		hold
	},
	hashNoteContent: (content: string) => `h(${content})`,
	buildInflightEntries: (await vi.importActual<typeof import("@filen/shared")>("@filen/shared")).buildInflightEntries
}))
vi.mock("@/lib/auth", () => ({ useStringifiedClient: () => null }))
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
vi.mock("@/features/notes/notes", () => ({ default: { create: vi.fn() } }))
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
import type { Note } from "@/types"

const note = { uuid: "n1", noteType: "text", title: "t", ownerId: 1, participants: [] } as unknown as Note

function edited(content: string | undefined): void {
	emitter.current?.emit("noteContentEdited", { noteUuid: "n1", contentEdited: {}, content })
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
	settled.current = Promise.resolve()
	vi.clearAllMocks()
	hold.mockImplementation(() => ({ settled: settled.current, release }))
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
})
