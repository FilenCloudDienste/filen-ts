import { vi, describe, it, expect, beforeEach } from "vitest"

// The real prompts queue (@filen/shared's Semaphore), app store and unlock gate: what the lock screen's PIN
// prompt and a gated alert share.
const { mockAlertAlert, mockAlertPrompt } = vi.hoisted(() => ({
	mockAlertAlert: vi.fn(),
	mockAlertPrompt: vi.fn()
}))

vi.mock("@blazejkustra/react-native-alert", () => ({
	default: {
		alert: mockAlertAlert,
		prompt: mockAlertPrompt
	}
}))

import prompts from "@/lib/prompts"
import useAppStore from "@/stores/useApp.store"
import { unlockedForegroundGate } from "@/lib/unlockedForeground"

type AlertButton = {
	onPress?: () => void
}

type AlertOptions = {
	onDismiss?: () => void
}

type PromptButton = {
	onPress?: (value?: string) => void
}

function pressAlertButton(index: number): void {
	const [, , buttons] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[], AlertOptions?]

	buttons[index]?.onPress?.()
}

function dismissAlert(): void {
	const [, , , options] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[], AlertOptions?]

	options?.onDismiss?.()
}

describe("prompts — gate", () => {
	beforeEach(() => {
		mockAlertAlert.mockReset()
		mockAlertPrompt.mockReset()
		useAppStore.setState({ biometricUnlocked: true })
	})

	async function settle(): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, 0))
	}

	it("a gated alert waiting for the unlock never holds the queue: the lock's PIN prompt goes first", async () => {
		// An alert on screen, and a notice queued behind it that must not show over the lock.
		const first = prompts.alert({ title: "first" })
		await settle()

		const notice = prompts.info({ title: "notice", gate: unlockedForegroundGate })
		await settle()

		// The app locks; the lock screen asks for the PIN, through the same queue.
		useAppStore.getState().setBiometricUnlocked(false)

		const pin = prompts.input({ title: "pin" })
		await settle()

		pressAlertButton(1)
		await first
		await settle()

		// The PIN prompt shows; the notice waits, holding nothing.
		expect(mockAlertPrompt).toHaveBeenCalledTimes(1)
		expect(mockAlertAlert).toHaveBeenCalledTimes(1)

		const [, , buttons] = mockAlertPrompt.mock.lastCall as [string, string | undefined, PromptButton[]]
		buttons[1]?.onPress?.("1234")
		await pin

		useAppStore.getState().setBiometricUnlocked(true)
		await settle()

		expect(mockAlertAlert).toHaveBeenCalledTimes(2)
		expect(mockAlertAlert.mock.lastCall?.[0]).toBe("notice")

		dismissAlert()
		await notice
	})

	it("a gated alert whose turn comes while locked lets the queue go, and shows once unlocked", async () => {
		const first = prompts.alert({ title: "first" })
		await settle()

		const notice = prompts.confirm3({ title: "gated", primaryText: "P", destructiveText: "D", gate: unlockedForegroundGate })
		await settle()

		// Locked after it passed the gate, while it waited for its turn.
		useAppStore.getState().setBiometricUnlocked(false)
		pressAlertButton(1)
		await first
		await settle()

		expect(mockAlertAlert).toHaveBeenCalledTimes(1)

		// Another alert gets the queue meanwhile.
		const other = prompts.alert({ title: "other" })
		await settle()

		expect(mockAlertAlert).toHaveBeenCalledTimes(2)

		pressAlertButton(1)
		await other

		useAppStore.getState().setBiometricUnlocked(true)
		await settle()

		expect(mockAlertAlert.mock.lastCall?.[0]).toBe("gated")

		dismissAlert()
		await expect(notice).resolves.toBe("cancel")
	})
})
