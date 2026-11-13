// GLSL ES 3.00 building blocks shared by the image editor's render worker and the video editor's frame pass (WebGL 2,
// Khronos WebGL 2.0 §4 / GLSL ES 3.00): the rectangle vertex program, the fragment header, and the colour grade.
//
// Every program draws one rectangle (u_rect, in clip space) as a 4-vertex strip built from gl_VertexID, so no vertex
// buffer exists. Fragment positions are mapped with affine rows (x' = dot(row, vec3(p, 1))).
//
// Colour work happens in linear light: stored values are taken through the source's transfer curve (u_transfer),
// operated on, and re-encoded with the same curve, so a source keeps its own primaries (and an image its ICC
// profile). Images use the sRGB curve (IEC 61966-2-1); SDR video uses the BT.709 OETF (ITU-R BT.709-6 §1.2) and its
// inverse. Contrast and the highlight/shadow ramp work in the source's own encoding.

// u_transfer values.
export const TRANSFER_SRGB = 0
export const TRANSFER_BT709 = 1

export type TransferFunction = typeof TRANSFER_SRGB | typeof TRANSFER_BT709

export const GL_RECT_VERTEX = `#version 300 es
uniform vec4 u_rect;

void main() {
	vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
	gl_Position = vec4(mix(u_rect.xy, u_rect.zw, corner), 0.0, 1.0);
}
`

export const GL_FRAGMENT_COMMON = `#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 outColor;

vec2 mapRows(vec3 rowX, vec3 rowY, vec2 p) {
	vec3 h = vec3(p, 1.0);
	return vec2(dot(rowX, h), dot(rowY, h));
}
`

// grade(c, outPx): c in linear light, outPx in output pixels (the vignette's frame). The including program declares
// `uniform vec2 u_outSize;` before it.
export const GL_COLOR_GRADE = `
// exposure, brightness, contrast, highlights
uniform vec4 u_adjustA;
// shadows, warmth, tint, saturation
uniform vec4 u_adjustB;
// vibrance, vignette
uniform vec2 u_adjustC;
// ${String(TRANSFER_SRGB)}: sRGB, ${String(TRANSFER_BT709)}: BT.709
uniform int u_transfer;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 decodeSrgb(vec3 v) {
	return mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), v));
}

vec3 encodeSrgb(vec3 v) {
	return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), v));
}

vec3 decodeBt709(vec3 v) {
	return mix(v / 4.5, pow((v + 0.099) / 1.099, vec3(1.0 / 0.45)), step(vec3(0.081), v));
}

vec3 encodeBt709(vec3 v) {
	return mix(v * 4.5, 1.099 * pow(v, vec3(0.45)) - 0.099, step(vec3(0.018), v));
}

vec3 decodeTransfer(vec3 v) {
	return u_transfer == ${String(TRANSFER_BT709)} ? decodeBt709(v) : decodeSrgb(v);
}

vec3 encodeTransfer(vec3 v) {
	return u_transfer == ${String(TRANSFER_BT709)} ? encodeBt709(v) : encodeSrgb(v);
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
	float lp = encodeTransfer(vec3(clamp(dot(c, LUMA), 0.0, 1.0))).x;
	c *= exp2(shadows * (1.0 - smoothstep(0.0, 0.5, lp)) + highlights * smoothstep(0.5, 1.0, lp));

	// Brightness bends the mid-tones (a gamma), keeping black and white.
	c = pow(max(c, 0.0), vec3(exp2(-brightness)));

	// Contrast pivots about mid-grey in the perceptual encoding.
	vec3 p = encodeTransfer(clamp(c, 0.0, 1.0));
	p = clamp((p - 0.5) * exp2(contrast) + 0.5, 0.0, 1.0);
	c = decodeTransfer(p);

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
`

// The adjustments the grade applies, each in the editors' units: −100..100 with 0 the identity, vignette 0..100.
export interface GradeAdjustments {
	readonly exposure: number
	readonly brightness: number
	readonly contrast: number
	readonly highlights: number
	readonly shadows: number
	readonly warmth: number
	readonly tint: number
	readonly saturation: number
	readonly vibrance: number
	readonly vignette: number
}

export interface GradeUniforms {
	adjustA: readonly [number, number, number, number]
	adjustB: readonly [number, number, number, number]
	adjustC: readonly [number, number]
}

export const IDENTITY_GRADE: GradeUniforms = { adjustA: [0, 0, 0, 0], adjustB: [0, 0, 0, 0], adjustC: [0, 0] }

// u_adjustA/B/C for `a`.
export function gradeUniforms(a: GradeAdjustments): GradeUniforms {
	return {
		adjustA: [a.exposure / 100, a.brightness / 100, a.contrast / 100, a.highlights / 100],
		adjustB: [a.shadows / 100, a.warmth / 100, a.tint / 100, a.saturation / 100],
		adjustC: [a.vibrance / 100, a.vignette / 100]
	}
}
