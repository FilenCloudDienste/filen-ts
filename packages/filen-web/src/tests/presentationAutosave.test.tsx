// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { autosaveTier } from "@/features/presentation/lib/autosavePolicy"
import { usePresentationAutosave, type PresentationAutosaveInput } from "@/features/presentation/hooks/usePresentationAutosave"

// When the editor asks the overlay to autosave a deck: after 30 s idle up to 32 MiB; up to 256 MiB no sooner than five
// minutes after the last stored save, the first one as soon as 1 KiB changed and else once the oldest change is five
// minutes old; never above, nor while the user's setting is off or the browser is offline.

const { settings, online } = vi.hoisted(() => ({ settings: { loaded: true, autosave: true }, online: { value: true } }))

vi.mock("@/features/office/lib/officeSettings", () => ({
	loadOfficeSettings: () => Promise.resolve(),
	useOfficeSettings: () => settings
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => online.value }))

const MiB = 1024 * 1024
const SECOND = 1000
const MINUTE = 60 * SECOND

beforeEach(() => {
	vi.useFakeTimers({ now: 1_000_000 })
})

afterEach(() => {
	vi.useRealTimers()
	settings.autosave = true
	online.value = true
})

function mount(bytes: number) {
	const onAutosave = vi.fn(() => true)
	const initial: PresentationAutosaveInput = {
		tier: autosaveTier(bytes, false),
		revision: 0,
		dirty: false,
		dirtyBytes: undefined,
		canSave: true,
		onAutosave
	}
	const hook = renderHook((input: PresentationAutosaveInput) => usePresentationAutosave(input), { initialProps: initial })
	let revision = 0
	const edit = (dirtyBytes?: number): void => {
		revision++
		hook.rerender({ ...initial, revision, dirty: true, dirtyBytes })
	}
	const advance = (ms: number): void => {
		act(() => {
			vi.advanceTimersByTime(ms)
		})
	}

	const saved = (): void => {
		act(() => {
			hook.result.current.settled({ stored: true, failed: false })
		})
		hook.rerender({ ...initial, revision, dirty: false })
	}

	return { hook, onAutosave, edit, advance, saved }
}

describe("presentation autosave tiers", () => {
	it("saves a 20 MiB deck 30 s after the last edit, an edit in between putting it off", () => {
		const { onAutosave, edit, advance } = mount(20 * MiB)

		edit()
		advance(20 * SECOND)
		edit()
		advance(29 * SECOND)
		expect(onAutosave).not.toHaveBeenCalled()
		advance(1 * SECOND)
		expect(onAutosave).toHaveBeenCalledTimes(1)
	})

	it("saves a 100 MiB deck no sooner than five minutes after its last stored save", () => {
		const { onAutosave, edit, advance, saved } = mount(100 * MiB)

		edit()
		// The first unsaved edit is five minutes old before the first save (the dirty bytes are unknown).
		advance(5 * MINUTE)
		expect(onAutosave).toHaveBeenCalledTimes(1)

		saved()
		edit()
		advance(30 * SECOND)
		advance(4 * MINUTE)
		expect(onAutosave).toHaveBeenCalledTimes(1)
		advance(30 * SECOND)
		expect(onAutosave).toHaveBeenCalledTimes(2)
	})

	it("saves a 100 MiB deck 30 s after a 2 KiB edit, a smaller one waiting five minutes", () => {
		const big = mount(100 * MiB)

		big.edit(2048)
		big.advance(29 * SECOND)
		expect(big.onAutosave).not.toHaveBeenCalled()
		big.advance(1 * SECOND)
		expect(big.onAutosave).toHaveBeenCalledTimes(1)

		const small = mount(100 * MiB)

		small.edit(200)
		small.advance(4 * MINUTE + 59 * SECOND)
		expect(small.onAutosave).not.toHaveBeenCalled()
		small.advance(1 * SECOND)
		expect(small.onAutosave).toHaveBeenCalledTimes(1)
	})

	it("does not ask again at once after a save that stored nothing while the deck stays dirty", () => {
		const { hook, onAutosave, edit, advance } = mount(1 * MiB)

		edit()
		advance(30 * SECOND)
		expect(onAutosave).toHaveBeenCalledTimes(1)
		// The session answered "unchanged" while the page still reads the deck dirty.
		for (let k = 0; k < 5; k++) {
			act(() => {
				hook.result.current.settled({ stored: false, failed: false })
			})
			advance(0)
		}
		advance(1 * SECOND)
		expect(onAutosave).toHaveBeenCalledTimes(1)
		// It backs off as a failure does: the interval, doubled for each in a row.
		advance(29 * SECOND)
		expect(onAutosave).toHaveBeenCalledTimes(1)
	})

	it("never autosaves a 300 MiB deck, nor an encrypted one over 64 MiB", () => {
		const large = mount(300 * MiB)

		large.edit()
		large.advance(60 * MINUTE)
		expect(large.onAutosave).not.toHaveBeenCalled()
		expect(large.hook.result.current.active).toBe(false)
		expect(autosaveTier(100 * MiB, true)).toEqual({ kind: "off", reason: "encrypted" })
	})

	it("waits while the setting is off or the browser is offline", () => {
		settings.autosave = false

		const off = mount(1 * MiB)

		off.edit()
		off.advance(10 * MINUTE)
		expect(off.onAutosave).not.toHaveBeenCalled()

		settings.autosave = true
		online.value = false

		const offline = mount(1 * MiB)

		offline.edit()
		offline.advance(10 * MINUTE)
		expect(offline.onAutosave).not.toHaveBeenCalled()
	})

	it("after a failed save waits the interval, doubled for each failure in a row", () => {
		const { hook, onAutosave, edit, advance } = mount(1 * MiB)

		edit()
		advance(30 * SECOND)
		expect(onAutosave).toHaveBeenCalledTimes(1)
		act(() => {
			hook.result.current.settled({ stored: false, failed: true })
		})
		advance(29 * SECOND)
		expect(onAutosave).toHaveBeenCalledTimes(1)
		advance(1 * SECOND)
		expect(onAutosave).toHaveBeenCalledTimes(2)
		act(() => {
			hook.result.current.settled({ stored: false, failed: true })
		})
		advance(59 * SECOND)
		expect(onAutosave).toHaveBeenCalledTimes(2)
		advance(1 * SECOND)
		expect(onAutosave).toHaveBeenCalledTimes(3)
	})

	it("tries again a little later when a save could not start", () => {
		const { onAutosave, edit, advance } = mount(1 * MiB)

		onAutosave.mockReturnValueOnce(false)
		edit()
		advance(30 * SECOND)
		expect(onAutosave).toHaveBeenCalledTimes(1)
		advance(5 * SECOND)
		// The look again it scheduled, once React applied it.
		advance(0)
		expect(onAutosave).toHaveBeenCalledTimes(2)
	})
})
