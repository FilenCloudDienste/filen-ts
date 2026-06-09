import { vi, describe, it, expect } from "vitest"

// computeNextPage imports UserEventResult_Tags from @filen/sdk-rs.
// The native binding is not available in the test environment, so we stub the
// module with the exact string-enum values emitted by the generator.
vi.mock("@filen/sdk-rs", () => ({
	UserEventResult_Tags: {
		Ok: "Ok",
		Err: "Err"
	}
}))

// Heavy React + native deps pulled in transitively by events.tsx. None of their
// implementations matter — only computeNextPage (a pure function) is under test.
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("expo-router", () => ({ router: {}, useNavigation: vi.fn() }))
vi.mock("expo-status-bar", () => ({}))
vi.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: vi.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 }))
}))
vi.mock("uniwind", () => ({ useResolveClassNames: vi.fn(() => ({})) }))
vi.mock("react-i18next", () => ({
	useTranslation: vi.fn(() => ({ t: (k: string) => k }))
}))
vi.mock("@tanstack/react-query", () => ({ onlineManager: { isOnline: vi.fn(() => true) } }))
vi.mock("@filen/utils", () => ({ run: vi.fn() }))
vi.mock("@/lib/time", () => ({ simpleDate: vi.fn(() => "") }))
vi.mock("@/lib/alerts", () => ({ default: { error: vi.fn() } }))
vi.mock("@/lib/serializer", () => ({ serialize: vi.fn(x => JSON.stringify(x)) }))
vi.mock("@/features/events/queries/useEvents.query", () => ({
	default: vi.fn(),
	fetchData: vi.fn(),
	eventsQueryUpdate: vi.fn()
}))
vi.mock("@/features/events/eventDetails", () => ({
	eventKindToReadable: vi.fn(() => "")
}))
vi.mock("@/components/ui/view", () => ({ default: "View" }))
vi.mock("@/components/ui/safeAreaView", () => ({ default: "SafeAreaView" }))
vi.mock("@/components/ui/listEmpty", () => ({ default: "ListEmpty" }))
vi.mock("@/components/ui/header", () => ({ default: "Header" }))
vi.mock("@/components/ui/virtualList", () => ({ default: "VirtualList" }))
vi.mock("@/components/ui/listRow", () => ({ default: "ListRow" }))
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }))

import { computeNextPage } from "@/features/events/screens/events"
import { UserEventResult_Tags, type UserEventResult } from "@filen/sdk-rs"

// ── Minimal builders ─────────────────────────────────────────────────────────

function okEvent(id: bigint, timestamp = 0n): UserEventResult {
	return {
		tag: UserEventResult_Tags.Ok,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		inner: [{ id, timestamp } as any]
	} as unknown as UserEventResult
}

function errEvent(): UserEventResult {
	return {
		tag: UserEventResult_Tags.Err,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		inner: [{ message: "decryption failed", raw: "raw" } as any]
	} as unknown as UserEventResult
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("computeNextPage", () => {
	describe("termination — terminate: true", () => {
		it("terminates on an empty page (next.length === 0)", () => {
			const { terminate, newOk } = computeNextPage(new Set(), [])

			expect(terminate).toBe(true)
			expect(newOk).toHaveLength(0)
		})

		it("terminates when every item in the page is Err", () => {
			const next = [errEvent(), errEvent(), errEvent()]
			const { terminate, newOk } = computeNextPage(new Set(), next)

			expect(terminate).toBe(true)
			expect(newOk).toHaveLength(0)
		})

		it("terminates when the page has Ok items but all ids are already seen", () => {
			const existingOkIds = new Set<bigint>([1n, 2n, 3n])
			const next = [okEvent(1n), okEvent(2n), okEvent(3n)]
			const { terminate, newOk } = computeNextPage(existingOkIds, next)

			expect(terminate).toBe(true)
			expect(newOk).toHaveLength(0)
		})

		it("terminates when the page has both Err items and duplicate Ok ids", () => {
			const existingOkIds = new Set<bigint>([10n])
			const next = [errEvent(), okEvent(10n), errEvent()]
			const { terminate, newOk } = computeNextPage(existingOkIds, next)

			expect(terminate).toBe(true)
			expect(newOk).toHaveLength(0)
		})
	})

	describe("append — terminate: false, newOk contains only new Ok items", () => {
		it("returns all Ok items from the page when existingOkIds is empty", () => {
			const next = [okEvent(1n), okEvent(2n)]
			const { terminate, newOk } = computeNextPage(new Set(), next)

			expect(terminate).toBe(false)
			expect(newOk).toHaveLength(2)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const first = newOk[0] as any
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const second = newOk[1] as any
			expect(first.tag).toBe(UserEventResult_Tags.Ok)
			expect(first.inner[0].id).toBe(1n)
			expect(second.inner[0].id).toBe(2n)
		})

		it("filters out Err items and returns only the new Ok items", () => {
			const next = [errEvent(), okEvent(5n), errEvent(), okEvent(6n)]
			const { terminate, newOk } = computeNextPage(new Set(), next)

			expect(terminate).toBe(false)
			expect(newOk).toHaveLength(2)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			expect((newOk[0] as any).inner[0].id).toBe(5n)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			expect((newOk[1] as any).inner[0].id).toBe(6n)
		})

		it("deduplicates Ok items against existingOkIds, keeps only unseen ones", () => {
			const existingOkIds = new Set<bigint>([1n, 2n])
			const next = [okEvent(1n), okEvent(3n), okEvent(2n), okEvent(4n)]
			const { terminate, newOk } = computeNextPage(existingOkIds, next)

			expect(terminate).toBe(false)
			expect(newOk).toHaveLength(2)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			expect((newOk[0] as any).inner[0].id).toBe(3n)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			expect((newOk[1] as any).inner[0].id).toBe(4n)
		})

		it("advances on a mixed page: Err items present but at least one new Ok id", () => {
			const existingOkIds = new Set<bigint>([10n])
			const next = [errEvent(), okEvent(10n), errEvent(), okEvent(11n), errEvent()]
			const { terminate, newOk } = computeNextPage(existingOkIds, next)

			expect(terminate).toBe(false)
			expect(newOk).toHaveLength(1)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			expect((newOk[0] as any).inner[0].id).toBe(11n)
		})
	})
})
