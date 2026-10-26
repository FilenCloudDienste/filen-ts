import { describe, expect, it, vi } from "vitest"
import { slideRef, type Action } from "../core/presentation/model"
import { isPresentationUrl, presentationActions, type ActionTrigger, type PresentationActionPolicy } from "../react/presentation/links"

const SHAPE = { slide: slideRef(10), id: 4 }
const CLICK: ActionTrigger = { via: "click", mode: "view", modifier: false, shape: SHAPE }

function policy(overrides: Partial<PresentationActionPolicy> = {}, withoutConfirm = false) {
	const open = vi.fn<(href: string) => void>()
	const linkRefused = vi.fn<(href: string) => void>()
	const confirm = vi.fn<(host: string, href: string, run: () => void) => void>()
	const navigate = vi.fn()
	const refused = vi.fn()
	const anchor = vi.fn()
	const options: PresentationActionPolicy = {
		link: { allow: () => true, open, refused: linkRefused },
		isDrive: href => href.startsWith("https://app.filen.io/"),
		confirm,
		navigate,
		refused,
		anchor,
		...overrides
	}
	const { confirm: _confirm, ...direct } = options
	const activator = presentationActions(withoutConfirm ? direct : options)

	return { activator, open, linkRefused, confirm, navigate, refused, anchor }
}

describe("presentation link policy", () => {
	it("shows the host of a foreign URL first and opens only when confirmed", () => {
		const p = policy()

		expect(p.activator.action({ kind: "url", href: "https://example.com/a?b" }, CLICK)).toBe("confirming")
		expect(p.open).not.toHaveBeenCalled()
		expect(p.confirm.mock.calls[0]?.[0]).toBe("example.com")

		p.confirm.mock.calls[0]?.[2]()

		expect(p.open).toHaveBeenCalledWith("https://example.com/a?b")
	})

	it("opens a drive URL at once and a mailto after showing its address", () => {
		const p = policy()

		expect(p.activator.action({ kind: "url", href: "https://app.filen.io/#/d/x" }, CLICK)).toBe("opened")
		expect(p.open).toHaveBeenCalledWith("https://app.filen.io/#/d/x")
		expect(p.activator.action({ kind: "url", href: "mailto:someone@example.com" }, CLICK)).toBe("confirming")
		expect(p.confirm.mock.calls[0]?.[0]).toBe("someone@example.com")
	})

	it("opens directly when the caller shows no host step", () => {
		const p = policy({}, true)

		expect(p.activator.action({ kind: "url", href: "http://example.org" }, { ...CLICK, mode: "show" })).toBe("opened")
		expect(p.open).toHaveBeenCalledWith("http://example.org")
	})

	it("refuses a url action whose scheme is not http, https or mailto, judged again on click", () => {
		for (const href of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "\\\\server\\share", "ftp://x", "https://"]) {
			const p = policy()

			expect(p.activator.action({ kind: "url", href }, CLICK)).toBe("refused")
			expect(p.open).not.toHaveBeenCalled()
			expect(p.confirm).not.toHaveBeenCalled()
			expect(p.refused).toHaveBeenCalledWith({ kind: "refusedAction", shape: SHAPE, what: "scheme" })
		}
	})

	it("refuses a URL the caller's policy disallows", () => {
		const p = policy({ link: { allow: () => false, open: vi.fn() } })

		expect(p.activator.action({ kind: "url", href: "https://example.com" }, CLICK)).toBe("refused")
	})

	it("follows nothing on a plain click in the editor and everything on Mod+click", () => {
		const p = policy()
		const edit: ActionTrigger = { ...CLICK, mode: "edit" }

		expect(p.activator.action({ kind: "slide", slide: slideRef(12) }, edit)).toBe("ignored")
		expect(p.activator.action({ kind: "url", href: "https://example.com" }, edit)).toBe("ignored")
		expect(p.navigate).not.toHaveBeenCalled()
		expect(p.activator.action({ kind: "slide", slide: slideRef(12) }, { ...edit, modifier: true })).toBe("navigated")
		expect(p.navigate).toHaveBeenCalledWith({ kind: "slide", slide: slideRef(12) })
	})

	it("navigates internal jumps, slide jumps and custom shows", () => {
		const p = policy()

		for (const jump of ["next", "previous", "first", "last", "end", "lastViewed"] as const) {
			expect(p.activator.action({ kind: "internal", jump }, CLICK)).toBe("navigated")
			expect(p.navigate).toHaveBeenLastCalledWith({ kind: "internal", jump })
		}

		expect(p.activator.action({ kind: "customShow", id: 3, returnAfter: true }, CLICK)).toBe("navigated")
		expect(p.navigate).toHaveBeenLastCalledWith({ kind: "customShow", id: 3, returnAfter: true })
	})

	it("keeps every refused action kind inert with a typed notice", () => {
		for (const what of ["program", "macro", "ole", "file", "script", "execute", "scheme"] as const) {
			const p = policy()
			const action: Action = { kind: "refused", what, raw: "ppaction://program" }

			expect(p.activator.action(action, CLICK)).toBe("refused")
			expect(p.refused).toHaveBeenCalledWith({ kind: "refusedAction", shape: SHAPE, what })
			expect(p.open).not.toHaveBeenCalled()
			expect(p.navigate).not.toHaveBeenCalled()
		}
	})

	it("hands a media action to the media handler, and keeps it inert without one", () => {
		const media = vi.fn()
		const p = policy({ media })

		expect(p.activator.action({ kind: "media" }, CLICK)).toBe("media")
		expect(media).toHaveBeenCalledWith({ kind: "media", shape: SHAPE })
		expect(p.activator.action({ kind: "media" }, { ...CLICK, via: "hover" })).toBe("inert")
		expect(media).toHaveBeenCalledTimes(1)

		const bare = policy()

		expect(bare.activator.action({ kind: "media" }, CLICK)).toBe("inert")
		expect(bare.navigate).not.toHaveBeenCalled()
		expect(bare.refused).not.toHaveBeenCalled()
		expect(bare.open).not.toHaveBeenCalled()
	})

	it("never acts on hover", () => {
		const p = policy()
		const hover: ActionTrigger = { ...CLICK, via: "hover", mode: "show" }
		const actions: Action[] = [
			{ kind: "url", href: "https://example.com" },
			{ kind: "slide", slide: slideRef(11) },
			{ kind: "internal", jump: "next" },
			{ kind: "customShow", id: 1, returnAfter: false },
			{ kind: "refused", what: "program", raw: "ppaction://program" }
		]

		for (const action of actions) expect(p.activator.action(action, hover)).toBe("inert")

		expect(p.open).not.toHaveBeenCalled()
		expect(p.navigate).not.toHaveBeenCalled()
		expect(p.refused).not.toHaveBeenCalled()
		expect(p.confirm).not.toHaveBeenCalled()
	})

	it("judges text-run links like url actions and hands internal anchors back", () => {
		const p = policy()

		expect(p.activator.link({ kind: "external", href: " https://example.com ", tooltip: "t" }, CLICK)).toBe("confirming")
		expect(p.activator.link({ kind: "external", href: "javascript:void 0", tooltip: undefined }, CLICK)).toBe("refused")
		expect(p.activator.link({ kind: "internal", anchor: "slide12", tooltip: undefined }, CLICK)).toBe("navigated")
		expect(p.anchor).toHaveBeenCalledWith("slide12")
	})

	it("accepts absolute http, https and mailto URLs only", () => {
		expect(isPresentationUrl("https://a.example")).toBe(true)
		expect(isPresentationUrl("mailto:x@y.z")).toBe(true)
		expect(isPresentationUrl("/relative")).toBe(false)
		expect(isPresentationUrl("HTTPS://A.EXAMPLE")).toBe(true)
		expect(isPresentationUrl("vbscript:x")).toBe(false)
	})
})
