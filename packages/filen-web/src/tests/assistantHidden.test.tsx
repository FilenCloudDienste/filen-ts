// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import "@/lib/i18n"
import { assistant } from "@/locales/en/assistant"
import { settingsAssistant } from "@/locales/en/settings/assistant"
import { assistantHiddenPreference } from "@/features/assistant/store/assistantHidden"
import { useAssistantRunsHere, useTransformOffered } from "@/features/assistant/store/useAssistantOnDevice"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { registerAssistantTransformer, transformAssistantText } from "@/features/assistant/store/assistantTransform"
import {
	closeHiddenAssistant,
	downloadAssistantModel,
	registerAssistantSession,
	sendAssistantMessage
} from "@/features/assistant/store/assistantSession"
import type { AssistantSession } from "@/features/assistant/types"
import { NotesDraftButton } from "@/features/presentation/components/notesDraft"
import { HideAssistantRow } from "@/features/settings/components/assistant/hideAssistantRow"
import { ALL_ACTIONS, shortcutCatalog, withoutAssistantActions } from "@/lib/keymap/actions"
import { CURRENT_PLATFORM } from "@/lib/keymap/registry"
import { DEFAULT_RECORD } from "@/lib/keymap/storage"

// Hide Assistant (Settings > Assistant): the device gates every ✨ entry point reads answer no, the shortcuts list
// leaves the assistant's keys out, nothing reaches the model, and hiding mid-session closes the panel and stops a turn.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const { saveSynced } = vi.hoisted(() => ({ saveSynced: vi.fn() }))

vi.mock("@/features/settings/components/office/syncedSetting", () => ({ saveSyncedOfficeSetting: saveSynced }))
vi.mock("@/features/office/lib/officeSettings", () => ({ useOfficeSettings: () => ({ loaded: true }) }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

const MODEL = { id: "m", name: "Model", sizeBytes: 1 }

function fakeSession(): AssistantSession {
	return {
		getModelState: () => ({ kind: "ready", model: MODEL }),
		subscribe: () => () => undefined,
		setPanelOpen: () => undefined,
		downloadModel: vi.fn(),
		resumeInterruptedDownload: vi.fn(),
		loadModel: vi.fn(),
		noteActivity: () => undefined,
		cancelDownload: vi.fn(),
		deleteModel: () => Promise.resolve(),
		send: vi.fn(() => "turn"),
		act: () => null,
		cancel: vi.fn(),
		confirm: () => undefined,
		reject: () => undefined,
		reset: () => undefined,
		getHistory: () => [],
		shutdown: () => undefined
	}
}

beforeEach(() => {
	assistantHiddenPreference.adopt(false)
	useAssistantStore.setState({ modelState: { kind: "ready", model: MODEL }, panelOpen: false, drawerOpen: false })
	saveSynced.mockClear()
})

afterEach(() => {
	cleanup()
	assistantHiddenPreference.adopt(false)
})

describe("the device gate", () => {
	it("offers the assistant until it is hidden, and again once shown", () => {
		const { result } = renderHook(() => ({ runs: useAssistantRunsHere(), offered: useTransformOffered() }))

		expect(result.current).toEqual({ runs: true, offered: true })

		act(() => {
			assistantHiddenPreference.adopt(true)
		})

		expect(result.current).toEqual({ runs: false, offered: false })

		act(() => {
			assistantHiddenPreference.adopt(false)
		})

		expect(result.current).toEqual({ runs: true, offered: true })
	})

	it("drops an entry point that reads it (the slide notes draft)", () => {
		assistantHiddenPreference.adopt(true)
		render(<NotesDraftButton onDraft={() => undefined} />)

		expect(screen.queryByRole("button", { name: assistant.assistantNotesDraft })).toBeNull()

		act(() => {
			assistantHiddenPreference.adopt(false)
		})

		expect(screen.getByRole("button", { name: assistant.assistantNotesDraft })).toBeTruthy()
	})
})

describe("the model while hidden", () => {
	it("is never reached by a helper", async () => {
		const run = vi.fn(() => Promise.resolve({ ok: true as const, text: "x", truncated: false, foreignLinks: [] }))
		const unregister = registerAssistantTransformer({ run, shutdown: () => undefined })

		assistantHiddenPreference.adopt(true)

		const outcome = await transformAssistantText({
			kind: "rewrite",
			text: "hello",
			language: "en",
			signal: new AbortController().signal,
			onText: () => undefined
		})

		expect(outcome).toEqual({ ok: false, error: "model-unavailable" })
		expect(run).not.toHaveBeenCalled()
		unregister()
	})

	it("neither downloads nor starts a turn, and hiding closes the panel and stops the turn", () => {
		const session = fakeSession()
		const unregister = registerAssistantSession(session)

		useAssistantStore.setState({ panelOpen: true, drawerOpen: true })
		assistantHiddenPreference.adopt(true)
		downloadAssistantModel()

		expect(sendAssistantMessage("hi")).toBe(false)
		expect(session.downloadModel).not.toHaveBeenCalled()
		expect(session.send).not.toHaveBeenCalled()

		closeHiddenAssistant()

		expect(useAssistantStore.getState().panelOpen).toBe(false)
		expect(useAssistantStore.getState().drawerOpen).toBe(false)
		expect(session.cancel).toHaveBeenCalledOnce()
		unregister()
	})
})

describe("the shortcuts list", () => {
	it("leaves the assistant's keys out while hidden", () => {
		const full = shortcutCatalog(DEFAULT_RECORD, CURRENT_PLATFORM)
		const hidden = withoutAssistantActions(full)
		const ids = hidden.actions.map(action => action.id)

		expect(full.byId.has("app.toggleAssistant")).toBe(true)
		expect(ids).not.toContain("app.toggleAssistant")
		expect(ids).not.toContain("app.assistantTransform")
		expect(hidden.byId.has("app.toggleAssistant")).toBe(false)
		expect(hidden.groups.flatMap(group => group.actions)).toHaveLength(hidden.actions.length)
		expect(hidden.actions.length).toBe(full.actions.length - 2)
		expect(ALL_ACTIONS.length).toBeGreaterThan(hidden.actions.length)
	})
})

describe("the settings switch", () => {
	it("hides at once and saves the synced setting", () => {
		render(<HideAssistantRow />)

		const toggle = screen.getByRole("switch", { name: settingsAssistant.settingsAssistantHide })

		fireEvent.click(toggle)

		expect(assistantHiddenPreference.get()).toBe(true)
		expect(saveSynced).toHaveBeenCalledWith("hideAssistant", true)
	})
})
