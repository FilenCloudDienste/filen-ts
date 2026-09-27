import { beforeEach, describe, expect, it, vi } from "vitest"

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

import { createUnlockedToaster, isUnlockedForeground, whenUnlockedForeground } from "@/lib/unlockedForeground"
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
	it("keeps the latest of each kind held under the lock, and shows them in order once unlocked", async () => {
		useAppStore.setState({ biometricUnlocked: false })

		const shown: string[] = []
		const toaster = createUnlockedToaster(message => shown.push(message))

		toaster.notify("saveReplaced", "your save replaced theirs")
		toaster.notify("updated", "updated once")
		toaster.notify("updated", "updated twice")
		await Promise.resolve()

		expect(shown).toEqual([])

		useAppStore.getState().setBiometricUnlocked(true)
		await Promise.resolve()
		await Promise.resolve()

		expect(shown).toEqual(["your save replaced theirs", "updated twice"])
	})

	it("shows nothing once disposed", async () => {
		useAppStore.setState({ biometricUnlocked: false })

		const shown: string[] = []
		const toaster = createUnlockedToaster(message => shown.push(message))

		toaster.notify("updated", "stale")
		toaster.dispose()
		useAppStore.getState().setBiometricUnlocked(true)
		await Promise.resolve()
		await Promise.resolve()

		expect(shown).toEqual([])
	})
})
