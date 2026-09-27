import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { appState } = vi.hoisted(() => ({
	appState: { current: "active", listeners: new Set<(state: string) => void>() }
}))

vi.mock("react-native", () => ({
	AppState: {
		get currentState() {
			return appState.current
		},
		addEventListener: (_type: string, listener: (state: string) => void) => {
			appState.listeners.add(listener)

			return { remove: () => appState.listeners.delete(listener) }
		}
	}
}))

import { createUnlockedNotices, createUnlockedToaster, isUnlockedForeground, whenUnlockedForeground } from "@/lib/unlockedForeground"
import useAppStore from "@/stores/useApp.store"

function setAppState(next: string): void {
	appState.current = next

	for (const listener of appState.listeners) {
		listener(next)
	}
}

beforeEach(() => {
	appState.current = "active"
	appState.listeners.clear()
	useAppStore.setState({ biometricUnlocked: true })
})

describe("whenUnlockedForeground", () => {
	it("resolves at once when the app is unlocked and in front", async () => {
		expect(isUnlockedForeground()).toBe(true)
		await expect(whenUnlockedForeground()).resolves.toBeUndefined()
	})

	it("waits for both the unlock and the foreground, then lets go of its listeners", async () => {
		useAppStore.setState({ biometricUnlocked: false })
		appState.current = "background"

		let resolved = false

		void whenUnlockedForeground().then(() => {
			resolved = true
		})

		setAppState("active")
		await Promise.resolve()

		expect(resolved).toBe(false)

		useAppStore.getState().setBiometricUnlocked(true)
		await Promise.resolve()

		expect(resolved).toBe(true)
		expect(appState.listeners.size).toBe(0)
	})
})

describe("createUnlockedToaster", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("keeps the latest of each kind held under the lock, and shows them one after another once unlocked", async () => {
		vi.useFakeTimers()
		useAppStore.setState({ biometricUnlocked: false })

		const shown: string[] = []
		const toaster = createUnlockedToaster(message => shown.push(message))

		toaster.notify("savedAsNew", "saved as a copy")
		toaster.notify("updated", "updated once")
		toaster.notify("updated", "updated twice")
		await vi.advanceTimersByTimeAsync(0)

		expect(shown).toEqual([])

		useAppStore.getState().setBiometricUnlocked(true)
		await vi.advanceTimersByTimeAsync(0)

		// iOS keeps no toast queue: the next one waits for the one before to go.
		expect(shown).toEqual(["saved as a copy"])

		await vi.advanceTimersByTimeAsync(3200)

		expect(shown).toEqual(["saved as a copy", "updated twice"])
	})

	it("shows nothing once disposed, even what was already queued", async () => {
		vi.useFakeTimers()

		const shown: string[] = []
		const toaster = createUnlockedToaster(message => shown.push(message))

		toaster.notify("a", "first")
		toaster.notify("b", "second")
		await vi.advanceTimersByTimeAsync(0)
		toaster.dispose()
		await vi.advanceTimersByTimeAsync(5000)

		expect(shown).toEqual(["first"])
	})
})

describe("createUnlockedNotices", () => {
	it("shows each kind's latest notice as an alert once unlocked, one at a time", async () => {
		useAppStore.setState({ biometricUnlocked: false })

		const shown: string[] = []
		let dismiss: () => void = () => undefined
		const announce = createUnlockedNotices(
			(title, message) =>
				new Promise<void>(resolve => {
					shown.push(`${title}: ${message}`)
					dismiss = resolve
				})
		)

		announce("saveReplaced", "Replaced", "your save replaced theirs")
		announce("savedElsewhere", "Elsewhere", "old")
		announce("savedElsewhere", "Elsewhere", "new")
		await Promise.resolve()

		expect(shown).toEqual([])

		useAppStore.getState().setBiometricUnlocked(true)
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(shown).toEqual(["Replaced: your save replaced theirs"])

		dismiss()
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(shown).toEqual(["Replaced: your save replaced theirs", "Elsewhere: new"])
	})
})
