// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { useRef } from "react"
import { slideRef } from "@filen/office/core/presentation"
import {
	IDLE_PRESENTATION,
	type PresentationActionPolicy,
	type PresentationDocument,
	type PresentationStore
} from "@filen/office/react/presentation"
import "@/lib/i18n"

// The link confirmation a link in the slide show asks for: ending the show closes it, and leaving full screen with
// it open (Escape, which Firefox and Safari keep for themselves in full screen) closes it and keeps the show.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/lib/trustedLinks/trustedDomainsQuery", () => ({
	useTrustedDomainsQuery: () => ({ data: new Set<string>(), refetch: () => Promise.resolve() })
}))
vi.mock("@/lib/media/fullscreen", () => ({ fullscreenSupported: () => true }))

const stage = vi.hoisted(() => ({ policy: undefined as PresentationActionPolicy | undefined, onEnd: (): void => undefined }))

vi.mock("@/features/presentation/components/slideshow/deckSlideShow", () => ({
	DeckSlideShow: (props: { policy: PresentationActionPolicy; onEnd: () => void }) => {
		stage.policy = props.policy
		stage.onEnd = props.onEnd

		return <div data-testid="stage" />
	}
}))
vi.mock("@/features/presentation/components/slideshow/setUpHost", () => ({ SetUpShowHost: () => null }))

const { useDeckPresentation } = await import("@/features/presentation/hooks/useDeckPresentation")

const deck: PresentationDocument = { ...IDLE_PRESENTATION, status: "ready", slides: [{ ref: slideRef(1), hidden: false }] }

function Page({ onShow }: { onShow: (start: () => void) => void }) {
	const focusSlide = useRef<HTMLElement | null>(null)
	const show = useDeckPresentation({ store: {} as PresentationStore, deck, index: 0, go: () => undefined, focusSlide })

	onShow(show.startShow)

	return <>{show.layer}</>
}

let fullscreen: Element | null = null

Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen })
document.documentElement.requestFullscreen = () => {
	fullscreen = document.documentElement

	return Promise.resolve()
}
document.exitFullscreen = () => {
	fullscreen = null

	return Promise.resolve()
}

afterEach(() => {
	cleanup()
	fullscreen = null
})

async function showWithConfirmation(): Promise<void> {
	let start: () => void = () => undefined

	render(
		<Page
			onShow={value => {
				start = value
			}}
		/>
	)
	await act(async () => {
		start()
		await Promise.resolve()
	})
	act(() => {
		stage.policy?.link.open("https://example.com/page")
	})
	expect(screen.getByRole("alertdialog")).toBeTruthy()
}

describe("the slide show's link confirmation", () => {
	it("closes when the show ends", async () => {
		await showWithConfirmation()
		act(() => {
			stage.onEnd()
		})
		expect(screen.queryByTestId("stage")).toBeNull()
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull()
		})
	})

	it("closes first when full screen is left with it open, and the show goes on", async () => {
		await showWithConfirmation()
		act(() => {
			fullscreen = null
			document.dispatchEvent(new Event("fullscreenchange"))
		})
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull()
		})
		expect(screen.getByTestId("stage")).toBeTruthy()
	})
})
