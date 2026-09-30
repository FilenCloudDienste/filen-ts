// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import type { ReactElement, ReactNode } from "react"

type Family = {
	getImageSource: (name: string, size: number, color: string) => Promise<unknown>
}

const h = vi.hoisted(() => ({
	isAuthed: { value: true },
	unread: { value: 0 },
	foreground: { value: "#000000" },
	families: [] as unknown[],
	getImageSource: vi.fn()
}))

vi.mock("react-native", () => ({ Platform: { OS: "android", select: (spec: Record<string, unknown>) => spec["default"] } }))
vi.mock("uniwind", () => ({
	useResolveClassNames: (className: string) =>
		className === "text-foreground" ? { color: h.foreground.value } : { color: "#ff0000", backgroundColor: "#ffffff" }
}))
vi.mock("@/lib/auth", () => ({ useIsAuthed: () => h.isAuthed.value }))
vi.mock("@/features/chats/hooks/useChatsUnreadCount", () => ({ default: () => h.unread.value }))
vi.mock("@/features/contacts/queries/useContactRequests.query", () => ({ default: () => ({ data: undefined }) }))
vi.mock("@/queries/useAccount.query", () => ({ default: () => ({ data: undefined }) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: { getImageSource: h.getImageSource } }))
vi.mock("expo-router/unstable-native-tabs", () => {
	const Passthrough = ({ children }: { children?: ReactNode }) => children
	const Nothing = () => null
	const Icon = ({ src }: { src?: ReactElement<{ family: unknown }> }) => {
		if (src) {
			h.families.push(src.props.family)
		}

		return null
	}

	return {
		NativeTabs: Object.assign(Passthrough, {
			Trigger: Object.assign(Passthrough, {
				Label: Nothing,
				Badge: Nothing,
				Icon,
				VectorIcon: Nothing
			})
		})
	}
})

import { render, cleanup } from "@testing-library/react"
import TabsLayout from "@/routes/tabs/_layout"

function lastFamily(): Family {
	return h.families[h.families.length - 1] as Family
}

// expo-router's conversion: family.getImageSource(name, 24, "white") on every children change.
function convert(family: Family): Promise<unknown>[] {
	return ["folder", "photo-library", "book", "messenger", "more-horiz"].map(name => family.getImageSource(name, 24, "white"))
}

beforeEach(() => {
	h.isAuthed.value = true
	h.unread.value = 0
	h.foreground.value = "#000000"
	h.families.length = 0
	h.getImageSource.mockReset()
	h.getImageSource.mockImplementation((name: string) => Promise.resolve({ uri: `file:///cache/${name}.png` }))
})

afterEach(() => {
	cleanup()
})

describe("tab bar vector icon cache", () => {
	it("reuses the rasterized icon promises across badge changes", () => {
		const view = render(<TabsLayout />)
		const first = convert(lastFamily())

		h.unread.value = 3
		view.rerender(<TabsLayout />)

		const second = convert(lastFamily())

		expect(second).toEqual(first)
		second.forEach((promise, index) => expect(promise).toBe(first[index]))
		expect(h.getImageSource).toHaveBeenCalledTimes(5)
		expect(h.getImageSource).toHaveBeenCalledWith("folder", 24, "white")
	})

	it("regenerates the icons after a theme change", () => {
		const view = render(<TabsLayout />)
		const first = convert(lastFamily())

		h.foreground.value = "#ffffff"
		view.rerender(<TabsLayout />)

		const second = convert(lastFamily())

		second.forEach((promise, index) => expect(promise).not.toBe(first[index]))
		expect(h.getImageSource).toHaveBeenCalledTimes(10)
	})

	it("starts a fresh cache after logout and re-login", () => {
		const view = render(<TabsLayout />)
		const first = convert(lastFamily())

		h.isAuthed.value = false
		view.rerender(<TabsLayout />)
		h.isAuthed.value = true
		view.rerender(<TabsLayout />)

		const second = convert(lastFamily())

		second.forEach((promise, index) => expect(promise).not.toBe(first[index]))
		expect(h.getImageSource).toHaveBeenCalledTimes(10)
	})

	it("evicts a failed load so the next conversion retries", async () => {
		h.getImageSource.mockImplementationOnce(() => Promise.reject(new Error("render failed")))

		render(<TabsLayout />)

		const family = lastFamily()
		const failed = family.getImageSource("folder", 24, "white")

		await expect(failed).rejects.toThrow("render failed")

		const retried = family.getImageSource("folder", 24, "white")

		expect(retried).not.toBe(failed)
		await expect(retried).resolves.toEqual({ uri: "file:///cache/folder.png" })
		expect(h.getImageSource).toHaveBeenCalledTimes(2)
	})
})
