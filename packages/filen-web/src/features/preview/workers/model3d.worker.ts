/// <reference lib="webworker" />
// Installed below, before any model is parsed: the fetch shim, the globals loaders read (window, DOMParser) and the
// worker's ImageLoader.
import { installResourceSandbox } from "@/lib/workers/resourceSandbox"
import { THREE_ASSETS } from "virtual:three-assets"
import { MODEL_MAX_BYTES, MODEL_MAX_GPU_BYTES, gpuBytes, type ModelFormat } from "@/features/preview/lib/model3d/preflight.logic"
import { installModelGlobals } from "@/features/preview/lib/model3d/workerGlobals"
import * as Comlink from "comlink"
import {
	AnimationMixer,
	HemisphereLight,
	ImageLoader,
	PMREMGenerator,
	PerspectiveCamera,
	Scene,
	Timer,
	WebGLRenderer,
	type AnimationAction,
	type Object3D
} from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"
import { installImageLoaderShim, type ImageLoaderLike } from "@/features/preview/lib/model3d/imageLoaderShim"
import {
	ModelRefusedError,
	asGroup,
	boundingSphere,
	loadModel,
	modelInfo,
	setWireframe,
	type ModelInfo
} from "@/features/preview/lib/model3d/load"
import {
	cameraPosition,
	fitOrbit,
	homeOrbit,
	panOrbit,
	rotateOrbit,
	zoomOrbit,
	type BoundingSphere,
	type Orbit
} from "@/features/preview/lib/model3d/orbit.logic"
import type { CanvasInput, ShellToWorker, WorkerToShell } from "@/features/preview/components/canvasViewerShell.logic"

// One model, owned by its viewer: parsed into a three scene, drawn into the shell's OffscreenCanvas only when something
// changed (load, resize, camera, a toggle, a restore). An animation loops only while playing. A lost context is
// restored by three over the retained scene; a fresh canvas gets a new renderer over the same scene.

const FOV = 45

export interface ModelInit {
	readonly bytes: Uint8Array
	readonly format: ModelFormat
	// Pixels the textures may take (the worker pixel budget at 4 bytes a pixel).
	readonly texturePixels: number
}

export type ModelStatus = "ready" | "tooLarge" | "malformed" | "tooComplex" | "noWebgl" | "failed"

// One shape for every outcome: Comlink's remote type does not keep a union's arms apart.
export interface ModelLoad {
	readonly status: ModelStatus
	// Set when ready.
	readonly info: ModelInfo | null
	readonly animations: readonly string[]
	// Textures over the pixel budget, or that did not decode.
	readonly skippedTextures: number
	// External references refused.
	readonly blocked: number
}

let resolveReference: ((path: string) => Promise<Blob | null>) | null = null
const textures = { pixels: 0 }
// Textures are drawn at most this large a side, whatever the GPU allows.
const MAX_TEXTURE_SIDE = 4096
let maxSide = MAX_TEXTURE_SIDE
let skipped = 0

// The page caps what the references take with the model (MODEL_MAX_BYTES); this bounds embedded data: and blob: URLs.
// The only assets fetched are the decoders.
const sandbox = installResourceSandbox({
	assets: [THREE_ASSETS.base],
	resolve: path => (resolveReference === null ? Promise.resolve(null) : resolveReference(path)),
	budget: MODEL_MAX_BYTES * 2
})
installModelGlobals()
const images = installImageLoaderShim(ImageLoader as unknown as ImageLoaderLike, {
	fetch: url => fetch(url),
	decode: (blob, options) => createImageBitmap(blob, options),
	get maxSide() {
		return maxSide
	},
	budget: textures,
	onSkipped: () => {
		skipped++
	}
})

let shell: MessagePort | null = null
let renderer: WebGLRenderer | null = null
let canvas: OffscreenCanvas | null = null
let width = 1
let height = 1
let pixelRatio = 1
let hidden = false
const scene = new Scene()
const camera = new PerspectiveCamera(FOV, 1, 0.01, 1000)
let model: Object3D | null = null
let sphere: BoundingSphere = { center: [0, 0, 0], radius: 1 }
let orbit: Orbit | null = null
let fitted = 1
let frame: number | null = null
let mixer: AnimationMixer | null = null
let clips: AnimationAction[] = []
let playing: AnimationAction | null = null
// Advanced on each animation frame drawn; reset when playback starts or resumes.
const timer = new Timer()
const pointers = new Map<number, { x: number; y: number; buttons: number }>()
const rendererReady = Promise.withResolvers<WebGLRenderer | null>()

scene.add(new HemisphereLight(0xffffff, 0x444444, 1.2))

function send(message: WorkerToShell<"noWebgl">): void {
	shell?.postMessage(message)
}

function schedule(): void {
	frame ??= requestAnimationFrame(() => {
		frame = null
		draw()
	})
}

function draw(): void {
	if (renderer === null || orbit === null) return

	const [x, y, z] = cameraPosition(orbit)

	camera.position.set(x, y, z)
	camera.near = Math.max(orbit.radius / 1000, 1e-4)
	camera.far = orbit.radius * 100 + sphere.radius * 10
	camera.updateProjectionMatrix()
	camera.lookAt(orbit.target[0], orbit.target[1], orbit.target[2])

	if (mixer !== null && playing !== null && !hidden) {
		timer.update()
		mixer.update(timer.getDelta())
		// Playing: the next frame follows.
		schedule()
	}

	renderer.render(scene, camera)
}

function buildRenderer(next: OffscreenCanvas): WebGLRenderer | null {
	try {
		const built = new WebGLRenderer({ canvas: next, antialias: pixelRatio < 2, powerPreference: "low-power" })

		built.setPixelRatio(1)
		built.setSize(width, height, false)

		const environment = new PMREMGenerator(built)

		scene.environment = environment.fromScene(new RoomEnvironment(), 0.04).texture
		environment.dispose()
		next.addEventListener("webglcontextlost", () => {
			send({ type: "contextLost" })
		})
		next.addEventListener("webglcontextrestored", () => {
			send({ type: "contextRestored" })
			schedule()
		})
		send({ type: "limits", maxTextureSize: built.capabilities.maxTextureSize })

		return built
	} catch {
		return null
	}
}

function resize(next: { width: number; height: number; pixelRatio: number }): void {
	width = next.width
	height = next.height
	pixelRatio = next.pixelRatio
	camera.aspect = width / Math.max(height, 1)
	renderer?.setSize(width, height, false)
	schedule()
}

function input(events: readonly CanvasInput[]): void {
	if (orbit === null) return

	let next = orbit

	for (const event of events) {
		switch (event.type) {
			case "pointer": {
				const previous = pointers.get(event.id)

				if (event.phase === "down") {
					pointers.set(event.id, { x: event.x, y: event.y, buttons: event.buttons })
				} else if (event.phase === "move" && previous !== undefined) {
					const dx = event.x - previous.x
					const dy = event.y - previous.y

					if (pointers.size >= 2) {
						const other = [...pointers.entries()].find(([id]) => id !== event.id)?.[1]

						if (other !== undefined) {
							const before = Math.hypot(previous.x - other.x, previous.y - other.y)
							const after = Math.hypot(event.x - other.x, event.y - other.y)

							if (before > 0) next = zoomOrbit(next, after / before, fitted)
						}
					} else if ((previous.buttons & 2) !== 0 || (previous.buttons & 4) !== 0) {
						next = panOrbit(next, dx, dy, height, FOV)
					} else {
						next = rotateOrbit(next, dx, dy, height)
					}

					pointers.set(event.id, { ...previous, x: event.x, y: event.y })
				} else if (event.phase === "up" || event.phase === "cancel") {
					pointers.delete(event.id)
				}

				break
			}
			case "wheel":
				next = zoomOrbit(next, Math.exp(-event.deltaY * 0.0015), fitted)

				break
			case "key":
				if (event.phase !== "down") break
				if (event.key === "+" || event.key === "=") next = zoomOrbit(next, 1.25, fitted)
				if (event.key === "-") next = zoomOrbit(next, 0.8, fitted)
				if (event.key === "ArrowLeft") next = rotateOrbit(next, -32, 0, height)
				if (event.key === "ArrowRight") next = rotateOrbit(next, 32, 0, height)
				if (event.key === "ArrowUp") next = rotateOrbit(next, 0, -32, height)
				if (event.key === "ArrowDown") next = rotateOrbit(next, 0, 32, height)

				break
		}
	}

	if (next !== orbit) {
		orbit = next
		schedule()
	}
}

function onShell({ data }: MessageEvent<ShellToWorker>): void {
	switch (data.type) {
		case "canvas": {
			const first = canvas === null

			canvas = data.canvas
			hidden = data.hidden
			resize(data)
			renderer?.dispose()
			renderer = buildRenderer(canvas)

			if (first) rendererReady.resolve(renderer)
			// A fresh canvas after a context that did not come back: no renderer is a failure.
			else if (renderer === null) send({ type: "contextFailed" })

			schedule()

			break
		}
		case "resize":
			resize(data)

			break
		case "input":
			input(data.events)

			break
		case "visibility":
			hidden = data.hidden

			if (!hidden) {
				timer.update()
				schedule()
			}

			break
	}
}

async function fetchText(url: string): Promise<string | null> {
	const response = await fetch(url).catch(() => null)

	return response?.ok === true ? await response.text() : null
}

const api = {
	attach: (port: MessagePort): void => {
		shell?.close()
		shell = port
		port.onmessage = onShell
	},
	// `resolve`: a referenced file's bytes by its path below the model's directory, or null when it is not there.
	load: async (init: ModelInit, resolve: (path: string) => Promise<Blob | null>): Promise<ModelLoad> => {
		resolveReference = resolve
		textures.pixels = init.texturePixels

		const outcome = (status: ModelStatus, info: ModelInfo | null = null, animations: readonly string[] = []): ModelLoad => ({
			status,
			info,
			animations,
			skippedTextures: skipped,
			blocked: sandbox.blocked()
		})
		const built = await rendererReady.promise

		if (built === null) return outcome("noWebgl")

		maxSide = Math.min(MAX_TEXTURE_SIDE, built.capabilities.maxTextureSize)

		let loaded

		try {
			loaded = await loadModel(init.bytes, init.format, built, fetchText)
			// Counted and drawn with its textures.
			await images.settled()
		} catch (error) {
			return outcome(error instanceof ModelRefusedError ? error.reason : "failed")
		}

		const root = asGroup(loaded.root)
		const info = modelInfo(root)
		const samples = pixelRatio < 2 ? 4 : 1

		if (gpuBytes({ attributes: info.attributeBytes, textures: info.textureBytes, width, height, samples }) > MODEL_MAX_GPU_BYTES) {
			return outcome("tooComplex")
		}

		model = root
		scene.add(root)
		sphere = boundingSphere(root)
		orbit = homeOrbit(sphere, FOV, camera.aspect)
		fitted = orbit.radius

		if (loaded.animations.length > 0) {
			const animated = new AnimationMixer(root)

			mixer = animated
			clips = loaded.animations.map(clip => animated.clipAction(clip))
		}

		schedule()

		return outcome(
			"ready",
			info,
			loaded.animations.map(clip => clip.name)
		)
	},
	fit: (): void => {
		if (orbit === null) return

		orbit = fitOrbit(orbit, sphere, FOV, camera.aspect)
		fitted = orbit.radius
		schedule()
	},
	reset: (): void => {
		orbit = homeOrbit(sphere, FOV, camera.aspect)
		fitted = orbit.radius
		schedule()
	},
	wireframe: (on: boolean): void => {
		if (model !== null) setWireframe(model, on)

		schedule()
	},
	// The animation at `index` plays (looping); null stops it.
	play: (index: number | null): void => {
		playing?.stop()
		playing = index === null ? null : (clips[index] ?? null)
		playing?.play()
		timer.update()
		schedule()
	}
}

export type Model3dWorkerApi = typeof api

Comlink.expose(api)
