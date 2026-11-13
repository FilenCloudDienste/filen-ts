import { GL_COLOR_GRADE, GL_FRAGMENT_COMMON, GL_RECT_VERTEX } from "@/lib/gl/colorGrade"

// GLSL ES 3.00 programs of the video frame pass (WebGL 2). Geometry, colour and text in one render pass over the
// output: the frame program draws every output pixel once (crop, rotation, flip and resize are one affine map from the
// output pixel to the decoded picture's texture coordinate), then each visible text box is blended over it as a quad.
//
// Output pixels are addressed top-down (x right, y down), as a VideoFrame made from the canvas reads them; the
// canvas's row 0 is its bottom row, hence `u_outSize.y - gl_FragCoord.y`. Textures are uploaded top row first.

export const VIDEO_VERTEX = GL_RECT_VERTEX

// HDR to SDR, shared by the RGB and the planar inputs. Documented tone map:
// 1. Decode to display light in cd/m²: PQ by the SMPTE ST 2084 EOTF; HLG by the ITU-R BT.2100 inverse OETF and its
//    OOTF for a 1000 cd/m² display (system gamma 1.2, BT.2100 Table 5).
// 2. Normalise so the HDR reference white of ITU-R BT.2408 (203 cd/m²) is SDR white (1.0).
// 3. Compress the BT.2020 luminance: unchanged up to a knee at 0.75, then an exponential shoulder towards 1.0 that
//    meets the line with the same slope (C¹); the RGB is scaled by the luminance ratio, so hues stay put.
// 4. BT.2020 to BT.709 primaries in linear light (ITU-R BT.2087 matrix), clipped to the SDR gamut.
// The grade then runs on that linear BT.709 light and the BT.709 OETF encodes it.
const HDR_TO_SDR = `
const vec3 LUMA_2020 = vec3(0.2627, 0.6780, 0.0593);
const float REFERENCE_WHITE = 203.0;
const float KNEE = 0.75;

vec3 pqToNits(vec3 e) {
	const float m1 = 0.1593017578125;
	const float m2 = 78.84375;
	const float c1 = 0.8359375;
	const float c2 = 18.8515625;
	const float c3 = 18.6875;
	vec3 p = pow(clamp(e, 0.0, 1.0), vec3(1.0 / m2));
	return 10000.0 * pow(max(p - c1, 0.0) / (c2 - c3 * p), vec3(1.0 / m1));
}

vec3 hlgToNits(vec3 e) {
	const float a = 0.17883277;
	const float b = 0.28466892;
	const float c = 0.55991073;
	e = clamp(e, 0.0, 1.0);
	vec3 scene = mix(e * e / 3.0, (exp((e - c) / a) + b) / 12.0, step(vec3(0.5), e));
	float ys = dot(scene, LUMA_2020);
	return 1000.0 * pow(max(ys, 1e-6), 0.2) * scene;
}

// 1 = PQ, 2 = HLG.
vec3 hdrToSdrLinear(vec3 encoded, int transfer) {
	vec3 rgb = (transfer == 1 ? pqToNits(encoded) : hlgToNits(encoded)) / REFERENCE_WHITE;
	float y = dot(rgb, LUMA_2020);
	float mapped = y <= KNEE ? y : KNEE + (1.0 - KNEE) * (1.0 - exp(-(y - KNEE) / (1.0 - KNEE)));
	rgb *= y > 0.0 ? mapped / y : 0.0;
	const mat3 BT2020_TO_BT709 = mat3(
		1.6605, -0.1246, -0.0182,
		-0.5876, 1.1329, -0.1006,
		-0.0728, -0.0083, 1.1187
	);
	return clamp(BT2020_TO_BT709 * rgb, 0.0, 1.0);
}
`

// The decoded picture as uploaded RGB (the browser's YUV → RGB, no colour-space conversion: UNPACK_COLORSPACE_
// CONVERSION_WEBGL is NONE). u_input: 0 = BT.709-encoded SDR; 1 / 2 = PQ / HLG-encoded BT.2020, tone-mapped.
const FRAME_FRAGMENT = `${GL_FRAGMENT_COMMON}
uniform sampler2D u_source;
uniform vec3 u_outToTexX;
uniform vec3 u_outToTexY;
uniform vec2 u_outSize;
uniform int u_input;
uniform bool u_grade;
${HDR_TO_SDR}
${GL_COLOR_GRADE}
void main() {
	vec2 outPx = vec2(gl_FragCoord.x, u_outSize.y - gl_FragCoord.y);
	vec3 texel = texture(u_source, mapRows(u_outToTexX, u_outToTexY, outPx)).rgb;

	if (u_input == 0 && !u_grade) {
		outColor = vec4(texel, 1.0);
		return;
	}

	vec3 linear = u_input == 0 ? decodeTransfer(texel) : hdrToSdrLinear(texel, u_input);
	outColor = vec4(encodeTransfer(u_grade ? grade(linear, outPx) : linear), 1.0);
}
`

// A 10-bit planar picture (I420P10 / I422P10 / I444P10, as VideoFrame.copyTo gives it) decoded here, so the tone map
// sees the stream's own code values whatever the browser would do with them. BT.2020 non-constant-luminance Y′CbCr
// (ITU-R BT.2020 Table 4) at limited or full range; each plane sampled bilinearly by hand (integer textures are not
// filterable).
const PLANES_FRAGMENT = `${GL_FRAGMENT_COMMON}
precision highp usampler2D;

uniform usampler2D u_planeY;
uniform usampler2D u_planeU;
uniform usampler2D u_planeV;
uniform vec2 u_lumaSize;
uniform vec2 u_chromaSize;
uniform vec3 u_outToTexX;
uniform vec3 u_outToTexY;
uniform vec2 u_outSize;
uniform int u_input;
uniform bool u_fullRange;
uniform bool u_grade;
${HDR_TO_SDR}
${GL_COLOR_GRADE}
float plane(usampler2D s, vec2 size, vec2 uv) {
	vec2 p = uv * size - 0.5;
	vec2 f = fract(p);
	ivec2 i = ivec2(floor(p));
	ivec2 last = ivec2(size) - 1;
	float a = float(texelFetch(s, clamp(i, ivec2(0), last), 0).r);
	float b = float(texelFetch(s, clamp(i + ivec2(1, 0), ivec2(0), last), 0).r);
	float c = float(texelFetch(s, clamp(i + ivec2(0, 1), ivec2(0), last), 0).r);
	float d = float(texelFetch(s, clamp(i + ivec2(1, 1), ivec2(0), last), 0).r);
	return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
	vec2 outPx = vec2(gl_FragCoord.x, u_outSize.y - gl_FragCoord.y);
	vec2 uv = mapRows(u_outToTexX, u_outToTexY, outPx);
	float y = plane(u_planeY, u_lumaSize, uv);
	float cb = plane(u_planeU, u_chromaSize, uv) - 512.0;
	float cr = plane(u_planeV, u_chromaSize, uv) - 512.0;
	y = u_fullRange ? y / 1023.0 : (y - 64.0) / 876.0;
	cb /= u_fullRange ? 1023.0 : 896.0;
	cr /= u_fullRange ? 1023.0 : 896.0;
	vec3 encoded = vec3(y + 1.4746 * cr, y - 0.16455 * cb - 0.57135 * cr, y + 1.8814 * cb);
	vec3 linear = hdrToSdrLinear(encoded, u_input);
	outColor = vec4(encodeTransfer(u_grade ? grade(linear, outPx) : linear), 1.0);
}
`

// A text box's raster (premultiplied), blended over the frame with ONE, ONE_MINUS_SRC_ALPHA.
const TEXT_FRAGMENT = `${GL_FRAGMENT_COMMON}
uniform sampler2D u_text;
// left, top, right, bottom in output px.
uniform vec4 u_box;
uniform vec2 u_outSize;

void main() {
	vec2 outPx = vec2(gl_FragCoord.x, u_outSize.y - gl_FragCoord.y);
	outColor = texture(u_text, (outPx - u_box.xy) / (u_box.zw - u_box.xy));
}
`

export const VIDEO_FRAGMENTS = { frame: FRAME_FRAGMENT, planes: PLANES_FRAGMENT, text: TEXT_FRAGMENT } as const

export type VideoProgramName = keyof typeof VIDEO_FRAGMENTS
