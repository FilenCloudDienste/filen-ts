import { describe, it, expect, vi } from "vitest"
import { run, runEffect, runOrThrow, runTimeout, TimeoutError } from "@filen/shared"

describe("run", () => {
	describe("basic functionality", () => {
		it("should return success result when function succeeds", async () => {
			const result = await run(async () => {
				return "success"
			})

			expect(result).toEqual({
				success: true,
				data: "success",
				error: null
			})
		})

		it("should return failure result when function throws", async () => {
			const result = await run(async () => {
				throw new Error("failed")
			})

			expect(result).toEqual({
				success: false,
				data: null,
				error: expect.any(Error)
			})
			expect(result.success === false && (result.error as Error).message).toBe("failed")
		})

		it("should work with synchronous functions", async () => {
			const result = await run(() => {
				return 42
			})

			expect(result.success).toBe(true)
			expect(result.success && result.data).toBe(42)
		})
	})

	describe("defer functionality", () => {
		it("should execute deferred functions in LIFO order after the main function", async () => {
			const order: number[] = []

			await run(async defer => {
				defer(() => order.push(1))
				defer(() => order.push(2))
				defer(() => order.push(3))

				order.push(0)

				return "done"
			})

			expect(order).toEqual([0, 3, 2, 1])
		})

		it("should execute deferred functions even when main function throws", async () => {
			const cleanup = vi.fn()

			await run(async defer => {
				defer(cleanup)

				throw new Error("failed")
			})

			expect(cleanup).toHaveBeenCalledOnce()
		})

		it("should await each async deferred function before starting the previous one", async () => {
			const order: string[] = []
			const gate = Promise.withResolvers<void>()
			const secondStarted = Promise.withResolvers<void>()

			const pending = run(async defer => {
				defer(() => {
					order.push("first:start")
				})

				defer(async () => {
					order.push("second:start")

					secondStarted.resolve()

					await gate.promise

					order.push("second:end")
				})

				return "done"
			})

			await secondStarted.promise

			expect(order).toEqual(["second:start"])

			gate.resolve()

			await pending

			expect(order).toEqual(["second:start", "second:end", "first:start"])
		})

		it("should continue executing other deferred functions if one fails", async () => {
			const cleanup1 = vi.fn()
			const cleanup2 = vi.fn()

			await run(async defer => {
				defer(() => cleanup1())

				defer(() => {
					throw new Error("middle cleanup failed")
				})

				defer(() => cleanup2())

				return "done"
			})

			expect(cleanup1).toHaveBeenCalled()
			expect(cleanup2).toHaveBeenCalled()
		})
	})

	describe("options", () => {
		it("should throw error when throw option is true", async () => {
			await expect(
				run(
					async () => {
						throw new Error("test error")
					},
					{
						throw: true
					}
				)
			).rejects.toThrow("test error")
		})

		it("should still execute cleanup before throwing", async () => {
			const cleanup = vi.fn()

			await expect(
				run(
					async defer => {
						defer(() => cleanup())

						throw new Error("test error")
					},
					{
						throw: true
					}
				)
			).rejects.toThrow()

			expect(cleanup).toHaveBeenCalled()
		})
	})
})

describe("runOrThrow", () => {
	it("resolves the bare data on success", async () => {
		await expect(runOrThrow(async () => "value")).resolves.toBe("value")
	})

	it("rethrows the original error after running deferred cleanups LIFO", async () => {
		const order: string[] = []
		const error = new Error("failed")

		await expect(
			runOrThrow(defer => {
				defer(() => {
					order.push("first")
				})

				defer(() => {
					order.push("second")
				})

				throw error
			})
		).rejects.toBe(error)

		expect(order).toEqual(["second", "first"])
	})

	it("runs deferred cleanups before resolving", async () => {
		const order: string[] = []

		const data = await runOrThrow(defer => {
			defer(() => {
				order.push("cleanup")
			})

			return 1
		})

		order.push(`resolved ${data}`)

		expect(order).toEqual(["cleanup", "resolved 1"])
	})
})

describe("runEffect", () => {
	describe("basic functionality", () => {
		it("should return result with cleanup function", () => {
			const result = runEffect(() => {
				return "success"
			})

			expect(result.success).toBe(true)
			expect(result.success && result.data).toBe("success")
			expect(result.cleanup).toBeInstanceOf(Function)
		})

		it("should execute cleanup when called manually", () => {
			const cleanup1 = vi.fn()
			const cleanup2 = vi.fn()

			const result = runEffect(defer => {
				defer(() => cleanup1())
				defer(() => cleanup2())

				return "done"
			})

			expect(cleanup1).not.toHaveBeenCalled()
			expect(cleanup2).not.toHaveBeenCalled()

			result.cleanup()

			expect(cleanup1).toHaveBeenCalled()
			expect(cleanup2).toHaveBeenCalled()
		})

		it("should execute deferred functions in LIFO order", () => {
			const order: number[] = []

			const result = runEffect(defer => {
				defer(() => order.push(1))
				defer(() => order.push(2))
				defer(() => order.push(3))

				return "done"
			})

			result.cleanup()

			expect(order).toEqual([3, 2, 1])
		})
	})

	describe("automatic cleanup", () => {
		it("should automatically cleanup when automaticCleanup is true", () => {
			const cleanup = vi.fn()

			runEffect(
				defer => {
					defer(() => cleanup())

					return "done"
				},
				{
					automaticCleanup: true
				}
			)

			expect(cleanup).toHaveBeenCalled()
		})

		it("should not automatically cleanup when automaticCleanup is false", () => {
			const cleanup = vi.fn()

			runEffect(
				defer => {
					defer(() => cleanup())
					return "done"
				},
				{
					automaticCleanup: false
				}
			)

			expect(cleanup).not.toHaveBeenCalled()
		})
	})

	describe("error handling", () => {
		it("should return error result when function throws", () => {
			const result = runEffect(() => {
				throw new Error("failed")
			})

			expect(result.success).toBe(false)
			expect(result.success === false && (result.error as Error).message).toBe("failed")
		})

		it("should still provide cleanup function on error", () => {
			const cleanup = vi.fn()

			const result = runEffect(defer => {
				defer(() => cleanup())

				throw new Error("failed")
			})

			expect(result.cleanup).toBeInstanceOf(Function)

			result.cleanup()

			expect(cleanup).toHaveBeenCalled()
		})

		it("should rethrow after the automatic cleanup when throw option is true", () => {
			const order: string[] = []
			const error = new Error("failed")

			try {
				runEffect(
					defer => {
						defer(() => {
							order.push("cleanup")
						})

						throw error
					},
					{
						throw: true,
						automaticCleanup: true
					}
				)

				order.push("returned")
			} catch (e) {
				expect(e).toBe(error)

				order.push("caught")
			}

			expect(order).toEqual(["cleanup", "caught"])
		})

		it("should continue executing other deferred functions if one fails", () => {
			const order: number[] = []

			const result = runEffect(defer => {
				defer(() => order.push(1))

				defer(() => {
					throw new Error("middle cleanup failed")
				})

				defer(() => order.push(3))

				return "done"
			})

			expect(() => result.cleanup()).not.toThrow()
			expect(order).toEqual([3, 1])
		})
	})
})

describe("runTimeout", () => {
	describe("basic functionality", () => {
		it("should succeed when function completes before timeout", async () => {
			const result = await runTimeout(async () => {
				await new Promise(resolve => setTimeout(resolve, 10))

				return "success"
			}, 100)

			expect(result.success).toBe(true)
			expect(result.success && result.data).toBe("success")
		})

		it("should timeout when function takes too long", async () => {
			const result = await runTimeout(async () => {
				await new Promise(resolve => setTimeout(resolve, 100))

				return "should not complete"
			}, 20)

			expect(result.success).toBe(false)
			expect(result.success === false && result.error).toBeInstanceOf(TimeoutError)
			expect(result.success === false && (result.error as Error).message).toContain("20ms")
		})

		it("should throw when throw option is true", async () => {
			await expect(
				runTimeout(
					async () => {
						await new Promise(resolve => setTimeout(resolve, 100))

						return "done"
					},
					20,
					{
						throw: true
					}
				)
			).rejects.toThrow(TimeoutError)
		})
	})

	describe("cleanup", () => {
		it("should execute deferred cleanup even on timeout", async () => {
			const cleanup = vi.fn()

			await runTimeout(async defer => {
				defer(() => cleanup())

				await new Promise(resolve => setTimeout(resolve, 100))

				return "done"
			}, 20)

			await new Promise(resolve => setTimeout(resolve, 100))

			expect(cleanup).toHaveBeenCalled()
		})
	})

	describe("error handling", () => {
		it("should handle errors from function itself", async () => {
			const result = await runTimeout(async () => {
				throw new Error("function error")
			}, 100)

			expect(result.success).toBe(false)
			expect(result.success === false && (result.error as Error).message).toBe("function error")
		})
	})
})

describe("integration tests", () => {
	it("should nest multiple defer levels", async () => {
		const order: string[] = []

		await run(async defer1 => {
			defer1(() => order.push("outer-1"))

			await run(async defer2 => {
				defer2(() => order.push("inner-1"))
				defer2(() => order.push("inner-2"))
			})

			defer1(() => order.push("outer-2"))
		})

		expect(order).toEqual(["inner-2", "inner-1", "outer-2", "outer-1"])
	})
})
