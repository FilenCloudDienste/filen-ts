import { vi } from "vitest"

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@expo/vector-icons/Ionicons", () => ({ default: () => null }))
vi.mock("@filen/utils", () => ({ bpsToReadable: (n: number) => String(n) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }))
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({ color: "#fff" }) }))
vi.mock("@/components/ui/view", () => ({ default: () => null }))
vi.mock("@/components/ui/text", () => ({ default: () => null }))
vi.mock("@/components/ui/pressables", () => ({ PressableScale: () => null }))
vi.mock("@/components/floatingBar/animatedProgressBar", () => ({ default: () => null }))
vi.mock("zustand/shallow", () => ({ useShallow: (fn: unknown) => fn }))

import { describe, it, expect } from "vitest"
import { anyActiveTransfer } from "@/components/floatingBar/transfersSlot"
import type { Transfer } from "@/features/transfers/store/useTransfers.store"

function makeTransfer(paused: boolean): Transfer {
	return {
		id: "t",
		size: 1000,
		bytesTransferred: 0,
		startedAt: Date.now(),
		paused,
		type: "uploadFile",
		errors: { upload: [], scan: [], unknown: [] },
		localFileOrDir: {},
		parent: {},
		abort: () => {},
		pause: () => {},
		resume: () => {}
	} as unknown as Transfer
}

describe("anyActiveTransfer", () => {
	it("returns false for an empty list", () => {
		expect(anyActiveTransfer([])).toBe(false)
	})

	it("returns false when the single transfer is paused", () => {
		expect(anyActiveTransfer([makeTransfer(true)])).toBe(false)
	})

	it("returns true when the single transfer is active", () => {
		expect(anyActiveTransfer([makeTransfer(false)])).toBe(true)
	})

	it("returns false when all transfers are paused", () => {
		expect(anyActiveTransfer([makeTransfer(true), makeTransfer(true), makeTransfer(true)])).toBe(false)
	})

	it("returns true when at least one transfer is active among many paused", () => {
		expect(anyActiveTransfer([makeTransfer(true), makeTransfer(false), makeTransfer(true)])).toBe(true)
	})

	it("returns true when all transfers are active", () => {
		expect(anyActiveTransfer([makeTransfer(false), makeTransfer(false)])).toBe(true)
	})
})
