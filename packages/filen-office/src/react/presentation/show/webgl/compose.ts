import { mat3, multiply, type Affine, type GlDevice, type GlTexture } from "./device"

// A slide box on the stage as one texture: its layer canvases drawn in DOM order with the transforms, opacities and
// visibility the player set on their layer elements (the slide as on screen at that moment) over the box's white.
// What the composition cannot reproduce exactly declines the whole slide (the transition then plays the file's
// fallback): a clip-path on a visible layer, a layer shown as DOM for a colour or text-style effect, a medium playing.

interface Draw {
	readonly canvas: HTMLCanvasElement
	// Canvas unit square → slide px.
	readonly place: Affine
	readonly alpha: number
}

function px(value: string): number {
	const parsed = Number.parseFloat(value)

	return Number.isFinite(parsed) ? parsed : 0
}

function transformOf(element: HTMLElement): Affine | undefined {
	const text = element.style.transform

	if (text === "" || text === "none") return [1, 0, 0, 1, 0, 0]

	const view = element.ownerDocument.defaultView
	const Matrix = view === null ? undefined : (Reflect.get(view, "DOMMatrixReadOnly") as typeof DOMMatrixReadOnly | undefined)

	if (Matrix === undefined) return undefined

	try {
		const m = new Matrix(text)

		// A layer's transform is 2D (transform-origin 0 0 at the slide's origin).
		return m.is2D ? [m.a, m.b, m.c, m.d, m.e, m.f] : undefined
	} catch {
		return undefined
	}
}

function hidden(element: HTMLElement): boolean {
	return element.style.display === "none" || element.style.visibility === "hidden"
}

function collect(host: Element, place: Affine, alpha: number, out: Draw[]): boolean {
	for (const child of host.children) {
		if (!(child instanceof HTMLElement) || hidden(child)) continue

		const classes = child.classList

		if (child instanceof HTMLCanvasElement) {
			if (!classes.contains("fo-show-bitmap") && !classes.contains("fo-show-tint")) continue
			if (child.width === 0 || child.height === 0) continue

			const style = child.style

			out.push({
				canvas: child,
				place: multiply(place, [px(style.width), 0, 0, px(style.height), px(style.left), px(style.top)]),
				alpha
			})

			continue
		}

		if (classes.contains("fo-show-dom")) return false

		if (classes.contains("fo-show-media")) {
			for (const video of child.getElementsByTagName("video")) if (!video.paused) return false

			continue
		}

		// Click targets paint nothing; anything else (the SVG compositor's paint of a slide without layers) is not a
		// bitmap this can draw.
		if (classes.contains("fo-slide-hotspot") || classes.contains("fo-show-links")) continue
		if (!classes.contains("fo-show-layer")) return false

		const clip = child.style.clipPath

		if (clip !== "" && clip !== "none") return false

		const opacity = child.style.opacity === "" ? 1 : Number.parseFloat(child.style.opacity)
		const transform = transformOf(child)

		if (transform === undefined || !Number.isFinite(opacity)) return false
		if (opacity <= 0) continue
		if (!collect(child, multiply(place, transform), alpha * Math.min(1, opacity), out)) return false
	}

	return true
}

// The draws of a slide box, undefined when it cannot be composed exactly.
export function slideDraws(box: HTMLElement): readonly Draw[] | undefined {
	const out: Draw[] = []

	return collect(box, [1, 0, 0, 1, 0, 0], 1, out) ? out : undefined
}

// Composes `box` (slide px `slide`) into `target` (whose pixels cover the slide); false when it cannot.
export function composeSlide(
	device: GlDevice,
	box: HTMLElement,
	slide: { readonly w: number; readonly h: number },
	target: GlTexture
): boolean {
	const draws = slideDraws(box)
	const program = device.program("compose")

	if (draws === undefined || program === undefined || device.lost) return false

	const gl = device.gl
	const framebuffer = gl.createFramebuffer()
	let scratch: GlTexture | undefined

	try {
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0)

		if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false

		gl.viewport(0, 0, target.width, target.height)
		// The slide box's own background.
		gl.clearColor(1, 1, 1, 1)
		gl.clear(gl.COLOR_BUFFER_BIT)
		gl.enable(gl.BLEND)
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
		gl.useProgram(program.program)
		gl.bindVertexArray(device.quad)
		gl.activeTexture(gl.TEXTURE0)
		gl.uniform1i(program.uniform("uTex"), 0)

		// Slide px → clip space of the target; row 0 of a framebuffer is clip y -1, the slide's top.
		const clip: Affine = [2 / slide.w, 0, 0, 2 / slide.h, -1, -1]

		for (const draw of draws) {
			scratch = device.upload(draw.canvas, draw.canvas.width, draw.canvas.height, scratch)

			if (scratch === undefined) return false

			gl.uniformMatrix3fv(program.uniform("uPlace"), false, mat3(multiply(clip, draw.place)))
			gl.uniform1f(program.uniform("uAlpha"), draw.alpha)
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
		}

		return !device.lost
	} finally {
		device.free(scratch)
		gl.bindFramebuffer(gl.FRAMEBUFFER, null)
		gl.deleteFramebuffer(framebuffer)
		gl.disable(gl.BLEND)
	}
}
