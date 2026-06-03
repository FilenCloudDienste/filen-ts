import { vi, describe, it, expect, beforeEach } from "vitest"

// Capture the mock functions for Alert before any imports so vi.mock factories can reference them
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

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

import prompts from "@/lib/prompts"

// ---------- type aliases for call argument shapes ----------

type AlertButton = {
	text?: string
	style?: string
	onPress?: () => void
}

type AlertOptions = {
	cancelable?: boolean
	onDismiss?: () => void
}

type PromptButton = {
	text?: string
	style?: string
	onPress?: (value?: string | { login: string; password: string }) => void
}

// ---------- helper: wait one microtask so the async mutex/run wrapper fires the mock ----------

async function tick(): Promise<void> {
	await Promise.resolve()
}

/**
 * Invokes the onPress of the button at `index` in the last Alert.alert call.
 * Must be called after `await tick()`.
 */
function pressAlertButton(index: number): void {
	const [, , buttons] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[], AlertOptions?]
	buttons[index]?.onPress?.()
}

/**
 * Fires the onDismiss handler of the last Alert.alert call.
 * Must be called after `await tick()`.
 */
function dismissAlert(): void {
	const [, , , options] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[], AlertOptions?]
	options?.onDismiss?.()
}

/**
 * Returns the 4th argument (AlertOptions) of the last Alert.alert call.
 * Must be called after `await tick()`.
 */
function lastAlertOptions(): AlertOptions {
	const [, , , options] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[], AlertOptions]
	return options
}

/**
 * Invokes the onPress of the button at `index` in the last Alert.prompt call
 * with an optional value argument.
 * Must be called after `await tick()`.
 */
function pressPromptButton(index: number, value?: string | { login: string; password: string }): void {
	const [, , buttons] = mockAlertPrompt.mock.lastCall as [string, string | undefined, PromptButton[], ...unknown[]]
	buttons[index]?.onPress?.(value)
}

/**
 * Fires the onDismiss handler of the last Alert.prompt call.
 * Alert.prompt is called with 7 arguments; options is at index 6.
 * Must be called after `await tick()`.
 */
function dismissPrompt(): void {
	const args = mockAlertPrompt.mock.lastCall as [
		string,
		string | undefined,
		PromptButton[],
		string,
		string | undefined,
		unknown,
		AlertOptions
	]
	const options = args[6]
	options?.onDismiss?.()
}

beforeEach(() => {
	mockAlertAlert.mockClear()
	mockAlertPrompt.mockClear()
})

// ---------------------------------------------------------------------------
// Prompts.input — onPress value dispatch
// ---------------------------------------------------------------------------

describe("Prompts.input — onPress value dispatch", () => {
	it("resolves {cancelled: false, type: 'string', value: ''} when value is undefined", async () => {
		const promise = prompts.input()
		await tick()
		pressPromptButton(1, undefined)
		const result = await promise
		expect(result).toEqual({ cancelled: false, type: "string", value: "" })
	})

	it("resolves {cancelled: false, type: 'string', value: ''} when value is empty string", async () => {
		const promise = prompts.input()
		await tick()
		pressPromptButton(1, "")
		const result = await promise
		expect(result).toEqual({ cancelled: false, type: "string", value: "" })
	})

	it("resolves {cancelled: false, type: 'string', value: <the string>} for a non-empty string", async () => {
		const promise = prompts.input()
		await tick()
		pressPromptButton(1, "hello world")
		const result = await promise
		expect(result).toEqual({ cancelled: false, type: "string", value: "hello world" })
	})

	it("resolves {cancelled: false, type: 'credentials', login, password} for a credential object", async () => {
		const promise = prompts.input()
		await tick()
		pressPromptButton(1, { login: "user@example.com", password: "s3cr3t" })
		const result = await promise
		expect(result).toEqual({ cancelled: false, type: "credentials", login: "user@example.com", password: "s3cr3t" })
	})

	it("resolves {cancelled: true} when the Cancel button is pressed", async () => {
		const promise = prompts.input()
		await tick()
		pressPromptButton(0)
		const result = await promise
		expect(result).toEqual({ cancelled: true })
	})

	it("resolves {cancelled: true} when onDismiss fires and cancellable is true (default)", async () => {
		const promise = prompts.input({ cancellable: true })
		await tick()
		dismissPrompt()
		const result = await promise
		expect(result).toEqual({ cancelled: true })
	})

	it("does NOT resolve when onDismiss fires and cancellable is false", async () => {
		let resolved = false
		const promise = prompts.input({ cancellable: false }).then(r => {
			resolved = true
			return r
		})
		await tick()
		dismissPrompt()
		// Give microtasks a chance to run
		await Promise.resolve()
		expect(resolved).toBe(false)
		// Clean up — resolve via OK press so the promise settles and doesn't leak
		pressPromptButton(1, "cleanup")
		await promise
	})
})

// ---------------------------------------------------------------------------
// Prompts.alert — button/options argument shaping
// ---------------------------------------------------------------------------

describe("Prompts.alert — button/options argument shaping", () => {
	it("uses 'Title' as title when no options are passed", async () => {
		const promise = prompts.alert()
		await tick()
		const [title] = mockAlertAlert.mock.lastCall as [string, ...unknown[]]
		expect(title).toBe("Title")
		pressAlertButton(1)
		await promise
	})

	it("uses 'Cancel' as cancel text and 'OK' as ok text by default", async () => {
		const promise = prompts.alert()
		await tick()
		const [, , buttons] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[]]
		expect(buttons[0]?.text).toBe("Cancel")
		expect(buttons[1]?.text).toBe("OK")
		pressAlertButton(1)
		await promise
	})

	it("applies 'destructive' style to ok button when options.destructive is true", async () => {
		const promise = prompts.alert({ destructive: true })
		await tick()
		const [, , buttons] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[]]
		expect(buttons[1]?.style).toBe("destructive")
		pressAlertButton(1)
		await promise
	})

	it("applies 'default' style to ok button when options.destructive is false", async () => {
		const promise = prompts.alert({ destructive: false })
		await tick()
		const [, , buttons] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[]]
		expect(buttons[1]?.style).toBe("default")
		pressAlertButton(1)
		await promise
	})

	it("applies 'default' style to ok button when destructive is absent", async () => {
		const promise = prompts.alert()
		await tick()
		const [, , buttons] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[]]
		expect(buttons[1]?.style).toBe("default")
		pressAlertButton(1)
		await promise
	})

	it("sets cancelable: false in Alert options when options.cancellable is false", async () => {
		const promise = prompts.alert({ cancellable: false })
		await tick()
		const options = lastAlertOptions()
		expect(options.cancelable).toBe(false)
		pressAlertButton(1)
		await promise
	})

	it("does NOT resolve via onDismiss when options.cancellable is false", async () => {
		let resolved = false
		const promise = prompts.alert({ cancellable: false }).then(r => {
			resolved = true
			return r
		})
		await tick()
		dismissAlert()
		await Promise.resolve()
		expect(resolved).toBe(false)
		pressAlertButton(1)
		await promise
	})

	it("resolves {cancelled: true} when onDismiss fires and options.cancellable is true", async () => {
		const promise = prompts.alert({ cancellable: true })
		await tick()
		dismissAlert()
		const result = await promise
		expect(result).toEqual({ cancelled: true })
	})

	it("resolves {cancelled: false} when the OK button is pressed", async () => {
		const promise = prompts.alert()
		await tick()
		pressAlertButton(1)
		const result = await promise
		expect(result).toEqual({ cancelled: false })
	})

	it("resolves {cancelled: true} when the Cancel button is pressed", async () => {
		const promise = prompts.alert()
		await tick()
		pressAlertButton(0)
		const result = await promise
		expect(result).toEqual({ cancelled: true })
	})

	it("two sequential calls each trigger Alert.alert exactly once with their own title", async () => {
		// Tests that repeated calls each produce distinct Alert.alert invocations.
		// Note: full mutual-exclusion ordering cannot be verified with the no-op Semaphore mock
		// (the real Semaphore serialises calls; the mock permits concurrent entry). The ordering
		// guarantee is therefore deferred — see the `deferred` section in the test agent output.
		const first = prompts.alert({ title: "first" })
		await tick()
		pressAlertButton(1)
		await first

		const second = prompts.alert({ title: "second" })
		await tick()
		pressAlertButton(1)
		await second

		expect(mockAlertAlert).toHaveBeenCalledTimes(2)
		expect(mockAlertAlert.mock.calls[0]?.[0]).toBe("first")
		expect(mockAlertAlert.mock.calls[1]?.[0]).toBe("second")
	})
})

// ---------------------------------------------------------------------------
// Prompts.info — single-button alert shaping
// ---------------------------------------------------------------------------

describe("Prompts.info — single-button alert shaping", () => {
	it("builds a buttons array with exactly one entry (no cancel button)", async () => {
		const promise = prompts.info()
		await tick()
		const [, , buttons] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[]]
		expect(buttons).toHaveLength(1)
		buttons[0]?.onPress?.()
		await promise
	})

	it("resolves void when the OK button is pressed", async () => {
		const promise = prompts.info()
		await tick()
		const [, , buttons] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[]]
		buttons[0]?.onPress?.()
		const result = await promise
		expect(result).toBeUndefined()
	})

	it("always resolves void when onDismiss fires (no cancellable guard)", async () => {
		const promise = prompts.info()
		await tick()
		dismissAlert()
		const result = await promise
		expect(result).toBeUndefined()
	})

	it("applies 'destructive' style to the single button when options.destructive is true", async () => {
		const promise = prompts.info({ destructive: true })
		await tick()
		const [, , buttons] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[]]
		expect(buttons[0]?.style).toBe("destructive")
		buttons[0]?.onPress?.()
		await promise
	})

	it("applies 'default' style to the single button when options.destructive is absent", async () => {
		const promise = prompts.info()
		await tick()
		const [, , buttons] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[]]
		expect(buttons[0]?.style).toBe("default")
		buttons[0]?.onPress?.()
		await promise
	})

	it("uses custom okText for the single button label", async () => {
		const promise = prompts.info({ okText: "Got it" })
		await tick()
		const [, , buttons] = mockAlertAlert.mock.lastCall as [string, string | undefined, AlertButton[]]
		expect(buttons[0]?.text).toBe("Got it")
		buttons[0]?.onPress?.()
		await promise
	})
})
