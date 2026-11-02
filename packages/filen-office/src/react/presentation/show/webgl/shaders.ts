// GLSL ES 3.00 sources of the show's WebGL2 transitions, as plain strings compiled by the driver (no script is
// evaluated). Texture coordinates run top-down (row 0 is a source's top row, uploaded without a flip), slide-normalised
// positions likewise; every colour is premultiplied by its alpha.

// A unit quad (corners 0..1) placed by a 2D affine as mat3 (corner → clip space).
export const QUAD_VERTEX = `#version 300 es
in vec2 aCorner;
uniform mat3 uPlace;
out vec2 vUv;
void main() {
	vUv = aCorner;
	vec3 p = uPlace * vec3(aCorner, 1.0);
	gl_Position = vec4(p.xy, 0.0, 1.0);
}`

// One source over a quad at an opacity: the composition of a slide's layer canvases.
export const COMPOSE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uAlpha;
out vec4 outColor;
void main() {
	outColor = texture(uTex, vUv) * uAlpha;
}`

// Morph, instanced: one instance per drawn element, a quad over the region it covers in the frame (slide px, then
// clip). Per instance: the quad, the affine maps from slide px to the outgoing and incoming piece's place in its atlas
// page (two rows each), those places (uv rectangles, outside which a piece is transparent) and the weights. The uv
// maps are affine, so they are exact per vertex and interpolate exactly.
export const MORPH_VERTEX = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aQuad;
layout(location = 2) in vec3 aAx;
layout(location = 3) in vec3 aAy;
layout(location = 4) in vec3 aBx;
layout(location = 5) in vec3 aBy;
layout(location = 6) in vec4 aRectA;
layout(location = 7) in vec4 aRectB;
layout(location = 8) in vec2 aWeight;
uniform mat3 uClip;
out vec2 vUvA;
out vec2 vUvB;
flat out vec4 vRectA;
flat out vec4 vRectB;
flat out vec2 vWeight;
void main() {
	vec3 p = vec3(mix(aQuad.xy, aQuad.zw, aCorner), 1.0);
	vUvA = vec2(dot(aAx, p), dot(aAy, p));
	vUvB = vec2(dot(aBx, p), dot(aBy, p));
	vRectA = aRectA;
	vRectB = aRectB;
	vWeight = aWeight;
	vec3 c = uClip * p;
	gl_Position = vec4(c.xy, 0.0, 1.0);
}`

export const MORPH_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUvA;
in vec2 vUvB;
flat in vec4 vRectA;
flat in vec4 vRectB;
flat in vec2 vWeight;
uniform sampler2D uA;
uniform sampler2D uB;
out vec4 outColor;
vec4 sampleIn(sampler2D tex, vec2 uv, vec4 rect, float weight) {
	if (weight <= 0.0) return vec4(0.0);
	if (uv.x < rect.x || uv.y < rect.y || uv.x > rect.z || uv.y > rect.w) return vec4(0.0);
	// Clamped half a texel inside its place, as a texture of its own clamps to its edge.
	vec2 inset = 0.5 / vec2(textureSize(tex, 0));
	return texture(tex, clamp(uv, rect.xy + inset, max(rect.xy + inset, rect.zw - inset))) * weight;
}
void main() {
	outColor = sampleIn(uA, vUvA, vRectA, vWeight.x) + sampleIn(uB, vUvB, vRectB, vWeight.y);
}`

// The full-stage particle transitions (MS-PPTX §2.3.1: ripple, honeycomb, glitter), each a function of
// progress that is exactly the outgoing slide at 0 and the incoming one at 1.
export const SCREEN_VERTEX = `#version 300 es
in vec2 aCorner;
out vec2 vUv;
void main() {
	vUv = aCorner;
	gl_Position = vec4(aCorner.x * 2.0 - 1.0, 1.0 - aCorner.y * 2.0, 0.0, 1.0);
}`

export const SCREEN_HEAD = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uP;
uniform int uMode;
uniform vec2 uDir;
uniform float uAspect;
out vec4 outColor;

const float PI = 3.14159265;

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec4 sampleIn(sampler2D tex, vec2 uv) {
	if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
	return texture(tex, uv);
}

// Pointy-top hexagons of inradius 0.5: the offset from the nearest centre (xy) and that centre (zw).
vec4 hexCell(vec2 p) {
	const vec2 r = vec2(1.0, 1.7320508);
	vec2 h = r * 0.5;
	vec2 a = mod(p, r) - h;
	vec2 b = mod(p - h, r) - h;
	vec2 g = dot(a, a) < dot(b, b) ? a : b;
	return vec4(g, p - g);
}

float hexDist(vec2 p) {
	p = abs(p);
	return max(dot(p, vec2(0.5, 0.8660254)), p.x);
}

// Diamond cells (a square grid turned 45°) of the same scale.
vec4 diamondCell(vec2 p) {
	const float c = 0.70710678;
	vec2 q = vec2(c * p.x - c * p.y, c * p.x + c * p.y);
	vec2 cell = floor(q) + 0.5;
	vec2 centre = vec2(c * cell.x + c * cell.y, -c * cell.x + c * cell.y);
	return vec4(p - centre, centre);
}

float diamondDist(vec2 g) {
	const float c = 0.70710678;
	vec2 q = vec2(c * g.x - c * g.y, c * g.x + c * g.y);
	return max(abs(q.x), abs(q.y));
}

float along(vec2 centre) {
	// The way the transition moves (dir l, r, u, d): it starts on the opposite side.
	if (uDir.x < 0.0) return 1.0 - centre.x;
	if (uDir.x > 0.0) return centre.x;
	if (uDir.y < 0.0) return 1.0 - centre.y;
	return centre.y;
}

float easeOut(float x) {
	return 1.0 - (1.0 - x) * (1.0 - x);
}
`

// Each effect is its own program (a smaller shader compiles sooner).
export const SCREEN_EFFECTS = {
	ripple: `vec4 ripple() {
	vec2 scale = vec2(uAspect, 1.0);
	vec2 d = (vUv - uDir) * scale;
	float dist = length(d);
	float reach = max(max(length((vec2(0.0, 0.0) - uDir) * scale), length((vec2(1.0, 0.0) - uDir) * scale)),
		max(length((vec2(0.0, 1.0) - uDir) * scale), length((vec2(1.0, 1.0) - uDir) * scale)));
	float band = 0.25;
	float front = uP * (reach + band);
	float k = dist - front;
	float wave = exp(-k * k * 60.0) * sin(k * 70.0) * 0.025 * sin(PI * uP);
	vec2 away = dist > 1e-5 ? d / dist : vec2(0.0);
	vec2 uv = vUv + away * wave / scale;
	float inside = 1.0 - smoothstep(front - band, front, dist);
	return mix(texture(uFrom, uv), texture(uTo, uv), inside);
}
`,
	honeycomb: `vec4 honeycomb() {
	vec2 scale = vec2(uAspect, 1.0);
	float size = 0.14;
	vec4 cell = hexCell(vUv * scale / size);
	float delay = hash(cell.zw) * 0.6;
	float t = clamp((uP - delay) / 0.4, 0.0, 1.0);
	float s = 1.0 - t;
	if (s <= 1e-3) return texture(uTo, vUv);
	float a = -t * PI * 0.5;
	vec2 q = mat2(cos(a), sin(a), -sin(a), cos(a)) * cell.xy / s;
	if (hexDist(q) > 0.5) return texture(uTo, vUv);
	vec4 c = texture(uFrom, (cell.zw + q) * size / scale);
	// The turning cell darkens as it goes.
	return vec4(c.rgb * (1.0 - 0.5 * t), c.a);
}
`,
	glitter: `vec4 glitter() {
	vec2 scale = vec2(uAspect, 1.0);
	float size = 0.07;
	vec2 p = vUv * scale / size;
	bool hexagon = uMode == 1;
	vec4 cell = hexagon ? hexCell(p) : diamondCell(p);
	vec2 centre = cell.zw * size / scale;
	float delay = 0.6 * clamp(along(centre), 0.0, 1.0) + 0.1 * hash(cell.zw);
	float t = clamp((uP - delay) / 0.3, 0.0, 1.0);
	float turn = cos(PI * t);
	float w = abs(turn);
	vec2 q = vec2(cell.x / max(w, 1e-3), cell.y);
	float dist = hexagon ? hexDist(q) : diamondDist(q);
	if (w <= 1e-3 || dist > 0.5) return vec4(0.0, 0.0, 0.0, 1.0);
	vec2 uv = (cell.zw + q) * size / scale;
	vec4 c = t < 0.5 ? texture(uFrom, uv) : texture(uTo, uv);
	float sparkle = pow(sin(PI * t), 4.0) * (0.35 + 0.65 * hash(cell.zw + 7.0));
	return vec4(min(c.rgb + sparkle * c.a, vec3(1.0)), c.a);
}
`
} as const

export type ScreenEffect = keyof typeof SCREEN_EFFECTS

export function screenFragment(effect: ScreenEffect): string {
	return `${SCREEN_HEAD}${SCREEN_EFFECTS[effect]}
void main() {
	outColor = ${effect}();
}`
}

// Tile transitions (vortex, shred): a grid of quads, one instance per tile, each cut from one slide and moved on its
// own; side 0 draws the outgoing slide's tiles, side 1 the incoming one's. Tiles are at rest at the ends.
export const TILES_VERTEX = `#version 300 es
in vec2 aCorner;
uniform vec2 uGrid;
uniform float uP;
uniform int uKind;
uniform int uMode;
uniform int uSide;
uniform vec2 uDir;
uniform float uAspect;
out vec2 vUv;
out float vAlpha;

const float PI = 3.14159265;

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

mat2 rotation(float a) {
	return mat2(cos(a), sin(a), -sin(a), cos(a));
}

void main() {
	float cols = uGrid.x;
	float id = float(gl_InstanceID);
	vec2 tile = vec2(mod(id, cols), floor(id / cols));
	vec2 size = 1.0 / uGrid;
	vec2 uv = (tile + aCorner) * size;
	vec2 centre = (tile + 0.5) * size;
	vec2 scale = vec2(uAspect, 1.0);
	// Positions in height units about the slide's centre.
	vec2 local = (aCorner - 0.5) * size * scale;
	vec2 at = (centre - 0.5) * scale;
	float r = hash(tile + float(uSide) * 17.0);
	float e = 0.0;
	float alpha = 1.0;
	float spin = 0.0;
	float shrink = 1.0;

	if (uKind == 5) {
		// Vortex: tiles swirl off around the centre and away the way of dir; the incoming ones swirl in reversed.
		float ahead = uDir.x < 0.0 ? 1.0 - centre.x : uDir.x > 0.0 ? centre.x : uDir.y < 0.0 ? 1.0 - centre.y : centre.y;
		float delay = 0.35 * (1.0 - ahead) + 0.1 * r;
		float time = uSide == 0 ? uP : 1.0 - uP;
		e = clamp((time - delay) / 0.55, 0.0, 1.0);
		float swirl = e * e * 3.0 * PI * (uDir.x + uDir.y < 0.0 ? -1.0 : 1.0);
		at = rotation(swirl) * at * (1.0 + 1.5 * e) + uDir * e * 0.8;
		spin = e * 2.0 * PI * (r - 0.5) * 2.0;
		shrink = 1.0 - 0.6 * e;
		alpha = 1.0 - smoothstep(0.6, 1.0, e);
	} else {
		// Shred: strips (modes 0, 1) move up and down by turns, rectangles (modes 2, 3) each its own way; "in" (modes 0,
		// 2) the incoming slide's arrive over the outgoing one, "out" (modes 1, 3) the outgoing slide's leave.
		bool inward = uMode == 0 || uMode == 2;
		bool moving = inward ? uSide == 1 : uSide == 0;
		float time = inward ? 1.0 - uP : uP;
		float delay = 0.4 * r;
		e = moving ? clamp((time - delay) / 0.6, 0.0, 1.0) : 0.0;
		vec2 way;
		if (uMode <= 1) {
			way = vec2(0.0, mod(tile.x, 2.0) < 0.5 ? -1.0 : 1.0);
		} else {
			float a = r * 2.0 * PI;
			way = vec2(cos(a), sin(a));
			way /= max(abs(way.x), abs(way.y));
			spin = e * PI * (r - 0.5);
		}
		at += way * e * e * 1.6 * scale;
		alpha = moving ? 1.0 - smoothstep(0.7, 1.0, e) : 1.0;
	}

	vec2 p = at + rotation(spin) * local * shrink;
	vec2 n = p / scale + 0.5;
	vUv = uv;
	vAlpha = alpha;
	gl_Position = vec4(n.x * 2.0 - 1.0, 1.0 - n.y * 2.0, 0.0, 1.0);
}`

export const TILES_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
in float vAlpha;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
	outColor = texture(uTex, vUv) * vAlpha;
}`
