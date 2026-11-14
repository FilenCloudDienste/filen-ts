import { vi } from "vitest"
import type { PdfToolContext, PdfToolHost } from "@/features/pdf/tools/registry"

// A tool context for tests that never reach the swap or a save: every member a stub, `overrides` replacing any.

export function fakeToolHost(overrides: Partial<PdfToolHost> = {}): PdfToolHost {
	return {
		fileName: "file.pdf",
		takenNames: () => Promise.resolve(new Set()),
		canSaveInPlace: true,
		save: () => Promise.resolve({ status: "cancelled" }),
		unlocked: vi.fn(),
		close: vi.fn(),
		...overrides
	}
}

export function fakeToolContext(overrides: Partial<PdfToolContext> = {}): PdfToolContext {
	return {
		edit: vi.fn(),
		finish: vi.fn(),
		activate: vi.fn(),
		activeTool: null,
		swap: {} as PdfToolContext["swap"],
		snapshot: null,
		editable: true,
		host: fakeToolHost(),
		notify: vi.fn(),
		sign: () => Promise.resolve(false),
		...overrides
	}
}
