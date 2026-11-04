import { describe, expect, it } from "vitest"
import { SpellcheckHost, type SpellcheckHostOptions } from "../host"
import { fakeOrigin, inThreadWorker, tinyAssets, type InThreadWorker } from "./fixtures"

function setup(options: Partial<SpellcheckHostOptions> = {}) {
	const origin = fakeOrigin()
	const workers: InThreadWorker[] = []
	const host = new SpellcheckHost({
		assets: tinyAssets(origin),
		createWorker: () => {
			const worker = inThreadWorker({ fetch: origin.fetch, caches: undefined })

			workers.push(worker)

			return worker
		},
		...options
	})

	return { host, workers, origin }
}

const checks = (worker: InThreadWorker | undefined) => worker?.received.filter(message => message.type === "check") ?? []

describe("SpellcheckHost", () => {
	it("maps languages to the dictionaries it has", () => {
		const { host } = setup()

		expect(host.dictionaryFor("en-US")).toBe("en_US")
		expect(host.dictionaryFor("de-AT")).toBeUndefined()
		expect(host.dictionaryFor("de-DE")).toBe("de_DE")
		expect(host.dictionaryFor("x-none")).toBeUndefined()
		host.dispose()
	})

	it("checks unknown words once and answers from its cache", async () => {
		const { host, workers } = setup()

		expect(host.known("en_US", "hello")).toBeUndefined()

		await Promise.all([host.check("en_US", ["hello", "helo", "hello", "worlds"]), host.check("en_US", ["helo", "café"])])

		expect(host.known("en_US", "hello")).toBe(true)
		expect(host.known("en_US", "helo")).toBe(false)
		expect(host.known("en_US", "café")).toBe(true)
		expect(workers).toHaveLength(1)

		const sent = checks(workers[0])

		expect(
			sent
				.map(message => (message.type === "check" ? message.words.split("\n") : []))
				.flat()
				.sort()
		).toEqual(["café", "hello", "helo", "worlds"])

		await host.check("en_US", ["hello", "helo"])
		expect(checks(workers[0])).toHaveLength(sent.length)
		host.dispose()
	})

	it("treats overlong words as correct without asking", async () => {
		const { host, workers } = setup()

		await host.check("en_US", ["x".repeat(101), ""])
		expect(host.known("en_US", "x".repeat(101))).toBe(true)
		expect(workers).toHaveLength(0)
		host.dispose()
	})

	it("keeps dictionaries apart", async () => {
		const { host } = setup()

		await Promise.all([host.check("en_US", ["Haus", "hello"]), host.check("de_DE", ["Haus", "hello"])])
		expect([host.known("en_US", "Haus"), host.known("en_US", "hello")]).toEqual([false, true])
		expect([host.known("de_DE", "Haus"), host.known("de_DE", "hello")]).toEqual([true, false])
		host.dispose()
	})

	it("rejects checks for a dictionary that fails to load, backs off, and retries later", async () => {
		let time = 0
		const { host, origin, workers } = setup({ now: () => time })
		const dic = [...origin.files.keys()].find(url => url.endsWith("/de.dic.gz")) ?? ""
		const file = origin.files.get(dic)

		origin.files.delete(dic)
		await expect(host.check("de_DE", ["Haus"])).rejects.toThrow(/404/)

		if (file !== undefined) origin.files.set(dic, file)

		// Within the back-off nothing is fetched again.
		const loads = () => workers.flatMap(worker => worker.received).filter(message => message.type === "load").length

		await expect(host.check("de_DE", ["Haus"])).rejects.toThrow(/404/)
		expect(loads()).toBe(1)

		time += 15_000
		await host.check("de_DE", ["Haus"])
		expect(host.known("de_DE", "Haus")).toBe(true)
		expect(loads()).toBe(2)
		host.dispose()
	})

	it("suggests in a separate worker and caches the answer", async () => {
		const { host, workers } = setup()

		await host.check("en_US", ["helo"])

		const suggestions = await host.suggest("en_US", "helo")

		expect(suggestions).toContain("hello")
		expect(workers).toHaveLength(2)
		expect(await host.suggest("en_US", "helo")).toBe(suggestions)
		expect(workers[1]?.received.filter(message => message.type === "suggest")).toHaveLength(1)
		host.dispose()
	})

	it("abandons a slow suggestion request for a newer one", async () => {
		const { host, workers } = setup()
		const slow = host.suggest("en_US", "wrold", { more: true })
		const fast = host.suggest("en_US", "helo")

		await expect(slow).rejects.toMatchObject({ name: "AbortError" })
		expect(await fast).toContain("hello")
		expect(workers[0]?.terminated).toBe(true)
		host.dispose()
	})

	it("answers [] when a suggestion request overruns", async () => {
		const { host, workers } = setup({ suggestTimeoutMs: 0 })

		expect(await host.suggest("en_US", "helo", { more: true })).toEqual([])
		expect(workers[0]?.terminated).toBe(true)
		host.dispose()
	})

	it("stops on an abort signal", async () => {
		const { host } = setup()
		const controller = new AbortController()

		controller.abort()
		await expect(host.suggest("en_US", "helo", { signal: controller.signal })).rejects.toThrow()

		const running = new AbortController()
		const request = host.suggest("en_US", "wrold", { more: true, signal: running.signal })

		running.abort()
		await expect(request).rejects.toMatchObject({ name: "AbortError" })
		host.dispose()
	})

	it("applies the user's words: additions in place, removals by restarting", async () => {
		const { host, workers } = setup()
		let changes = 0

		host.subscribe(() => changes++)
		await host.check("en_US", ["zorp", "hello"])
		expect(host.known("en_US", "zorp")).toBe(false)

		host.setUserWords(["zorp"])
		expect(changes).toBe(1)
		expect(host.known("en_US", "zorp")).toBeUndefined()
		expect(host.known("en_US", "hello")).toBe(true)

		await host.check("en_US", ["zorp", "Zorp"])
		expect([host.known("en_US", "zorp"), host.known("en_US", "Zorp")]).toEqual([true, true])
		expect(workers).toHaveLength(1)

		host.setUserWords(["zorp"])
		expect(changes).toBe(1)

		host.setUserWords([])
		expect(changes).toBe(2)
		expect(workers[0]?.terminated).toBe(true)
		expect(host.known("en_US", "hello")).toBeUndefined()

		await host.check("en_US", ["zorp"])
		expect(host.known("en_US", "zorp")).toBe(false)
		expect(workers).toHaveLength(2)
		host.dispose()
	})

	it("ends an idle worker and starts a new one on demand", async () => {
		const { host, workers } = setup({ checkIdleMs: 5 })

		await host.check("en_US", ["hello"])
		await new Promise(resolve => setTimeout(resolve, 30))
		expect(workers[0]?.terminated).toBe(true)

		await host.check("en_US", ["helo"])
		expect(host.known("en_US", "helo")).toBe(false)
		expect(workers).toHaveLength(2)
		host.dispose()
	})

	it("ends its workers and drops its caches once the last open document closes", async () => {
		const { host, workers } = setup()
		const first = host.open()
		const second = host.open()

		await host.check("en_US", ["hello", "helo"])
		await host.suggest("en_US", "helo")
		first()
		first()
		expect(workers.map(worker => worker.terminated)).toEqual([false, false])
		expect(host.known("en_US", "helo")).toBe(false)

		second()
		expect(workers.map(worker => worker.terminated)).toEqual([true, true])
		expect(host.known("en_US", "helo")).toBeUndefined()

		// The next document starts afresh.
		const third = host.open()

		await host.check("en_US", ["helo"])
		expect(host.known("en_US", "helo")).toBe(false)
		expect(workers).toHaveLength(3)
		third()
		host.dispose()
	})
})
