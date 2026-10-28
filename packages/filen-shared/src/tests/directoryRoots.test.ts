import { describe, expect, it } from "vitest"
import { outermostRoots, validateRootCandidate } from "@filen/shared"

describe("root validation", () => {
	const DRIVE = "drive-root"
	const DOT_FILEN = "dot-filen"
	const roots = [
		{ uuid: "movies", ancestors: [DRIVE, "media"] },
		{ uuid: "shows", ancestors: [DRIVE, "media"] }
	]

	it("refuses shared-in and public-link directories", () => {
		expect(validateRootCandidate({ candidate: { uuid: "x", ancestors: [], ownDrive: false }, roots, dotFilenUuid: null })).toEqual({
			ok: false,
			reason: "notOwnDrive"
		})
	})

	it("refuses .filen and anything inside it", () => {
		for (const candidate of [
			{ uuid: DOT_FILEN, ancestors: [DRIVE], ownDrive: true },
			{ uuid: "videos", ancestors: [DRIVE, DOT_FILEN], ownDrive: true }
		]) {
			expect(validateRootCandidate({ candidate, roots, dotFilenUuid: DOT_FILEN })).toEqual({ ok: false, reason: "systemDirectory" })
		}
	})

	it("offers to replace the roots a nested candidate overlaps, either way round, naming the ones holding it", () => {
		expect(
			validateRootCandidate({ candidate: { uuid: "media", ancestors: [DRIVE], ownDrive: true }, roots, dotFilenUuid: null })
		).toEqual({
			ok: false,
			reason: "nested",
			replace: ["movies", "shows"]
		})
		expect(
			validateRootCandidate({
				candidate: { uuid: "action", ancestors: [DRIVE, "media", "movies"], ownDrive: true },
				roots,
				dotFilenUuid: null
			})
		).toEqual({ ok: false, reason: "nested", replace: ["movies"], within: ["movies"] })
		expect(
			validateRootCandidate({ candidate: { uuid: DRIVE, ancestors: [], ownDrive: true }, roots, dotFilenUuid: null })
		).toMatchObject({
			reason: "nested"
		})
	})

	it("accepts a separate directory and refuses one already a root", () => {
		expect(
			validateRootCandidate({ candidate: { uuid: "music", ancestors: [DRIVE], ownDrive: true }, roots, dotFilenUuid: null })
		).toEqual({ ok: true })
		expect(
			validateRootCandidate({ candidate: { uuid: "movies", ancestors: [DRIVE, "media"], ownDrive: true }, roots, dotFilenUuid: null })
		).toEqual({
			ok: false,
			reason: "alreadyRoot"
		})
	})
})

describe("outermostRoots", () => {
	it("drops a root another root holds, and a duplicate", () => {
		expect(
			outermostRoots([
				{ uuid: "movies", ancestors: ["drive", "media"] },
				{ uuid: "media", ancestors: ["drive"] },
				{ uuid: "music", ancestors: ["drive"] },
				{ uuid: "music", ancestors: ["drive"] }
			])
		).toEqual(["media", "music"])
	})

	it("keeps a root whose ancestors are unknown, and every root under an unlisted drive root", () => {
		expect(
			outermostRoots([
				{ uuid: "a", ancestors: null },
				{ uuid: "b", ancestors: ["drive", "x"] }
			])
		).toEqual(["a", "b"])
	})

	it("drops everything under the whole drive when it is a root", () => {
		expect(
			outermostRoots([
				{ uuid: "pics", ancestors: ["drive"] },
				{ uuid: "drive", ancestors: [] }
			])
		).toEqual(["drive"])
	})
})
