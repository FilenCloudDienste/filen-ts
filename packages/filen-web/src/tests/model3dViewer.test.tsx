// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import type { ModelLoad } from "@/features/preview/workers/model3d.worker"
import type { ReferenceResolver } from "@/features/preview/lib/referenceResolver"
import { linkedFileItem } from "@/tests/fixtures/sdk"

// The 3D viewer's states: the model with its toolbar, the notice and information for references not loaded, the
// fallback cards (no worker WebGL, unreadable, too large, too complex) with View source for text formats only.

type Resolve = (path: string) => Promise<Blob | null>

const { scene } = vi.hoisted(() => ({
	scene: { next: (_resolve: (path: string) => Promise<Blob | null>): Promise<ModelLoad> => new Promise(() => undefined) }
}))
const worker = vi.hoisted(() => ({ status: "ready", generation: 1, owned: {} }))

function freshWorker(): void {
	Object.assign(worker, {
		owned: {
			run: (call: (remote: unknown) => unknown) =>
				call({ load: (_init: unknown, resolve: Resolve) => scene.next(resolve), wireframe: () => Promise.resolve() })
		}
	})
}

vi.mock("@/lib/workers/ownedWorker", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/workers/ownedWorker")>()),
	useOwnedWorker: () => worker
}))
vi.mock("@/features/preview/workers/model3d.worker.ts?worker", () => ({ default: vi.fn() }))
vi.mock("@/features/preview/hooks/usePreviewFetch", () => ({
	usePreviewFetch: () => ({ status: "success", value: new TextEncoder().encode("mtllib mesh.mtl\nv 0 0 0\n"), refetch: () => undefined })
}))
vi.mock("@/features/preview/components/canvasViewerShell", () => ({
	CanvasViewerShell: ({ notice, toolbar, sidePanel }: { notice?: unknown; toolbar?: unknown; sidePanel?: unknown }) => (
		<div>
			model
			{notice as never}
			{toolbar as never}
			{sidePanel as never}
		</div>
	)
}))

const INFO = {
	triangles: 12,
	vertices: 8,
	meshes: 1,
	materials: 1,
	textures: 0,
	size: [1, 2, 3] as const,
	attributeBytes: 100,
	textureBytes: 0
}

function outcome(status: ModelLoad["status"], overrides: Partial<ModelLoad> = {}): ModelLoad {
	return { status, info: status === "ready" ? INFO : null, animations: [], skippedTextures: 0, blocked: 0, ...overrides }
}

afterEach(() => {
	cleanup()
})

async function renderViewer(name: string, resolver: ReferenceResolver | null = null): Promise<void> {
	const { Model3dViewer } = await import("@/features/preview/components/model3dViewer")
	const { PreviewReferenceSourceContext } = await import("@/features/preview/lib/referenceResolver")

	freshWorker()
	render(
		<PreviewReferenceSourceContext value={() => resolver}>
			<Model3dViewer item={linkedFileItem(name)} />
		</PreviewReferenceSourceContext>
	)
}

describe("Model3dViewer", () => {
	it("draws the model with its toolbar, and counts the referenced files not found", async () => {
		scene.next = async resolve => {
			expect(await resolve("mesh.mtl")).toBeInstanceOf(Blob)
			expect(await resolve("wood.png")).toBeNull()

			return outcome("ready", { animations: ["Walk"] })
		}
		await renderViewer("mesh.obj", path =>
			Promise.resolve(
				path === "mesh.mtl" ? { status: "found", size: 3, read: () => Promise.resolve(new Uint8Array(3)) } : { status: "missing" }
			)
		)

		expect(await screen.findByText("1 referenced file not loaded")).toBeTruthy()

		for (const name of ["Fit", "Reset", "Wireframe", "Play", "View source", "Info"]) {
			expect(screen.getByRole("button", { name }), name).toBeTruthy()
		}

		screen.getByRole("button", { name: "Info" }).click()

		expect(await screen.findByText("Triangles")).toBeTruthy()
		expect(screen.getByText("wood.png")).toBeTruthy()
	})

	it("serves no reference past the cap left by the model", async () => {
		const read = vi.fn(() => Promise.resolve(new Uint8Array(1)))

		scene.next = async resolve => {
			expect(await resolve("huge.png")).toBeNull()

			return outcome("ready")
		}
		await renderViewer("mesh.obj", () => Promise.resolve({ status: "found", size: 200 * 1024 * 1024, read }))

		expect(await screen.findByText("1 referenced file not loaded")).toBeTruthy()
		expect(read).not.toHaveBeenCalled()
	})

	it.each([
		["noWebgl", "This browser can't display 3D models here."],
		["malformed", "This model can't be read."],
		["failed", "This model can't be read."],
		["tooLarge", "This model is too large to preview."],
		["tooComplex", "This model is too complex to display."]
	] as const)("shows the %s card, with View source for a text format", async (status, message) => {
		scene.next = () => Promise.resolve(outcome(status))
		await renderViewer("mesh.obj")

		expect(await screen.findByText(message)).toBeTruthy()
		expect(screen.getByRole("button", { name: "View source" })).toBeTruthy()
	})

	it("offers no source for a binary format", async () => {
		scene.next = () => Promise.resolve(outcome("noWebgl"))
		await renderViewer("scene.glb")

		expect(await screen.findByText("This browser can't display 3D models here.")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "View source" })).toBeNull()
	})
})
