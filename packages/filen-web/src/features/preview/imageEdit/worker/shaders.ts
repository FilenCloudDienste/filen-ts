import { GL_COLOR_GRADE, GL_FRAGMENT_COMMON, GL_RECT_VERTEX } from "@/lib/gl/colorGrade"

// GLSL ES 3.00 programs of the render worker (WebGL 2, Khronos WebGL 2.0 §4 / GLSL ES 3.00).
//
// Every program draws one rectangle (u_rect, in clip space) as a 4-vertex strip built from gl_VertexID, so no
// vertex buffer exists. Fragment positions are mapped with affine rows (x' = dot(row, vec3(p, 1))) from
// gl_FragCoord: to output pixels (top-down), then to the source or an intermediate texture. Textures are stored
// top row first (no UNPACK_FLIP_Y), and render targets read back with readPixels are drawn so that framebuffer
// row 0 is the top output row; only the canvas itself is flipped, through its own row map.
//
// Colour work happens in linear light (GL_COLOR_GRADE, shared with the video editor): the stored values are taken
// through the sRGB transfer curve (IEC 61966-2-1) whatever the source's primaries, operated on, and re-encoded, so a
// wide-gamut source keeps its own primaries and its ICC profile stays valid.

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

const COPY_FRAGMENT = `${GL_FRAGMENT_COMMON}
uniform sampler2D u_texture;
uniform vec3 u_fragToUvX;
uniform vec3 u_fragToUvY;

void main() {
	outColor = texture(u_texture, mapRows(u_fragToUvX, u_fragToUvY, gl_FragCoord.xy));
}
`

const COLOR_FRAGMENT = `${GL_FRAGMENT_COMMON}
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
uniform bool u_opaque;
uniform bool u_markup;
uniform bool u_premultiply;

${GL_COLOR_GRADE}
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
	vec4 color = vec4(encodeTransfer(grade(decodeTransfer(texel.rgb), outPx)), u_opaque ? 1.0 : texel.a);

	if (u_markup) {
		color = compositeMarkup(color, outPx);
	}

	outColor = u_premultiply ? vec4(color.rgb * color.a, color.a) : color;
}
`

// Unsharp mask over the colour pass's result: the centre plus `amount` times its difference from a 3×3
// Gaussian at `radius` output pixels. Neighbours past the output's edge clamp to it, so every tile sees the same
// border the whole picture has.
const SHARPEN_FRAGMENT = `${GL_FRAGMENT_COMMON}
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

// Each program's fragment source.
export const FRAGMENT_SOURCES: Readonly<Record<ProgramName, string>> = {
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
	const vs = compile(gl, gl.VERTEX_SHADER, GL_RECT_VERTEX)
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
	return { copy: link(gl, FRAGMENT_SOURCES.copy), color: link(gl, FRAGMENT_SOURCES.color), sharpen: link(gl, FRAGMENT_SOURCES.sharpen) }
}

export function deletePrograms(gl: WebGL2RenderingContext, programs: Record<ProgramName, Program>): void {
	gl.deleteProgram(programs.copy.program)
	gl.deleteProgram(programs.color.program)
	gl.deleteProgram(programs.sharpen.program)
}
