import { describe, it, expect } from "vitest"
import { shouldRedact } from "@/components/privacyScreenLogic"

describe("shouldRedact (privacy cover decision)", () => {
	it("never redacts while the biometric lock is up — lock wins, it redacts itself", () => {
		expect(shouldRedact("background", false, true, false)).toBe(false)
		expect(shouldRedact("inactive", false, true, false)).toBe(false)
		expect(shouldRedact("active", false, true, false)).toBe(false)
		// even with a presentation flag set, the lock still wins
		expect(shouldRedact("inactive", true, true, false)).toBe(false)
	})

	it("never redacts while the app is active (foreground)", () => {
		expect(shouldRedact("active", false, false, false)).toBe(false)
		expect(shouldRedact("active", true, false, false)).toBe(false)
	})

	it("always redacts on a real background — snapshot-safe, ignores the presentation grace", () => {
		expect(shouldRedact("background", false, false, false)).toBe(true)
		expect(shouldRedact("background", true, false, false)).toBe(true)
	})

	it("redacts on inactive when no presentation is active/recent (e.g. a plain home-press)", () => {
		expect(shouldRedact("inactive", false, false, false)).toBe(true)
	})

	it("suppresses on inactive during / just-after an in-app presentation (no flicker around Face ID / PIN / pickers)", () => {
		expect(shouldRedact("inactive", true, false, false)).toBe(false)
	})

	// PiP (spec: docs/pip-video-player.md §5.6.2): pipPreviewVisible is computed by the caller as
	// "PiP session active AND pathname is the drivePreview route" — the pathname gate is what keeps
	// menu-pushed screens (Move → drive browser) redacted while a PiP session is alive.
	it("suppresses on background while the PiP session's preview is the last-visible screen", () => {
		expect(shouldRedact("background", false, false, true)).toBe(false)
		expect(shouldRedact("inactive", false, false, true)).toBe(false)
	})

	it("PiP suppression does not leak past the caller's pathname gate — non-preview screens redact as usual", () => {
		// The caller passes pipPreviewVisible=false when a pushed screen covers the preview,
		// even though a PiP session is alive — background must redact.
		expect(shouldRedact("background", false, false, false)).toBe(true)
	})
})
