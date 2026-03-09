---
name: typescript-react-perf
description: >
    Use when writing/reviewing TypeScript, React, or React Native code. Enforces
    zero-waste patterns: monomorphic shapes, Map/Set for O(1) lookups, pre-allocated arrays,
    no hidden class mutations. React: memo + useCallback + useMemo, no inline objects in JSX,
    stable keys. React Native / Hermes: Reanimated worklets, gesture-handler, FlashList,
    StyleSheet.create, no generators or Proxy. Check project's existing libs first.
---

# High-Performance TypeScript / React / React Native

## Core Philosophy

- Allocations are expensive — every object, array, closure costs GC time
- Hot paths are sacred — zero-waste in code that runs frequently
- Use what the project already has — never introduce duplicate libraries

---

## 1. Engine Optimization

### Keep object shapes monomorphic

```typescript
// ❌ Polymorphic — JIT deoptimizes
function process(obj: { x: number } | { x: string }) {
	return obj.x
}

// ✅ Monomorphic — direct property access
function processNum(obj: { x: number }) {
	return obj.x
}
```

### Never change object shapes after creation

```typescript
// ❌ Hidden class changes
const obj: any = {}
obj.x = 1
obj.y = 2

// ✅ Define all properties upfront
const obj = { x: 1, y: 2 }
```

---

## 2. Memory & Allocation

### Pre-allocate, don't grow

```typescript
// ❌ Array grows repeatedly
const results: string[] = []
for (const item of items) results.push(transform(item))

// ✅ Pre-allocate exact size
const results = new Array<string>(items.length)
for (let i = 0; i < items.length; i++) results[i] = transform(items[i]!)
```

### Avoid closures in hot loops

```typescript
// ❌ Closure allocated every iteration
items.forEach((item, i) => {
	results[i] = process(item, context)
})

// ✅ for loop, no closure
for (let i = 0; i < items.length; i++) results[i] = process(items[i]!, context)
```

---

## 3. Data Structures

| Use case                   | Use                           | Never use                     |
| -------------------------- | ----------------------------- | ----------------------------- |
| Key-value, frequent lookup | `Map<K,V>`                    | Plain object for dynamic keys |
| Membership test            | `Set<T>`                      | `Array.includes()`            |
| Numeric data, typed        | `Float64Array` / `Int32Array` | `number[]`                    |
| FIFO queue                 | Circular buffer / deque       | `Array.shift()` — O(n)        |

---

## 4. Async & Concurrency

```typescript
// ❌ Sequential
const a = await fetchA()
const b = await fetchB()

// ✅ Parallel
const [a, b] = await Promise.all([fetchA(), fetchB()])
```

Use `Promise.allSettled` when partial failure is acceptable.

---

## 5. React Performance

### Memoization

```typescript
const ExpensiveList = memo(({ items }: { items: Item[] }) => {
	return <ul>{items.map(item => <ListItem key={item.id} item={item} />)}</ul>
})

const handleClick = useCallback((id: string) => {
	dispatch({ type: "SELECT", id })
}, [dispatch])

const sorted = useMemo(
	() => [...items].sort((a, b) => fastLocaleCompare(a.name, b.name)),
	[items]
)
```

### Keys — stable and unique, never index

```typescript
// ❌ items.map((item, i) => <Item key={i} {...item} />)
// ✅ items.map(item => <Item key={item.id} {...item} />)
```

### No inline objects/arrays in JSX

```typescript
// ❌ New reference every render — breaks memo
<Component style={{ margin: 0 }} options={["a", "b"]} />

// ✅ Stable references
const STYLE = { margin: 0 } as const
const OPTIONS = ["a", "b"] as const
<Component style={STYLE} options={OPTIONS} />
```

### Virtualize large lists (web/desktop)

For web and Electron apps, virtualize lists with 100+ items. Check which library the project uses (`react-window`, `@tanstack/react-virtual`, etc.) before adding one.

### Lazy-load heavy components (web/desktop)

```typescript
const HeavyChart = lazy(() => import("./HeavyChart"))

<Suspense fallback={<Spinner />}>
	<HeavyChart />
</Suspense>
```

### State — use what the project uses

- This project uses **Zustand** for UI state, **TanStack Query** for server state across all packages
- Never `useEffect` + `fetch` + `useState` — use TanStack Query
- Split state by update frequency

### Context — never put high-frequency data in a single context

```typescript
// ❌ Every consumer re-renders on ANY change
const AppContext = createContext({ user, theme, cart, notifications })

// ✅ Split by update frequency
const UserContext = createContext<User | null>(null)
const CartContext = createContext<CartState>(emptyCart)
```

---

## 6. React Native / Hermes

Hermes pre-compiles JS to bytecode. No full JIT. Monomorphism matters even more. Minimize JS thread work.

### Animations — Reanimated worklets (project uses reanimated 4.x)

```typescript
// ✅ Worklets run on UI thread — zero JS thread cost
const translateX = useSharedValue(0)
const animatedStyle = useAnimatedStyle(() => {
	"worklet"

	return { transform: [{ translateX: translateX.value }] }
})
translateX.value = withSpring(100, {
	damping: 15,
	stiffness: 150
})

// ❌ JS-driven Animated.Value — drops frames
// ❌ setState in scroll/gesture handlers
```

### Gestures — gesture-handler (project uses it)

Always use `react-native-gesture-handler` for interactive elements during scroll/animation. `TouchableOpacity` from core runs on JS thread.

### Lists — FlashList (project uses @shopify/flash-list)

```typescript
const renderItem = useCallback(
	({ item }: { item: Item }) => <ItemRow item={item} />,
	[]
)
const ItemRow = memo(({ item }: { item: Item }) => <View>...</View>)

<FlashList
	data={items}
	renderItem={renderItem}
	estimatedItemSize={72}
	keyExtractor={item => item.id}
/>
```

Never use `ScrollView` + `.map()` for more than ~20 items.

### Images — expo-image (project uses it)

Always set explicit `width` and `height`. Use `cachePolicy`.

### Styling — tailwindcss + uniwind (project uses it)

Use className strings via uniwind. For dynamic styles, use `useMemo`:

```typescript
const dynamicStyle = useMemo(() => ({ opacity: isActive ? 1 : 0.5 }), [isActive])
```

### Hermes-specific — always apply

```typescript
// ❌ Generators — slow on Hermes
function* generateIds() {
	yield 1
}
// ✅ Plain array
function getIds() {
	return [1, 2]
}

// ❌ Proxy — very slow on Hermes
const tracked = new Proxy(obj, handler)
// ✅ Explicit methods

// ❌ Spread in hot paths — allocates
const merged = { ...defaults, ...overrides }
// ✅ Object.assign for hot paths
const result = Object.assign({} as Config, defaults, overrides)
```

### Memory — clean up everything

```typescript
useEffect(() => {
	const sub = AppState.addEventListener("change", handleAppState)

	return () => sub.remove()
}, [])
```

Cancel async ops on unmount. Remove all event listeners.

---

## 7. Patterns to Avoid

- `delete obj.key` — changes hidden class, use `obj.key = undefined` or Map
- `eval`, `new Function` — prevents optimization
- `Array.from(set).filter(...)` — iterate directly instead
- Regex in hot path — pre-compile at module level
- `try/catch` in tight loops — extract to wrapper function
- Optional chaining in hot paths — validate shape once at boundary
