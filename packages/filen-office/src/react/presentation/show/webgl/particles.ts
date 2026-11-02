import type { Transition } from "../../../../core/anim/model"
import { composeSlide } from "./compose"
import { hasWebgl2, type GlDevice, type GlTexture, type ProgramName } from "./device"
import type { ShowTransitionContext, ShowTransitionRun } from "./types"

// The particle transitions of MS-PPTX §2.3.1 drawn with WebGL2: vortex (§2.3.1.30, dir l/u/r/d), ripple (§2.3.1.24,
// dir center/lu/ru/ld/rd), honeycomb (§2.3.1.15), glitter (§2.3.1.14, dir l/u/r/d, pattern diamond/hexagon), shred
// (§2.3.1.28, pattern strip/rectangle, dir in/out). Flythrough moves the content only (Figure 6) and is the 3D
// renderer's (transitions3d.ts). Both slides are
// composed into textures as they stand on the stage when the run starts, and every frame is one or two draws of
// them; each effect is exactly the outgoing slide at progress 0 and the incoming one at 1. The defaults are the
// schema's (§2.3.3).

export const PARTICLE_KINDS: ReadonlySet<string> = new Set(["vortex", "ripple", "honeycomb", "glitter", "shred"])

// GPU bytes a run holds per device px of the stage: the two slide textures and the drawing buffer twice.
const BYTES_PER_PX = 4 * 4
// Below this share of the stage's resolution a run declines rather than draw blurred.
const MIN_RESOLUTION = 0.35

interface Shape {
	readonly program: ProgramName
	readonly kind: number
	readonly mode: number
	readonly dir: readonly [number, number]
	// Tiles: columns × rows, and whether the outgoing slide's tiles are drawn last (over the incoming one's).
	readonly grid?: readonly [number, number]
	readonly outgoingOver?: boolean
}

function option(transition: Transition, name: string, fallback: string): string {
	const value = transition.options[name]

	return typeof value === "string" ? value : fallback
}

// The way a dir moves, in slide fractions (y down).
function way(dir: string): [number, number] {
	switch (dir) {
		case "r":
			return [1, 0]
		case "u":
			return [0, -1]
		case "d":
			return [0, 1]
		default:
			return [-1, 0]
	}
}

// ST_TransitionCornerAndCenterDirectionType: the corner the ripple starts from.
function origin(dir: string): [number, number] {
	switch (dir) {
		case "lu":
			return [0, 0]
		case "ru":
			return [1, 0]
		case "ld":
			return [0, 1]
		case "rd":
			return [1, 1]
		default:
			return [0.5, 0.5]
	}
}

export function particleShape(transition: Transition, aspect: number): Shape | undefined {
	switch (transition.kind) {
		case "ripple":
			return { program: "screen:ripple", kind: 1, mode: 0, dir: origin(option(transition, "dir", "center")) }
		case "honeycomb":
			return { program: "screen:honeycomb", kind: 3, mode: 0, dir: [0, 0] }
		case "glitter":
			return {
				program: "screen:glitter",
				kind: 4,
				mode: option(transition, "pattern", "diamond") === "hexagon" ? 1 : 0,
				dir: way(option(transition, "dir", "l"))
			}
		case "vortex": {
			const rows = 18

			return {
				program: "tiles",
				kind: 5,
				mode: 0,
				dir: way(option(transition, "dir", "l")),
				grid: [Math.max(1, Math.round(rows * aspect)), rows],
				outgoingOver: true
			}
		}
		case "shred": {
			const rectangles = option(transition, "pattern", "strip") === "rectangle"
			const out = option(transition, "dir", "in") === "out"

			return {
				program: "tiles",
				kind: 6,
				mode: (rectangles ? 2 : 0) + (out ? 1 : 0),
				dir: [0, 0],
				grid: rectangles ? [Math.max(1, Math.round(18 * aspect)), 18] : [24, 1],
				outgoingOver: out
			}
		}
		default:
			return undefined
	}
}

export function drawsParticle(kind: string, namespace: Transition["namespace"]): boolean {
	return namespace === "p14" && PARTICLE_KINDS.has(kind) && hasWebgl2()
}

// The device px per slide px a run draws at: the stage's, lowered to fit `budget`, undefined when that would go
// under MIN_RESOLUTION of it or the device cannot hold the size.
export function particleScale(
	slide: { readonly w: number; readonly h: number },
	pixelRatio: number,
	budget: number,
	maxSide: number
): number | undefined {
	const area = slide.w * slide.h
	let scale = Math.min(pixelRatio, maxSide / Math.max(slide.w, slide.h, 1))

	if (area * scale * scale * BYTES_PER_PX > budget) scale = Math.sqrt(budget / (area * BYTES_PER_PX))

	return scale >= pixelRatio * MIN_RESOLUTION && pixels(slide.w * scale) >= 1 && pixels(slide.h * scale) >= 1 ? scale : undefined
}

// Whole device px, never more than the size asked for (a budget holds), a size that is whole kept exactly.
export function pixels(size: number): number {
	return Math.floor(size + 1e-6)
}

export function startParticles(context: ShowTransitionContext, device: GlDevice): ShowTransitionRun | undefined {
	const outgoing = context.outgoing
	const aspect = context.slide.w / Math.max(1, context.slide.h)
	const shape = particleShape(context.transition, aspect)
	const program = shape === undefined ? undefined : device.program(shape.program)

	if (outgoing === undefined || shape === undefined || program === undefined || device.lost) return undefined

	const scale = particleScale(context.slide, context.pixelRatio, context.budgetBytes, device.maxSide)

	if (scale === undefined) return undefined

	const width = pixels(context.slide.w * scale)
	const height = pixels(context.slide.h * scale)
	const from = device.target(width, height)
	const to = device.target(width, height)
	const release = (): void => {
		device.free(from)
		device.free(to)
		device.resize(1, 1)
		device.canvas.remove()
	}

	if (from === undefined || to === undefined || !composeSlide(device, outgoing, context.slide, from)) {
		release()

		return undefined
	}

	// The incoming slide is composed with the first frame past 0 (a frame at 0 shows none of it), so starting a run
	// and its first motion are two tasks of half the work each.
	let composed = false

	const canvas = device.canvas

	device.resize(width, height)
	canvas.style.cssText = `position:absolute;left:0;top:0;width:${String(context.slide.w)}px;height:${String(context.slide.h)}px;z-index:4;pointer-events:none`
	context.host.appendChild(canvas)

	let done = false

	return {
		frame(progress) {
			if (done || device.lost) return false

			const p = Math.min(1, Math.max(0, progress))

			if (p > 0 && !composed) {
				composed = true

				if (!composeSlide(device, context.incoming, context.slide, to)) return false
			}

			drawParticles(device, shape, from, to, composed ? p : 0, aspect)

			return !device.lost
		},
		finish() {
			if (done) return

			done = true
			release()
		}
	}
}

function bind(device: GlDevice, unit: number, texture: GlTexture): void {
	const gl = device.gl

	gl.activeTexture(gl.TEXTURE0 + unit)
	gl.bindTexture(gl.TEXTURE_2D, texture.texture)
}

export function drawParticles(device: GlDevice, shape: Shape, from: GlTexture, to: GlTexture, p: number, aspect: number): void {
	const gl = device.gl
	const program = device.program(shape.program)

	if (program === undefined) return

	gl.bindFramebuffer(gl.FRAMEBUFFER, null)
	gl.viewport(0, 0, device.canvas.width, device.canvas.height)
	gl.clearColor(0, 0, 0, 1)
	gl.clear(gl.COLOR_BUFFER_BIT)
	gl.useProgram(program.program)
	gl.bindVertexArray(device.quad)
	gl.uniform1f(program.uniform("uP"), p)
	if (shape.program === "tiles") gl.uniform1i(program.uniform("uKind"), shape.kind)

	gl.uniform1i(program.uniform("uMode"), shape.mode)
	gl.uniform2f(program.uniform("uDir"), shape.dir[0], shape.dir[1])
	gl.uniform1f(program.uniform("uAspect"), aspect)

	if (shape.program !== "tiles") {
		bind(device, 0, from)
		bind(device, 1, to)
		gl.uniform1i(program.uniform("uFrom"), 0)
		gl.uniform1i(program.uniform("uTo"), 1)
		gl.disable(gl.BLEND)
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

		return
	}

	const [cols, rows] = shape.grid ?? [1, 1]

	gl.enable(gl.BLEND)
	gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
	gl.uniform2f(program.uniform("uGrid"), cols, rows)
	gl.uniform1i(program.uniform("uTex"), 0)

	for (const side of shape.outgoingOver === true ? [1, 0] : [0, 1]) {
		bind(device, 0, side === 0 ? from : to)
		gl.uniform1i(program.uniform("uSide"), side)
		gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cols * rows)
	}

	gl.disable(gl.BLEND)
}
