import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@blazejkustra/react-native-alert", () => ({ default: { alert: vi.fn() } }))

import Alert from "@blazejkustra/react-native-alert"
import prompts from "@/lib/prompts"

type AlertButton = { text: string; style?: string; onPress?: () => void }

describe("prompts.alert — singleButton", () => {
	beforeEach(() => {
		vi.mocked(Alert.alert).mockClear()
	})

	it("renders exactly one button and resolves not-cancelled on press", async () => {
		const p = prompts.alert({ title: "t", message: "m", singleButton: true })

		await vi.waitFor(() => expect(Alert.alert).toHaveBeenCalled())

		const buttons = (vi.mocked(Alert.alert).mock.calls[0]?.[2] ?? []) as AlertButton[]

		expect(buttons).toHaveLength(1)

		buttons[0]?.onPress?.()

		await expect(p).resolves.toEqual({ cancelled: false })
	})

	it("renders two buttons by default (cancel + ok)", async () => {
		const p = prompts.alert({ title: "t", message: "m" })

		await vi.waitFor(() => expect(Alert.alert).toHaveBeenCalled())

		const buttons = (vi.mocked(Alert.alert).mock.calls[0]?.[2] ?? []) as AlertButton[]

		expect(buttons).toHaveLength(2)

		buttons[1]?.onPress?.()

		await expect(p).resolves.toEqual({ cancelled: false })
	})
})
