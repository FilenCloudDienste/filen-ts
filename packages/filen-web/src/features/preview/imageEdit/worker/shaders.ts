// GLSL ES 3.00 programs of the render worker (WebGL 2, Khronos WebGL 2.0 §4 / GLSL ES 3.00).
//
// Every program draws one rectangle (u_rect, in clip space) as a 4-vertex strip built from gl_VertexID, so no
// vertex buffer exists. Fragment positions are mapped with affine rows (x' = dot(row, vec3(p, 1))) from
// gl_FragCoord: to output pixels (top-down), then to the source or an intermediate texture. Textures are stored
// top row first (no UNPACK_FLIP_Y), and render targets read back with readPixels are drawn so that framebuffer
// row 0 is the top output row; only the canvas itself is flipped, through its own row map.
//
// Colour work happens in linear light: the stored values are taken through the sRGB transfer curve (IEC
// 61966-2-1) whatever the source's primaries, operated on, and re-encoded, so a wide-gamut source keeps its
// own primaries and its ICC profile stays valid.

const VERTEX = `#version 300 es
uniform vec4 u_rect;

void main() {
	vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
	gl_Position = vec4(mix(u_rect.xy, u_rect.zw, corner), 0.0, 1.0);
}
`

const COMMON = `#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 outColor;

vec2 mapRows(vec3 rowX, vec3 rowY, vec2 p) {
	vec3 h = vec3(p, 1.0);
	return vec2(dot(rowX, h), dot(rowY, h));
}
`

// Markup layers, rasterised by a 2D canvas and uploaded premultiplied (UNPACK_PREMULTIPLY_ALPHA_WEBGL): the
// highlighter layer multiplies what is under it, then the ink layer goes over everything with source-over.
// Both follow the W3C Compositing and Blending Level 1 formulas against a straight-alpha backdrop.
const MARKUP = `
uniform sampler2D u_ink;
uniform sampler2D u_highlight;
uniform bool u_hasInk;
uniform bool u_hasHighlight;
uniform vec3 u_outToMarkupX;
uniform vec3 u_outToMarkupY;

vec4 compositeMarkup(vec4 base, vec2 outPx) {
	if (!u_hasInk && !u_hasHighlight) {
		return base;
	}

	vec2 uv = mapRows(u_outToMarkupX, u_outToMarkupY, outPx);
	vec3 cb = base.rgb;
	float ab = base.a;

	if (u_hasHighlight) {
		vec4 s = texture(u_highlight, uv);

		if (s.a > 0.0) {
			vec3 cs = s.rgb / s.a;
			vec3 mixed = (1.0 - ab) * cs + ab * cb * cs;
			float ao = s.a + ab * (1.0 - s.a);
			cb = (s.a * mixed + (1.0 - s.a) * ab * cb) / ao;
			ab = ao;
		}
	}

	if (u_hasInk) {
		vec4 s = texture(u_ink, uv);

		if (s.a > 0.0) {
			float ao = s.a + ab * (1.0 - s.a);
			cb = (s.rgb + cb * ab * (1.0 - s.a)) / ao;
			ab = ao;
		}
	}

	return vec4(cb, ab);
}
`

const COPY_FRAGMENT = `${COMMON}
uniform sampler2D u_texture;
uniform vec3 u_fragToUvX;
uniform vec3 u_fragToUvY;

void main() {
	outColor = texture(u_texture, mapRows(u_fragToUvX, u_fragToUvY, gl_FragCoord.xy));
}
`

const COLOR_FRAGMENT = `${COMMON}
${MARKUP}
uniform sampler2D u_source;
uniform vec3 u_fragToOutX;
uniform vec3 u_fragToOutY;
uniform vec3 u_outToSrcX;
uniform vec3 u_outToSrcY;
uniform vec2 u_outSize;
uniform vec2 u_srcSize;
uniform vec2 u_texOrigin;
uniform vec2 u_texSize;
// exposure, brightness, contrast, highlights
uniform vec4 u_adjustA;
// shadows, warmth, tint, saturation
uniform vec4 u_adjustB;
// vibrance, vignette
uniform vec2 u_adjustC;
uniform bool u_opaque;
uniform bool u_markup;
uniform bool u_premultiply;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 decodeSrgb(vec3 v) {
	return mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), v));
}

vec3 encodeSrgb(vec3 v) {
	return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), v));
}

vec3 grade(vec3 c, vec2 outPx) {
	float exposure = u_adjustA.x;
	float brightness = u_adjustA.y;
	float contrast = u_adjustA.z;
	float highlights = u_adjustA.w;
	float shadows = u_adjustB.x;
	float warmth = u_adjustB.y;
	float tint = u_adjustB.z;
	float saturation = u_adjustB.w;
	float vibrance = u_adjustC.x;
	float vignette = u_adjustC.y;

	// White balance as channel gains, renormalised so the luminance stays put.
	vec3 gains = vec3(1.0 + 0.3 * warmth, 1.0 - 0.3 * tint, 1.0 - 0.3 * warmth);
	c *= gains / dot(gains, LUMA);

	// ±2 stops.
	c *= exp2(2.0 * exposure);

	// Highlights and shadows: a gain in stops weighted by a smooth ramp over the perceptual luminance.
	float lp = encodeSrgb(vec3(clamp(dot(c, LUMA), 0.0, 1.0))).x;
	c *= exp2(shadows * (1.0 - smoothstep(0.0, 0.5, lp)) + highlights * smoothstep(0.5, 1.0, lp));

	// Brightness bends the mid-tones (a gamma), keeping black and white.
	c = pow(max(c, 0.0), vec3(exp2(-brightness)));

	// Contrast pivots about mid-grey in the perceptual encoding.
	vec3 p = encodeSrgb(clamp(c, 0.0, 1.0));
	p = clamp((p - 0.5) * exp2(contrast) + 0.5, 0.0, 1.0);
	c = decodeSrgb(p);

	// Saturation scales chroma about the luminance; vibrance does so most where chroma is low.
	float luma = dot(c, LUMA);
	float top = max(c.r, max(c.g, c.b));
	float chroma = top > 0.0 ? (top - min(c.r, min(c.g, c.b))) / top : 0.0;
	c = mix(vec3(luma), c, (1.0 + saturation) * (1.0 + vibrance * (1.0 - chroma)));

	// Vignette in output coordinates, so every export tile darkens the same frame.
	vec2 fromCentre = (outPx - 0.5 * u_outSize) / (0.5 * u_outSize);
	float reach = length(fromCentre) * 0.70710678;
	c *= 1.0 - 0.85 * vignette * smoothstep(0.3, 1.0, reach);

	return clamp(c, 0.0, 1.0);
}

void main() {
	vec2 outPx = mapRows(u_fragToOutX, u_fragToOutY, gl_FragCoord.xy);

	if (outPx.x < 0.0 || outPx.y < 0.0 || outPx.x > u_outSize.x || outPx.y > u_outSize.y) {
		outColor = vec4(0.0);
		return;
	}

	vec2 srcPx = mapRows(u_outToSrcX, u_outToSrcY, outPx);

	if (srcPx.x < 0.0 || srcPx.y < 0.0 || srcPx.x > u_srcSize.x || srcPx.y > u_srcSize.y) {
		outColor = vec4(0.0);
		return;
	}

	vec4 texel = texture(u_source, (srcPx - u_texOrigin) / u_texSize);
	vec4 color = vec4(encodeSrgb(grade(decodeSrgb(texel.rgb), outPx)), u_opaque ? 1.0 : texel.a);

	if (u_markup) {
		color = compositeMarkup(color, outPx);
	}

	outColor = u_premultiply ? vec4(color.rgb * color.a, color.a) : color;
}
`

// Unsharp mask over the colour pass's result: the centre plus `amount` times its difference from a 3×3
// Gaussian at `radius` output pixels. Neighbours past the output's edge clamp to it, so every tile sees the same
// border the whole picture has.
const SHARPEN_FRAGMENT = `${COMMON}
${MARKUP}
uniform sampler2D u_inter;
uniform vec3 u_fragToOutX;
uniform vec3 u_fragToOutY;
uniform vec3 u_outToInterX;
uniform vec3 u_outToInterY;
uniform vec2 u_outSize;
uniform float u_amount;
uniform float u_radius;
uniform bool u_premultiply;

vec4 at(vec2 outPx) {
	return texture(u_inter, mapRows(u_outToInterX, u_outToInterY, clamp(outPx, vec2(0.5), u_outSize - 0.5)));
}

void main() {
	vec2 outPx = mapRows(u_fragToOutX, u_fragToOutY, gl_FragCoord.xy);

	if (outPx.x < 0.0 || outPx.y < 0.0 || outPx.x > u_outSize.x || outPx.y > u_outSize.y) {
		outColor = vec4(0.0);
		return;
	}

	vec2 r = vec2(u_radius);
	vec4 centre = at(outPx);
	vec4 edges = at(outPx + vec2(r.x, 0.0)) + at(outPx - vec2(r.x, 0.0)) + at(outPx + vec2(0.0, r.y)) + at(outPx - vec2(0.0, r.y));
	vec4 corners = at(outPx + r) + at(outPx - r) + at(outPx + vec2(r.x, -r.y)) + at(outPx + vec2(-r.x, r.y));
	vec3 blur = (4.0 * centre.rgb + 2.0 * edges.rgb + corners.rgb) / 16.0;
	vec4 color = vec4(clamp(centre.rgb + u_amount * (centre.rgb - blur), 0.0, 1.0), centre.a);

	color = compositeMarkup(color, outPx);
	outColor = u_premultiply ? vec4(color.rgb * color.a, color.a) : color;
}
`

export type ProgramName = "copy" | "color" | "sharpen"

export interface Program {
	program: WebGLProgram
	uniforms: ReadonlyMap<string, WebGLUniformLocation>
}

const SOURCES: Readonly<Record<ProgramName, string>> = {
	copy: COPY_FRAGMENT,
	color: COLOR_FRAGMENT,
	sharpen: SHARPEN_FRAGMENT
}

// Texture units, fixed per sampler name for every program.
export const UNIT_MAIN = 0
export const UNIT_INK = 1
export const UNIT_HIGHLIGHT = 2

const SAMPLER_UNITS: Readonly<Record<string, number>> = {
	u_texture: UNIT_MAIN,
	u_source: UNIT_MAIN,
	u_inter: UNIT_MAIN,
	u_ink: UNIT_INK,
	u_highlight: UNIT_HIGHLIGHT
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
	const shader = gl.createShader(type)

	if (shader === null) {
		throw new Error("WebGL: createShader failed")
	}

	gl.shaderSource(shader, source)
	gl.compileShader(shader)

	return shader
}

function link(gl: WebGL2RenderingContext, fragment: string): Program {
	const program = gl.createProgram()
	const vs = compile(gl, gl.VERTEX_SHADER, VERTEX)
	const fs = compile(gl, gl.FRAGMENT_SHADER, fragment)

	gl.attachShader(program, vs)
	gl.attachShader(program, fs)
	gl.linkProgram(program)
	// Status is read only after linking, so a driver compiling in parallel is not stalled per shader.
	const linked = gl.getProgramParameter(program, gl.LINK_STATUS) === true
	const failure = linked ? null : (gl.getShaderInfoLog(fs) ?? "") + (gl.getProgramInfoLog(program) ?? "")

	gl.detachShader(program, vs)
	gl.detachShader(program, fs)
	gl.deleteShader(vs)
	gl.deleteShader(fs)

	if (failure !== null) {
		gl.deleteProgram(program)

		throw new Error(`WebGL: link failed: ${failure}`)
	}

	const uniforms = new Map<string, WebGLUniformLocation>()
	const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number

	gl.useProgram(program)

	for (let i = 0; i < count; i++) {
		const info = gl.getActiveUniform(program, i)
		const location = info === null ? null : gl.getUniformLocation(program, info.name)

		if (info === null || location === null) {
			continue
		}

		uniforms.set(info.name, location)

		const unit = SAMPLER_UNITS[info.name]

		if (unit !== undefined) {
			gl.uniform1i(location, unit)
		}
	}

	return { program, uniforms }
}

export function createPrograms(gl: WebGL2RenderingContext): Record<ProgramName, Program> {
	return { copy: link(gl, SOURCES.copy), color: link(gl, SOURCES.color), sharpen: link(gl, SOURCES.sharpen) }
}

export function deletePrograms(gl: WebGL2RenderingContext, programs: Record<ProgramName, Program>): void {
	gl.deleteProgram(programs.copy.program)
	gl.deleteProgram(programs.color.program)
	gl.deleteProgram(programs.sharpen.program)
}
