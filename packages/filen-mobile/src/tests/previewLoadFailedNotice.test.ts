// @vitest-environment happy-dom

import { vi, describe, it, expect } from "vitest"
import { createElement } from "react"
import { render, fireEvent } from "@testing-library/react"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (k: string) => k })
}))

vi.mock("@filen/utils", () => ({
	cn: (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" ")
}))

vi.mock("@/components/ui/view", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { children?: unknown; className?: string }) =>
			h("div", { "data-testid": "root", className: props.className }, props.children as never)
	}
})

vi.mock("@/components/ui/text", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { children?: unknown }) => h("span", null, props.children as never)
	}
})

vi.mock("@/components/ui/pressables", async () => {
	const { createElement: h } = await import("react")

	return {
		PressableScale: (props: { onPress: () => void; children?: unknown }) =>
			h("button", { "data-testid": "retry", onClick: props.onPress }, props.children as never)
	}
})

vi.mock("@expo/vector-icons/Ionicons", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { name: string }) => h("i", { "data-icon": props.name })
	}
})

import PreviewLoadFailedNotice from "@/components/drivePreview/previewLoadFailedNotice"

describe("PreviewLoadFailedNotice", () => {
	it("renders the warning icon, preview_load_failed and a Retry that calls onRetry", () => {
		const onRetry = vi.fn()
		const { container } = render(createElement(PreviewLoadFailedNotice, { onRetry }))

		expect(container.querySelector("i")?.getAttribute("data-icon")).toBe("warning-outline")
		expect(container.textContent).toContain("preview_load_failed")

		const retry = container.querySelector("[data-testid='retry']")

		expect(retry?.textContent).toBe("retry")

		fireEvent.click(retry as Element)

		expect(onRetry).toHaveBeenCalledTimes(1)
	})

	it("merges the caller's className onto the default layout classes (the gallery passes bg-transparent)", () => {
		const { container } = render(createElement(PreviewLoadFailedNotice, { onRetry: vi.fn(), className: "bg-transparent" }))

		expect(container.querySelector("[data-testid='root']")?.getAttribute("class")).toBe(
			"flex-1 items-center justify-center px-8 bg-transparent"
		)
	})
})
