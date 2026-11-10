import { beforeEach, describe, expect, it, vi } from "vitest"

// Recording into the real catalog: several key combinations per action, conflicts settled by Reassign or Swap, keys a
// browser or the system keeps, and an action turned off reaching every matcher as no key.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	}
}))

const WEB = { mac: false, desktop: false }
const DESKTOP_MAC = { mac: true, desktop: true }

async function fresh() {
	vi.resetModules()

	const actions = await import("@/lib/keymap/actions")
	const registry = await import("@/lib/keymap/registry")
	const recording = await import("@/lib/keymap/recording")

	actions.registerAllActions()
	await registry.keymapOverridesLoaded()

	return { ...registry, ...recording }
}

beforeEach(() => {
	kvStore.clear()
})

describe("chords of one action", () => {
	it("withChord adds, replaces in place and never doubles; withoutChord removes one", async () => {
		const { withChord, withoutChord } = await fresh()

		expect(withChord("delete,backspace", "mod+backspace", null)).toBe("delete,backspace,mod+backspace")
		expect(withChord("delete,backspace", "f8", 1)).toBe("delete,f8")
		expect(withChord("delete,backspace", "delete", 1)).toBe("delete")
		expect(withChord("", "f2", null)).toBe("f2")
		expect(withoutChord("delete,backspace", 0)).toBe("backspace")
		expect(withoutChord("f2", 0)).toBe("")
	})

	it("records a second combination next to the first, and replaces one in place", async () => {
		const { beginRecording, commitRecordedChord, comboFor } = await fresh()

		beginRecording("list", "drive.rename", null)

		expect(await commitRecordedChord("list", "f8", WEB)).toBe("saved")
		expect(comboFor("drive.rename")).toBe("f2,f8")

		beginRecording("list", "drive.rename", 0)
		await commitRecordedChord("list", "f7", WEB)

		expect(comboFor("drive.rename")).toBe("f7,f8")
	})

	it("removing the last combination turns the action off rather than restoring its default", async () => {
		const { updateOverrides, comboFor, withoutChord } = await fresh()
		const { UNBOUND_COMBO } = await import("@filen/shared/keymap")
		const rest = withoutChord("f2", 0)

		await updateOverrides({ "drive.rename": rest === "" ? UNBOUND_COMBO : rest })

		expect(comboFor("drive.rename")).toBe("")
	})

	it("adds a special key the recorder cannot take (Escape)", async () => {
		const { beginRecording, commitRecordedChord, comboFor, isRecordingCombo } = await fresh()

		beginRecording("list", "videos.openSearch", null)

		expect(await commitRecordedChord("list", "escape", WEB)).toBe("saved")
		expect(comboFor("videos.openSearch")).toBe("slash,escape")
		expect(isRecordingCombo()).toBe(false)
	})
})

describe("conflicts", () => {
	it("holds the recording back, naming every action that has the keys", async () => {
		const { beginRecording, commitRecordedChord, currentRecordingProblem, comboFor, isRecordingCombo } = await fresh()

		beginRecording("list", "drive.rename", 0)

		expect(await commitRecordedChord("list", "n", WEB)).toBe("conflict")
		expect(isRecordingCombo()).toBe(false)
		// N is New directory here, the next page in a PDF and the next slide in a slideshow over the listing.
		expect(currentRecordingProblem()).toMatchObject({
			kind: "conflict",
			actionId: "drive.rename",
			combo: "n",
			chord: "n",
			replaced: "f2",
			conflictIds: ["drive.newDirectory", "preview.pdfNextPage", "presentation.show.next"]
		})
		expect(comboFor("drive.rename")).toBe("f2")
	})

	it("Reassign takes the keys off the other action in the same write", async () => {
		const { beginRecording, commitRecordedChord, resolveRecordingConflict, comboFor, currentRecordingProblem } = await fresh()

		beginRecording("list", "drive.rename", null)
		await commitRecordedChord("list", "n", WEB)
		await resolveRecordingConflict("reassign", WEB)

		expect(comboFor("drive.rename")).toBe("f2,n")
		expect(comboFor("drive.newDirectory")).toBe("")
		expect(comboFor("presentation.show.next")).toBe("arrowright,arrowdown,pagedown,space,enter")
		expect(currentRecordingProblem()).toBeNull()
	})

	it("Swap gives the other action the keys this one gave up", async () => {
		const { beginRecording, commitRecordedChord, resolveRecordingConflict, comboFor } = await fresh()

		beginRecording("list", "drive.rename", 0)
		await commitRecordedChord("list", "v", WEB)
		await resolveRecordingConflict("swap", WEB)

		expect(comboFor("drive.rename")).toBe("v")
		expect(comboFor("drive.toggleView")).toBe("f2")
	})

	it("Reassign also removes a key from an action with several", async () => {
		const { beginRecording, commitRecordedChord, resolveRecordingConflict, comboFor } = await fresh()

		beginRecording("list", "drive.rename", null)
		await commitRecordedChord("list", "backspace", WEB)
		await resolveRecordingConflict("reassign", WEB)

		expect(comboFor("drive.trash")).toBe("delete")
	})
})

describe("reserved keys", () => {
	it("saves a key a browser keeps on the web, with a note", async () => {
		const { beginRecording, commitRecordedChord, currentRecordingProblem, comboFor } = await fresh()

		beginRecording("list", "app.openTransfers", null)

		expect(await commitRecordedChord("list", "mod+t", WEB)).toBe("saved")
		expect(comboFor("app.openTransfers")).toBe("mod+t")
		expect(currentRecordingProblem()).toEqual({
			kind: "reserved",
			actionId: "app.openTransfers",
			chord: "mod+t",
			owner: "browser",
			blocked: false
		})
	})

	it("refuses a key the desktop app's shell takes", async () => {
		const { beginRecording, commitRecordedChord, currentRecordingProblem, comboFor } = await fresh()

		beginRecording("list", "app.openTransfers", null)

		expect(await commitRecordedChord("list", "mod+q", DESKTOP_MAC)).toBe("blocked")
		expect(comboFor("app.openTransfers")).toBe("")
		expect(currentRecordingProblem()).toMatchObject({ owner: "system", blocked: true })
	})
})

describe("an action turned off", () => {
	it("is no key to the slideshow, the text editor, the slide editor, the PDF viewer and CodeMirror", async () => {
		const { unbindAction, bindingsOf, currentKeymapRecord } = await fresh()
		const { presentationShowBindings } = await import("@/features/presentation/lib/keymap/show")
		const { presentationTextBindings } = await import("@/features/presentation/lib/keymap/text")
		const { presentationEditorKey } = await import("@/features/presentation/lib/keymap/editor")
		const { pdfViewerKey } = await import("@/features/preview/lib/pdfKeys.logic")
		const { editorKeyMatcher } = await import("@/features/preview/lib/editorKeys.logic")
		const { showKeyCommand, textKeyCommand } = await import("@filen/office/react/presentation")
		const press = (code: string, key: string, ctrlKey = false) => ({
			code,
			key,
			ctrlKey,
			metaKey: false,
			shiftKey: false,
			altKey: false
		})

		await Promise.all(
			["presentation.show.next", "presentation.text.underline", "presentation.newSlide", "preview.pdfZoomIn", "editor.find"].map(id =>
				unbindAction(id)
			)
		)

		const combos = bindingsOf(currentKeymapRecord())

		expect(showKeyCommand(press("KeyN", "n"), presentationShowBindings(combos), false)).toBeUndefined()
		expect(textKeyCommand(press("KeyU", "u", true), presentationTextBindings(combos), false)).toBeUndefined()
		expect(presentationEditorKey(press("KeyM", "m", true), combos, false)).toBeUndefined()
		expect(pdfViewerKey(press("Equal", "=", true), combos, false)).toBeUndefined()
		expect(editorKeyMatcher(combos["editor.find"] ?? "", false)).toBeUndefined()
	})

	it("and single-key shortcuts off leave the running slideshow its letter keys", async () => {
		const { setCharacterKeys, bindingsOf, currentKeymapRecord } = await fresh()

		await setCharacterKeys(false)

		const combos = bindingsOf(currentKeymapRecord())

		expect(combos["presentation.show.next"]).toBe("arrowright,arrowdown,pagedown,space,enter,n")
		expect(combos["app.toggleTheme"]).toBe("")
		expect(combos["drive.newDirectory"]).toBe("")
		expect(combos["drive.trash"]).toBe("delete,backspace")
	})
})
