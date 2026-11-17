// The 3D viewer's camera: an orbit around a target, as pure math with no damping and no loop, so a frame is drawn only
// when the camera actually changed. Angles in radians; azimuth around +Y, polar from +Y.

export type Vec3 = readonly [number, number, number]

export interface Orbit {
	readonly target: Vec3
	readonly radius: number
	readonly azimuth: number
	readonly polar: number
}

// The polar angle stays off the poles, so "up" never flips.
const POLAR_MIN = 0.01
const POLAR_MAX = Math.PI - 0.01
// Drag sensitivity: a full canvas height turns half a revolution.
const ROTATE_SPEED = Math.PI
const ZOOM_MIN = 0.01
const ZOOM_MAX = 100

export interface BoundingSphere {
	readonly center: Vec3
	readonly radius: number
}

// The camera distance at which a sphere fills the view at `fov` (vertical, degrees) and `aspect`.
export function fitRadius(sphere: BoundingSphere, fov: number, aspect: number): number {
	const vertical = (fov * Math.PI) / 360
	const horizontal = Math.atan(Math.tan(vertical) * Math.max(aspect, 1e-3))
	const half = Math.min(vertical, horizontal)

	return Math.max(sphere.radius, 1e-6) / Math.sin(half)
}

// The view the model opens at and Reset returns to: from the front-right, slightly above.
export function homeOrbit(sphere: BoundingSphere, fov: number, aspect: number): Orbit {
	return { target: sphere.center, radius: fitRadius(sphere, fov, aspect) * 1.1, azimuth: Math.PI / 4, polar: Math.PI / 3 }
}

// Fit keeps the angles and frames the model again.
export function fitOrbit(orbit: Orbit, sphere: BoundingSphere, fov: number, aspect: number): Orbit {
	return { ...orbit, target: sphere.center, radius: fitRadius(sphere, fov, aspect) * 1.1 }
}

export function cameraPosition(orbit: Orbit): Vec3 {
	const { target, radius, azimuth, polar } = orbit
	const sinPolar = Math.sin(polar)

	return [
		target[0] + radius * sinPolar * Math.sin(azimuth),
		target[1] + radius * Math.cos(polar),
		target[2] + radius * sinPolar * Math.cos(azimuth)
	]
}

// A drag of (dx, dy) canvas pixels on a canvas `height` pixels tall.
export function rotateOrbit(orbit: Orbit, dx: number, dy: number, height: number): Orbit {
	const scale = ROTATE_SPEED / Math.max(height, 1)

	return {
		...orbit,
		azimuth: orbit.azimuth - dx * scale,
		polar: Math.min(POLAR_MAX, Math.max(POLAR_MIN, orbit.polar - dy * scale))
	}
}

// Moves the target in the view plane by (dx, dy) canvas pixels, so the model follows the pointer.
export function panOrbit(orbit: Orbit, dx: number, dy: number, height: number, fov: number): Orbit {
	const perPixel = (2 * orbit.radius * Math.tan((fov * Math.PI) / 360)) / Math.max(height, 1)
	const { azimuth, polar } = orbit
	// The camera's right and up vectors.
	const right: Vec3 = [Math.cos(azimuth), 0, -Math.sin(azimuth)]
	const up: Vec3 = [-Math.cos(polar) * Math.sin(azimuth), Math.sin(polar), -Math.cos(polar) * Math.cos(azimuth)]
	const [x, y, z] = orbit.target

	return {
		...orbit,
		target: [
			x - (right[0] * dx - up[0] * dy) * perPixel,
			y - (right[1] * dx - up[1] * dy) * perPixel,
			z - (right[2] * dx - up[2] * dy) * perPixel
		]
	}
}

// Zooms by `factor` (above 1: closer), within ZOOM_MIN..ZOOM_MAX of the fitted distance.
export function zoomOrbit(orbit: Orbit, factor: number, fitted: number): Orbit {
	return { ...orbit, radius: Math.min(fitted * ZOOM_MAX, Math.max(fitted * ZOOM_MIN, orbit.radius / factor)) }
}

export function sameOrbit(a: Orbit, b: Orbit): boolean {
	return a.radius === b.radius && a.azimuth === b.azimuth && a.polar === b.polar && a.target.every((value, i) => value === b.target[i])
}
