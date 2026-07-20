# 代码经验候选清单

> 每一条都包含：**坏味道示例** → **正确做法** → **原因**。勾选后纳入 code-standards。

---

## 一、条件与分支

### - [ ] 1. Guard Clause 优先于 if-else 嵌套

```typescript
// ❌ 箭头式嵌套，主逻辑在第 4 层缩进
function getDisplayName(user: User | null): string {
  if (user) {
    if (user.profile) {
      if (user.profile.nickname) {
        return user.profile.nickname
      }
      else {
        return user.username
      }
    }
    else {
      return 'Unknown'
    }
  }
  else {
    return 'Unknown'
  }
}

// ✅ 提前 return 掉异常情况，主逻辑保持顶层
function getDisplayName(user: User | null): string {
  if (!user?.profile)
    return 'Unknown'
  return user.profile.nickname || user.username
}
```

**原因**：提前 return 让读者逐行排除异常，读到主逻辑时心智负担为零。

### - [ ] 2. 布尔参数拆成两个函数或用 options 对象

```typescript
// ❌ 调用方看不懂 true 是什么意思
fetchOrders(true, false, true)

// ✅ 方案一：拆成两个语义明确的函数
fetchActiveOrders()
fetchAllOrders()

// ✅ 方案二：用 options 对象
fetchOrders({ activeOnly: true, includeDeleted: false, sortByDate: true })
```

**原因**：布尔参数强迫读者去查函数签名；超过 1 个布尔参数就必须改。

### - [ ] 3. 超过 4 个 case 的 switch 改用查找表

```typescript
// ❌ 每个 case 只做简单映射，却有 15 行
switch (status) {
  case 'active': return '已激活'
  case 'pending': return '待审核'
  case 'expired': return '已过期'
  case 'banned': return '已禁用'
  // ... 还有 10 个
}

// ✅ 查找表，新增类型不碰逻辑
const STATUS_MAP: Record<string, string> = {
  active: '已激活',
  pending: '待审核',
  expired: '已过期',
  banned: '已禁用',
}
return STATUS_MAP[status] ?? '未知'
```

**原因**：查找表把"数据"和"逻辑"分离；新增项只需加一行，不会漏 break。

### - [ ] 4. 复杂条件提取为命名变量

```typescript
// ❌ 需要 5 秒以上才能理解条件
if (user.age >= 18 && user.country === 'CN' && !user.banned && user.balance > 0)

// ✅ 变量名就是注释
const canPurchase = user.age >= 18 && user.country === 'CN' && !user.banned && user.balance > 0
if (canPurchase)
```

**原因**：命名变量让条件从"计算"变成"陈述"，阅读速度从 5 秒降到 0.5 秒。

### - [ ] 5. 不要对抗 TypeScript 已完成的类型收窄

```typescript
// ❌ TS 已经排除了 null，还要再判
function process(val: string | null) {
  if (val === null)
    return
  if (val) { /* ... */ } // val 一定不是 null，这个判空是噪音
}

// ✅ 信任类型系统
function process(val: string | null) {
  if (val === null)
    return
  // val 已是 string，直接用
}
```

**原因**：多余的判空不仅浪费代码，还让后来的读者怀疑"前面是不是漏了什么"。

### - [ ] 6. `??` vs `||` — 区分"空值"和"假值"

```typescript
// ❌ ''、0、false 是合法值，被错误丢弃
const pageSize = props.pageSize || 20 // 0 被当成"没传"
const searchTerm = props.searchTerm || '' // '' 被当成"没传"
const enabled = props.enabled || true // false 被当成"没传"

// ✅ ?? 只处理 null/undefined
const pageSize = props.pageSize ?? 20
const searchTerm = props.searchTerm ?? ''
const enabled = props.enabled ?? true
```

**原因**：用错运算符导致的 bug 极难发现，因为运行时不报错，只是行为不符合预期。

### - [ ] 7. 三元表达式只用于简单赋值

```typescript
// ❌ 嵌套三元，要做"括号匹配"才能读懂
const label = isActive ? (isAdmin ? '管理员在线' : '用户在线') : (isPending ? '待激活' : '已禁用')

// ✅ 拆成 if-else 或提取函数
let label: string
if (isActive) {
  label = isAdmin ? '管理员在线' : '用户在线'
}
else {
  label = isPending ? '待激活' : '已禁用'
}
```

**原因**：嵌套三元需要读者在脑中做栈操作，而 if-else 可以直接从上往下读。

### - [ ] 8. 不要在条件里执行副作用

```typescript
// ❌ 条件里 push/delete/赋值——读的人会以为是一个纯判断
if (items.push(newItem) > LIMIT) { /* ... */ }
if (cache.delete(key)) { /* ... */ }

// ✅ 副作用单独一行，意图清晰
items.push(newItem)
if (items.length > LIMIT) { /* ... */ }
```

**原因**：条件表达式应该纯粹地回答一个"是/否"问题，任何副作用都让这个回答不再可信。

---

## 二、异步代码

### - [ ] 9. 优先用 `Promise.allSettled`，再用 `Promise.all`

```typescript
// ❌ 一个 reject 导致所有成功结果丢失
const [users, posts] = await Promise.all([fetchUsers(), fetchPosts()])
// 如果 fetchUsers 失败，响应成功返回的 fetchPosts 结果也丢了，页面白屏

// ✅ 每个独立请求的失败不影响其他
const [usersR, postsR] = await Promise.allSettled([fetchUsers(), fetchPosts()])
const users = usersR.status === 'fulfilled' ? usersR.value : []
const posts = postsR.status === 'fulfilled' ? postsR.value : []
// 一个失败，另一个还能正常展示
```

**原因**：独立请求之间不应该互相拖累；只在对"全部成功或全部回滚"有强需求时才用 `all`。

### - [ ] 10. 处理竞态条件 — 旧请求不能覆盖新结果

```typescript
// ❌ 快速切换 tab 时，先发请求后返回，覆盖了最新 tab 的数据
let currentTab = 'a'
async function loadTab(tab: string) {
  currentTab = tab
  const data = await fetch(`/api/${tab}`)
  render(data) // BUG: 如果此时 currentTab 已经变了，data 是旧 tab 的数据
}

// ✅ 方案一：请求回来时检查是否还是当前 tab
async function loadTab(tab: string) {
  currentTab = tab
  const data = await fetch(`/api/${tab}`)
  if (currentTab === tab)
    render(data) // 不是最新 tab 就丢弃
}

// ✅ 方案二：AbortController 取消旧请求
let abortController: AbortController | null = null
async function loadTab(tab: string) {
  abortController?.abort()
  abortController = new AbortController()
  const data = await fetch(`/api/${tab}`, { signal: abortController.signal })
  render(data)
}
```

**原因**：这是异步 UI 最常见的 bug 之一，尤其出现在搜索框、tab 切换、分页器中。

### - [ ] 11. `await` 之后的世界可能已经变了

```typescript
// ❌ 假设 await 前后状态一致
async function transfer(from: Account, to: Account, amount: number) {
  if (from.balance < amount)
    throw new Error('余额不足')
  await deductBalance(from, amount) // 这期间另一笔扣款可能也通过了检查！
  await addBalance(to, amount)
}

// ✅ await 后重新确认关键条件
async function transfer(fromId: string, toId: string, amount: number) {
  const from = await getAccount(fromId) // 用最新数据
  if (from.balance < amount)
    throw new Error('余额不足')
  await deductBalance(fromId, amount) // 原子操作，内部再检查
  await addBalance(toId, amount)
}
```

**原因**：任意一次 `await` 都可能让其他代码插入执行，两次 await 之间是"另一个世界"。

### - [ ] 12. 不要在 `forEach` 里用 `async/await`

```typescript
// ❌ forEach 不等 async 回调，循环瞬间跑完
await items.forEach(async (item) => {
  await saveItem(item) // 这些 save 同时发出，且外层 await 等不到
})

// ✅ 用 for...of 逐条等待
for (const item of items) {
  await saveItem(item)
}

// ✅ 如果需要并发，用 Promise.all
await Promise.all(items.map(item => saveItem(item)))
```

**原因**：`forEach` 忽略 async 回调的返回值，这是设计缺陷。`for...of` 才是正确的串行异步循环。

### - [ ] 13. 未捕获的 rejected Promise 是无声炸弹

```typescript
// ❌ async 函数可能 throw，调用方如果不 await 就完全感知不到
async function loadConfig() {
  const res = await fetch('/api/config')
  return res.json() // 如果这里 throw，调用方没 await 就丢失
}
// 某处调用：loadConfig() —— 没有 await，异常被吞掉

// ✅ 要么 await，要么 .catch
await loadConfig()
// 或
loadConfig().catch((err) => { /* 上报或提示 */ })
```

**原因**：这种 bug 在线上可能零报错但页面异常——最难排查的一类问题。

### - [ ] 14. debounce 用于搜索，throttle 用于滚动

```typescript
// ❌ 搜索用了 throttle：用户快速输入 'hello' 只发了 'h'，丢掉 4 个字母
searchInput.addEventListener('input', throttle(doSearch, 300))

// ✅ 搜索用 debounce：等用户停手再搜
searchInput.addEventListener('input', debounce(doSearch, 300))

// ✅ 滚动用 throttle：滚动中持续触发但不会太频繁
window.addEventListener('scroll', throttle(handleScroll, 16))
```

**原因**：debounce 是"你停了我就做"，throttle 是"你多快我都最多 N 毫秒做一次"。混淆结果完全不同。

### - [ ] 15. `setTimeout(fn, 0)` — 不是为了"更快"，是为了"更晚"

```typescript
// ❌ 以为 setTimeout(fn, 0) 会立即执行——不会
console.log('1')
setTimeout(() => console.log('2'), 0)
console.log('3')
// 输出：1 → 3 → 2   不是 1 → 2 → 3

// ✅ 正确用法：推迟到当前同步代码执行完、DOM 更新完成
input.value = '新值'
setTimeout(() => {
  input.focus() // 此时 DOM 已经反映了新值
}, 0)
```

**原因**：`setTimeout(fn, 0)` 是把 fn 放到宏任务队列末尾，等当前所有同步代码和微任务执行完才运行。

---

## 三、函数设计

### - [ ] 16. 3 个以上同类型参数必须封成对象

```typescript
// ❌ 调用方容易写错参数顺序，且不看到签名就不知道每个参数是什么
drawRect(100, 200, 300, 400)
// 读者：x, y, w, h？还是 left, top, right, bottom？

// ✅ 对象参数，调用自文档化
drawRect({ x: 100, y: 200, width: 300, height: 400 })
// 读者瞬间知道每个值的含义
```

**原因**：防止参数顺序错误（编译器不报错），同时让调用方代码就是自己的文档。

### - [ ] 17. 函数要么做事，要么回答问题——不能两样都干

```typescript
// ❌ getUser 不仅返回用户，还顺便更新了最后登录时间
async function getUser(id: string): Promise<User> {
  const user = await db.findUser(id)
  await db.updateLastLogin(id) // 副作用！调用方完全不知道
  return user
}

// ✅ 要么纯查询（只返回不修改）
async function getUser(id: string): Promise<User> {
  return db.findUser(id)
}
// 要么纯命令（只修改不返回）
async function recordLogin(id: string): Promise<void> {
  await db.updateLastLogin(id)
}
```

**原因**：有副作用的函数不能安全地重试、缓存、或放在判断条件里调用。

### - [ ] 18. 返回值类型必须一致

```typescript
// ❌ 三个分支三种返回，调用方被迫写三套处理逻辑
function getValue(): User | null {
  if (condition1)
    return { id: 1, name: 'Alice' } // 返回 User
  if (condition2)
    return null // 返回 null
  throw new Error('Unexpected') // 抛异常
}

// ✅ 统一用 null 表达"没有"
function getValue(): User | null {
  if (condition1)
    return { id: 1, name: 'Alice' }
  return null
}
```

**原因**：不一致的返回迫使调用方同时处理三种情况，增加心智负担和遗漏风险。

### - [ ] 19. 提取函数的判断标准

```typescript
// ❌ 这段代码需要 5 秒以上才能理解它在做什么
const result = items
  .filter(i => i.status === 'active' && i.price > 0 && i.stock > 0 && !i.deleted)
  .map(i => ({ ...i, displayPrice: i.price * (1 - i.discount) }))

// ✅ 提取后，主逻辑一行读懂
const availableItems = getAvailableItems(items)
const result = availableItems.map(formatDisplayItem)
```

**原因**：如果能用短句描述这段代码要做什么（"过滤出可售商品"），但代码需要 3 秒以上才能读懂，就该提取。

### - [ ] 20. 不要为"将来可能需要"添加参数

```typescript
// ❌ 为将来预留参数，实际从没用到过
function fetchUsers(page: number, sortBy?: string, cache?: boolean) {
  // sortBy 和 cache 两年来从没人传过
}

// ✅ 只写当前需要的
function fetchUsers(page: number) {
  // 将来真需要时再加，那时候类型系统会告诉你所有调用方
}
```

**原因**：多余的参数 = 多余的调用方负担 + 多余的维护成本。等真需要时再加，TS 会精确列出所有要改的地方。

### - [ ] 21. 默认参数必须靠右

```typescript
// ❌ 想跳过 b 时被迫写成 fn(1, undefined, 3)
function fn(a: number, b = 10, c: number) { }

// ✅ 默认参数全部放右边
function fn(a: number, c: number, b = 10) { }
fn(1, 3) // 自然
```

**原因**：TS 中参数位置是重要的 API 设计。默认参数不靠右会破坏调用体验。

---

## 四、类型系统

### - [ ] 22. `type` vs `interface` 的选择标准

```typescript
// 用 interface：需要 extends 或被外部 augment 的公共 API
interface User {
  id: string
  name: string
}
interface Admin extends User { permissions: string[] }

// 用 type：联合/交叉/映射类型，或内部使用的类型
type Status = 'active' | 'inactive' | 'banned'
type UserWithMeta = User & { createdAt: Date, updatedAt: Date }
type ReadonlyUser = Readonly<User>
```

**原因**：interface 的报错信息不如 type 清晰（interface 显示名称，type 展开具体结构）。不确定时用 type。

### - [ ] 23. 不要用 `as` 欺骗编译器

```typescript
// ❌ as 只改变 TS 的类型，不改变运行时的值
const data = await fetch('/api/user').then(r => r.json())
const user = data as User // TS 信了，但运行时 data 可能只有 { id: 1 }
user.name.toUpperCase() // 运行时炸：Cannot read property 'toUpperCase' of undefined

// ✅ 用运行时校验（zod / yup / 手写类型守卫）
const user = UserSchema.parse(data) // 真的验证过了，TS 和运行时都安全
```

**原因**：`as` 只是让 TS 闭嘴，不改变运行时的值。只有经历过运行时校验才能信任。

### - [ ] 24. `any` 是逃生舱，不是交通工具

```typescript
// ❌ any 扩散——一个 any 污染整个表达式
const data: any = fetchData()
data.items[0].name.toUpperCase() // 整条链都没了类型检查

// ✅ unknown + 类型收窄——安全且类型正确
const data: unknown = fetchData()
if (typeof data === 'object' && data !== null && 'items' in data) {
  const items = (data as { items: unknown[] }).items
  // ...
}
```

**原因**：`any` 关闭了该变量及其所有使用处的类型检查。`unknown` 强迫你写类型收窄。

### - [ ] 25. 品牌类型防止 ID 混淆

```typescript
// ❌ UserId 和 PostId 都是 string，传错不报错
type UserId = string
type PostId = string
function deletePost(postId: PostId) { }
const userId: UserId = 'u123'
deletePost(userId) // 传错了，TS 不报错

// ✅ 品牌类型让 TS 区分
type Branded<T, B> = T & { __brand: B }
type UserId = Branded<string, 'UserId'>
type PostId = Branded<string, 'PostId'>
deletePost(userId) // ❌ TS 报错：UserId 不能赋值给 PostId
```

**原因**：当项目中有多个字符串 ID 类型时，这种错误在生产环境中非常隐蔽。

### - [ ] 26. `as const` 让字面量推断更精确

```typescript
// ❌ 推断为 string[]——丢失了具体值信息
const ROLES = ['admin', 'editor', 'viewer']
// ROLES 类型：string[]

// ✅ 推断为 readonly ['admin', 'editor', 'viewer']——保留具体字面量
const ROLES = ['admin', 'editor', 'viewer'] as const
type Role = (typeof ROLES)[number] // 'admin' | 'editor' | 'viewer'
```

**原因**：`as const` 是最轻量的运行时零成本类型工具，从值推导出精确的联合类型。

### - [ ] 27. 泛型约束要窄

```typescript
// ❌ 太宽——T 可能是任何类型，函数体内几乎不能操作 T
function first<T>(arr: T[]): T { return arr[0] }

// ✅ 有约束——函数体内可以安全访问 .id
function findById<T extends { id: string }>(items: T[], id: string): T | undefined {
  return items.find(item => item.id === id)
}
```

**原因**：无约束泛型等同于 `unknown`——你不能安全地对它做任何操作。加约束才能利用 TS 的类型检查。

---

## 五、null / 异常处理

### - [ ] 28. `null` vs `undefined` 语义分工

```typescript
// ❌ 混用 null 和 undefined，不知道哪个是"没值"哪个是"没给"
interface User {
  nickname: string | null | undefined // 这是什么意思？
}

// ✅ 统一语义：undefined = 不存在/没给，null = 明确清空
interface User {
  nickname?: string // 可选——没填
  deletedAt: null | string // null = 没删除，string = 已删除
}
```

**原因**：在同一个项目中统一语义，避免到处写 `value === null || value === undefined`。

### - [ ] 29. 只在你能处理时才 catch

```typescript
// ❌ 捕获了但什么都没做——只是让错误消失了
try {
  await saveToServer(data)
}
catch {
  // 什么都没做，用户以为保存成功了
}

// ✅ 要么重试
try { await saveToServer(data) }
catch { /* 重试一次，还是失败就向上抛 */ }

// ✅ 要么降级
try { await saveToServer(data) }
catch { await saveToLocalStorage(data) }

// ✅ 要么转换后向上抛
try { await saveToServer(data) }
catch (err) { throw new SaveError('保存失败', { cause: err }) }
```

**原因**：`catch { }` 空处理把可观测的 bug 变成了不可观测的 bug——情况更糟。

### - [ ] 30. 不要用 throw 做业务控制流

```typescript
// ❌ throw 被用作"用户名为空就走这个分支"
function validateUsername(name: string) {
  if (!name)
    throw new Error('用户名为空')
  if (name.length < 3)
    throw new Error('用户名太短')
  return true
}
try {
  validateUsername('')
}
catch (e) { /* 用 catch 处理业务逻辑 */ }

// ✅ 业务错误用返回值，异常才是真异常
type ValidationResult = { valid: true } | { valid: false, error: string }
function validateUsername(name: string): ValidationResult {
  if (!name)
    return { valid: false, error: '用户名为空' }
  if (name.length < 3)
    return { valid: false, error: '用户名太短' }
  return { valid: true }
}
```

**原因**：throw 用于不可预见的意外（网络断开、磁盘满）；用户名验证失败是可预见的业务逻辑。

### - [ ] 31. Result 类型优于 try-catch 处理业务错误

```typescript
// ❌ 调用方可能忘记 try-catch，错误往上抛到全局
async function createUser(data: CreateUserDTO) {
  if (await isEmailTaken(data.email))
    throw new Error('邮箱已被占用')
  return db.insertUser(data)
}

// ✅ 返回 Result，调用方无法忽视错误
type Result<T, E> = { ok: true, data: T } | { ok: false, error: E }
async function createUser(data: CreateUserDTO): Promise<Result<User, string>> {
  if (await isEmailTaken(data.email))
    return { ok: false, error: '邮箱已被占用' }
  return { ok: true, data: await db.insertUser(data) }
}

// 调用方被迫处理两种情况
const result = await createUser(data)
if (!result.ok) { /* TS 强迫你处理错误 */ }
```

**原因**：`try-catch` 容易被忘记；Result 类型让错误处理从"可选的"变成"必须的"。

### - [ ] 32. 可选链只在边界用一次，内部不重复

```typescript
// ❌ 链式可选链掩盖了异常数据
const displayName = obj?.user?.profile?.name?.toUpperCase()
// 这条链上任何一个环节是 null/undefined，整条链返回 undefined，不报错

// ✅ 在边界校验一次，内部信任数据
const profile = data?.user?.profile
if (!profile) return <EmptyState />
const displayName = profile.name.toUpperCase()  // 这里不需要 ?.
```

**原因**：长可选链让数据问题悄无声息地被吞掉。边界校验后，内部代码可以基于"数据一定存在"的假设来写。

---

## 六、集合与数据结构

### - [ ] 33. `Map` for 频繁增删, `Record` for 静态查找

```typescript
// ❌ 用普通对象做频繁的增删——删除后留下 undefined 空洞，delete 后 key 还在
const cache: Record<string, Item> = {}
delete cache.key1 // cache['key1'] 是 undefined，但 'key1' in cache 仍是 false
Object.keys(cache) // 比实际数据量少

// ✅ Map 删除不留空洞，且 key 可以是任意类型
const cache = new Map<string, Item>()
cache.delete('key1')
cache.has('key1') // false，干净
```

**原因**：对象做动态键增删容易留下 undefined 值；Map 的 `has/get/set/delete` API 表达力更强。

### - [ ] 34. `Set` 用于去重和存在性检查

```typescript
// ❌ 用数组做去重——O(n²) 或 O(n*m)
const uniqueIds = ids.filter((id, i) => ids.indexOf(id) === i)
if (selectedIds.includes(newId)) { /* 已选中 */ }

// ✅ Set 天然去重、has 是 O(1)
const uniqueIds = [...new Set(ids)]
const selectedSet = new Set(selectedIds)
if (selectedSet.has(newId)) { /* 已选中 */ }
```

**原因**：`Set.has()` 是 O(1)，`Array.includes()` 是 O(n)。数据量超过 100 时差距就明显了。

### - [ ] 35. `reduce` 回调超过 5 行就拆成 for 循环

```typescript
// ❌ reduce 回调 15 行，reviewer 看不懂 accumulator 到底在积累什么
const result = items.reduce((acc, item) => {
  if (item.status === 'active') {
    const group = acc[item.category] ?? []
    group.push({ id: item.id, price: item.price * item.quantity })
    acc[item.category] = group
  }
  // ... 还有 5 行
  return acc
}, {} as Record<string, ProcessedItem[]>)

// ✅ 拆成 for 循环，逻辑和意图都清晰
const result: Record<string, ProcessedItem[]> = {}
for (const item of items) {
  if (item.status !== 'active')
    continue
  if (!result[item.category])
    result[item.category] = []
  result[item.category].push({ id: item.id, price: item.price * item.quantity })
}
```

**原因**：`reduce` 在简单场景（求和、拍平）很优雅，但复杂积累逻辑中每次 return acc 都是噪音。

### - [ ] 36. 数组复制用 `[...arr]` 而非 `slice()` / `concat()`

```typescript
// ❌ 意图不明确——slice() 的本意是切片，不是复制
const copy = arr.slice()
const copy2 = arr.concat()

// ✅ 展开运算符明确表达"复制"
const copy = [...arr]
```

**原因**：`[...arr]` 比 `arr.slice()` 更直观地表达"这是一个浅拷贝"的意图。

### - [ ] 37. 大批量差集/交集用 Set

```typescript
// ❌ 两个 1000 项的数组求差集——O(n*m) = 1000000 次比较
const diff = allItems.filter(x => !selectedItems.includes(x))

// ✅ 用 Set——O(n+m) = 2000 次操作
const selectedSet = new Set(selectedItems)
const diff = allItems.filter(x => !selectedSet.has(x))
```

**原因**：1000×1000 的数组差集，`includes` 慢 500 倍。数据量一大就会有肉眼可见的卡顿。

---

## 七、字符串与文本

### - [ ] 38. 用户可见的字符串不要用 `+` 拼接

```typescript
// ❌ 英文语序和中文不同，拼接假定了一种固定语序
const msg = `您有 ${count} 条新消息`
// 英文版：'You have ' + count + ' new messages'——语序不同

// ✅ 用 i18n 占位符
const msg = t('notification.newMessages', { count })
// 中文：'您有 {count} 条新消息'
// 英文：'You have {count} new messages'
```

**原因**：拼接假定了一种固定的语序和语法结构，这在多语言中必然出错。

### - [ ] 39. URL 拼接用标准 API，不要手动拼

```typescript
// ❌ 手写 URL query string——各种边界情况都没处理
const url = `/api/search?q=${query}&page=${page}&size=${size}` // 空格、特殊字符怎么办？

// ✅ URLSearchParams 自动处理编码
const params = new URLSearchParams({ q: query, page: String(page), size: String(size) })
const url = `/api/search?${params}`
```

**原因**：手动拼接会漏掉 URL 编码、重复 &、undefined 变成 "undefined" 等大量边界情况。

### - [ ] 40. 正则表达式写完后加注释说明它匹配什么

```typescript
// ❌ 三周后自己也读不懂
const regex = /^[\w.+-]+@[\w-]+\.[\w.-]{2,}$/

// ✅ 注释说明意图，或在旁边写几个匹配/不匹配的例子
// 匹配标准邮箱格式：user@domain.com
const EMAIL_REGEX = /^[\w.+-]+@[\w-]+\.[\w.-]{2,}$/
```

**原因**：正则是写一次读十次的东西，每次读都要重新解析，注释能极大降低理解成本。

### - [ ] 41. 截断字符串要截在完整字符边界

```typescript
// ❌ slice(0, 100) 可能切断 emoji 或中文
const preview = `${text.slice(0, 100)}...`
// "Hello 👨‍👩‍👧‍👦" → "Hello 👨‍..."

// ✅ 用 Intl.Segmenter 或至少做 surrogate pair 检查
const segments = [...new Intl.Segmenter().segment(text)]
const preview = `${segments.slice(0, 100).map(s => s.segment).join('')}...`
```

**原因**：emoji、CJK 全角字符、零宽连接符在 `slice` 时会断裂，产生乱码。

---

## 八、Vue / 组件

### - [ ] 42. `v-if` vs `v-show` 选择标准

```vue
<!-- ❌ 弹窗用 v-show——销毁不了，且初始渲染就创建了 DOM -->
<dialog v-show="visible">
 ...
</dialog>

<!-- ✅ 弹窗用 v-if——关闭时销毁，打开时才创建 -->
<dialog v-if="visible">
 ...
</dialog>

<!-- ✅ tab 切换用 v-show——频繁切换，v-if 的销毁重建成本太高 -->
<tab-panel v-show="activeTab === 'home'" />
```

**原因**：`v-if` 初始成本高但切换后为 0，`v-show` 初始成本低但永远占用 DOM。按场景选。

### - [ ] 43. 子组件绝不能直接改 props

```vue
<script setup>
// ❌ 直接修改 props——Vue 会在开发环境报 warning，生产环境行为不可预测
const props = defineProps<{ count: number }>()
// ❌ 报错

// ✅ 通过 emit 通知父组件修改
const emit = defineEmits<{ 'update:count': [value: number] }>()  ;props.count++emit('update:count', props.count + 1)

// ✅ 或者用内部状态初始化
const localCount = ref(props.count)
</script>
```

**原因**：props 是父组件传给子组件的单向数据流，反向修改意味着数据源不唯一。

### - [ ] 44. `computed` 里面绝不能有副作用

```vue
<script setup>
// ❌ computed 里发 API 请求——不可预测：可能被调用 0 次、1 次、N 次
const data = computed(() => {
  fetch('/api/data').then(r => r.json()).then(d => result.value = d)
  return result.value // 且这是异步的，computed 得不到结果
})

// ✅ computed 只做纯计算；副作用放到 watch 或事件处理
const data = ref<Data | null>(null)
watch(source, async (val) => {
  data.value = await fetch(`/api/data/${val}`).then(r => r.json())
})
</script>
```

**原因**：Vue 可能在任意时机调用 computed 的 getter（甚至不调用），在其中做副作用完全不可控。

### - [ ] 45. `watchEffect` vs `watch` 选择标准

```typescript
// watchEffect：不需要旧值，自动追踪所有响应式依赖
watchEffect(() => {
  // 内部读取的任何响应式值变化都会触发
  localStorage.setItem('prefs', JSON.stringify(prefs.value))
})

// watch：需要新旧值对比，或需要精确指定监听源
watch(() => props.userId, (newId, oldId) => {
  if (newId !== oldId)
    loadUser(newId)
})
```

**原因**：`watchEffect` 更简洁但拿不到 oldValue；`watch` 更精确但需要显式指定 source。根据是否要新旧值来选择。

### - [ ] 46. `:key` 决定组件什么时候重建

```vue
<!-- ❌ 用 index 做 key——列表重排时 DOM 被错误复用 -->
<div v-for="(item, index) in items" :key="index">
{{ item.name }}
</div>

<!-- ✅ 用稳定的业务 ID -->
<div v-for="item in items" :key="item.id">
{{ item.name }}
</div>

<!-- ✅ 故意改 key 强制重建组件 -->
<search-panel :key="currentTab" :tab="currentTab" />
<!-- currentTab 变了 → SearchPanel 销毁并重建 → 内部状态全部重置 -->
```

**原因**：`key` 是 Vue 判断"这是同一个元素还是新元素"的唯一依据。理解这一点就能利用它。

---

## 九、性能直觉

### - [ ] 47. 循环里不要操作 DOM — 先构建再一次性插入

```typescript
// ❌ 每次循环触发一次重排——1000 个元素 = 1000 次重排
items.forEach((item) => {
  const div = document.createElement('div')
  div.textContent = item.name
  container.appendChild(div) // 每次都触发浏览器 reflow
})

// ✅ 用 DocumentFragment 或拼接 innerHTML——只触发一次重排
const fragment = document.createDocumentFragment()
items.forEach((item) => {
  const div = document.createElement('div')
  div.textContent = item.name
  fragment.appendChild(div)
})
container.appendChild(fragment) // 只触发一次 reflow
```

**原因**：DOM 操作是前端最贵的操作之一。把 N 次变成 1 次，性能提升是数量级的。

### - [ ] 48. 找到目标后马上 `break`

```typescript
// ❌ 找到后继续循环——N 变大时浪费明显
let target: Item | undefined
for (const item of items) {
  if (item.id === targetId)
    target = item
  // 没 break，继续跑完
}

// ✅ 找到就退出
for (const item of items) {
  if (item.id === targetId) { target = item; break }
}
```

**原因**：这是最简单的性能优化。大部分场景数据量小感知不强，但在 10k+ 的数组中可能就是 10x 的差距。

### - [ ] 49. 闭包中的旧值 — `setInterval` / `useEffect` 里的状态是初始值

```typescript
// ❌ setInterval 的闭包里 count 永远是初始值 0
const [count, setCount] = useState(0)
useEffect(() => {
  const timer = setInterval(() => {
    console.log(count) // 每次打印 0，不是最新值
    setCount(count + 1) // 每次 set 成 1，不是 1→2→3
  }, 1000)
  return () => clearInterval(timer)
}, [])

// ✅ 用函数式更新获取最新值
useEffect(() => {
  const timer = setInterval(() => {
    setCount((c) => { console.log(c); return c + 1 })
  }, 1000)
  return () => clearInterval(timer)
}, [])
```

**原因**：闭包捕获的是创建时的值，不是执行时的值。这是 React/Vue 新人最容易踩的坑之一。

### - [ ] 50. 不要创建多余的中间数组

```typescript
// ❌ map 创建中间数组 → filter 再创建一遍——遍历两遍 + 分配两个数组
const activeNames = items
  .map(item => item.name) // 创建 name 数组
  .filter(name => name !== '') // 再创建过滤后数组

// ✅ 一次遍历，不创建中间数组
const activeNames = items
  .filter(item => item.name !== '')
  .map(item => item.name)
// 或者用 reduce/for 单次遍历
const activeNames: string[] = []
for (const item of items) {
  if (item.name)
    activeNames.push(item.name)
}
```

**原因**：对 100 个元素无所谓，对 10k+ 元素并且这些操作在渲染热路径上，就是可感知的性能问题。

---

## 十、VueUse 源码提炼（v11.3.0）

> 来源：`node_modules/@vueuse/`，模式被数千个生产项目验证。

### - [ ] 51. `toValue` — 让参数同时接受 Ref、值、函数

**问题场景**：composable 的参数有时是 ref，有时是静态值，有时是 getter。如果只接受一种，调用时就要手动转换。

```typescript
// ❌ 参数只接受 Ref——调用方必须 ref(x)
function useFeature(source: Ref<number>) { /* ... */ }
useFeature(ref(42)) // 调用方被迫包一层

// ✅ 内部用 toValue 统一处理三种情况
function toValue<T>(r: Ref<T> | T | (() => T)): T {
  return typeof r === 'function' ? (r as () => T)() : unref(r)
}
function useFeature(source: MaybeRefOrGetter<number>) {
  watch(() => toValue(source), (val) => { /* ... */ })
}
// 调用方自由选择
useFeature(42) // 静态值
useFeature(myRef) // ref
useFeature(() => count) // getter（懒、响应式）
```

**来源**：`@vueuse/shared/index.mjs:210`

### - [ ] 52. `useEventListener` — 目标变了自动重新绑定

**问题场景**：手动在 `onMounted` / `onUnmounted` 里 addEventListener / removeEventListener，目标 ref 变化时需要大量样板代码。

```typescript
// ❌ 手动管理，目标变化时容易忘
let cleanup: () => void
watch(targetRef, (newTarget) => {
  cleanup?.()
  newTarget?.addEventListener('click', handler)
  cleanup = () => newTarget?.removeEventListener('click', handler)
})

// ✅ VueUse 的 useEventListener：自动处理目标变化、自动清理
useEventListener(targetRef, 'click', handler)
// 内部：watch targetRef → cleanup + rebind → scope dispose → cleanup
// 返回 stop() 可以手动停止
```

**来源**：`@vueuse/core/index.mjs:190`

### - [ ] 53. `defaultWindow` — 不用 `typeof window === 'undefined'` 做 SSR 守卫

**问题场景**：每个 composable 都要重复 `if (typeof window === 'undefined') return`。

```typescript
// ❌ 每个函数写一遍 SSR 检查
function useMediaQuery(query: string) {
  if (typeof window === 'undefined')
    return ref(false)
  return window.matchMedia(query)
}

// ✅ 提前计算默认值，每个 composable 接收 fallback
const isClient = typeof window !== 'undefined'
const defaultWindow = isClient ? window : undefined

function useMediaQuery(query: string, options: { window?: Window } = {}) {
  const { window = defaultWindow } = options
  if (!window)
    return ref(false)
  return window.matchMedia(query)
}
```

**来源**：`@vueuse/core/index.mjs:179`

### - [ ] 54. `tryOnScopeDispose` — 生命周期安全的 dispose 注册

**问题场景**：composable 想在组件销毁时清理，但又希望在 effectScope 中（而非组件）也能运行。`onUnmounted` 只在组件 setup 中有效。

```typescript
// ❌ onUnmounted 在 effectScope 里抛错
function myComposable() {
  const cleanup = () => { /* ... */ }
  onUnmounted(cleanup) // ❌ getCurrentInstance() 为 null 时报错
}

// ✅ tryOnScopeDispose：有 active scope 就注册，没有就跳过
function tryOnScopeDispose(fn: () => void): boolean {
  if (getCurrentScope()) { onScopeDispose(fn); return true }
  return false
}
```

**来源**：`@vueuse/shared/index.mjs:49`

### - [ ] 55. `createSharedComposable` — 多组件共享单个实例，自动引用计数

**问题场景**：多个组件需要同一个 composable 实例（如全局鼠标位置），但如果每个组件各自创建一套 listener 就浪费了。

```typescript
// ❌ 每个组件创建独立实例 = N 个 mousemove 监听器
function useMouse() { /* 每次调用创建新的 ref 和 listener */ }

// ✅ createSharedComposable 保证只有一个实例，订阅数为 0 时自动销毁
const useSharedMouse = createSharedComposable(useMouse)
// 组件 A 调用 → 创建实例，subscribers = 1
// 组件 B 调用 → 复用实例，subscribers = 2
// 组件 A 卸载 → subscribers = 1，实例不销毁
// 组件 B 卸载 → subscribers = 0，实例销毁
```

**来源**：`@vueuse/shared/index.mjs:130`

### - [ ] 56. `watchPausable` / `watchIgnorable` — 解决"watch 写数据，数据变触发 watch"的死循环

**问题场景**：`useStorage` 中，用户修改 ref → watch 写 localStorage；localStorage 变化 → watch 又触发 → 再写 ref → 无限循环。

```typescript
// ❌ 死循环：watch 触发 write，write 又触发 watch
watch(data, val => localStorage.setItem('key', JSON.stringify(val)))

// ✅ watchPausable：写入时暂停 watch
const { pause, resume } = watchPausable(data, (val) => {
  localStorage.setItem('key', JSON.stringify(val))
})
// 当外部修改 localStorage 时：
pause() // 暂停 watcher
data.value = JSON.parse(newValue) // 更新 ref
resume() // 恢复 watcher —— 此时 ref 已更新完成，不会再触发
```

**来源**：`@vueuse/shared/index.mjs:688`

### - [ ] 57. `watchWithFilter` / `createFilterWrapper` — 用 filter 模式给 watch 加修饰符

**问题场景**：需要 `watchDebounced`、`watchThrottled`、`watchPausable` 三种变体，如果各自实现一套就是大量重复代码。

```typescript
// ❌ 三个函数重复 watch 逻辑
function watchDebounced(source, cb, ms) { /* watch + debounce 包装 */ }
function watchThrottled(source, cb, ms) { /* watch + throttle 包装 */ }
function watchPausable(source, cb) { /* watch + pause 包装 */ }

// ✅ 抽象出 filter 层，每种变体一行
function watchWithFilter(source, cb, { eventFilter }) {
  return watch(source, createFilterWrapper(eventFilter, cb))
}
function watchDebounced(source, cb, { debounce = 200 } = {}) {
  return watchWithFilter(source, cb, { eventFilter: debounceFilter(debounce) })
}
function watchThrottled(source, cb, { throttle = 200 } = {}) {
  return watchWithFilter(source, cb, { eventFilter: throttleFilter(throttle) })
}
```

**来源**：`@vueuse/shared/index.mjs:321`

### - [ ] 58. `useSupported` — mounted 后才检测浏览器 API，而非模块顶层检测

**问题场景**：`typeof window !== 'undefined'` 检测是同步的，无法区分"SSR 环境"和"浏览器还未挂载"。

```typescript
// ❌ 模块顶层判断——SSR 和未挂载都返回 false，无法区分
const isSupported = typeof window !== 'undefined' && 'MutationObserver' in window

// ✅ mounted 后才检测——SSR 始终 false，挂载后正确反映浏览器能力
function useSupported(callback: () => boolean) {
  const isMounted = useMounted()
  return computed(() => { isMounted.value; return Boolean(callback()) })
}
const isSupported = useSupported(() => window && 'MutationObserver' in window)
```

**来源**：`@vueuse/core/index.mjs:529`

### - [ ] 59. `createEventHook` — 标准化 composable 的事件发射

**问题场景**：不同 composable 用不同的方式暴露事件（回调函数、EventEmitter、vue event bus），调用方学习成本高。

```typescript
// ❌ 每个 composable 自造一套事件机制
function useA() {
  const callbacks: Array<() => void> = []
  return { onEvent: fn => callbacks.push(fn) } // 没返回 off 函数
}

// ✅ createEventHook 统一标准：on 返回 off，trigger 支持异步，自动 cleanup
const myEvent = createEventHook()
myEvent.on(fn) // 返回 { off }，且在 scope dispose 时自动 off
myEvent.trigger('data') // Promise.all 等待所有异步 handler
```

**来源**：`@vueuse/shared/index.mjs:57`

### - [ ] 60. `makeDestructurable` — 返回值同时支持数组解构和对象解构

**问题场景**：composable 返回值既要支持 `const [a, b] = useX()` 也要支持 `const { a, b } = useX()`。

```typescript
// ❌ 二选一，不能满足所有调用方的习惯
function useX() {
  return { foo: ref(1), bar: ref(2) } // 只能对象解构
}

// ✅ makeDestructurable 同时支持两种解构
function useX() {
  return makeDestructurable(
    { foo: ref(1), bar: ref(2) }, // 对象形式
    [ref(1), ref(2)] // 数组形式（定义了 Symbol.iterator）
  )
}
const { foo, bar } = useX() // ✅ 对象解构
const [foo, bar] = useX() // ✅ 数组解构
```

**来源**：`@vueuse/shared/index.mjs:189`

### - [ ] 61. `StorageSerializers` — 根据初始值类型自动选择序列化方式

**问题场景**：localStorage 只能存字符串，如果想存 boolean/number/Date/Map/Set，`JSON.stringify`/`parse` 会丢失类型信息。

```typescript
// ❌ JSON.stringify(42) → '42' → JSON.parse('42') → 42，但 bool 就变了
localStorage.setItem('enabled', JSON.stringify(true))
// 读回来：JSON.parse('true') 仍是 true，但 Date 就变成了字符串
localStorage.setItem('createdAt', JSON.stringify(new Date()))
// 读回来：'2026-06-25T00:00:00Z' ← 是 string，不是 Date

// ✅ VueUse 根据初始值类型自动选序列化器
useStorage('enabled', true) // boolean → read: v => v === 'true'
useStorage('count', 0) // number → read: Number.parseFloat
useStorage('createdAt', new Date()) // date → read: v => new Date(v)
```

**来源**：`@vueuse/core/index.mjs:1683`

### - [ ] 62. `until` — 把 watch 包装成 Promise，可以用 await 等待

**问题场景**：需要在某个 ref 满足条件后才继续执行，手动写 watch + resolve 非常啰嗦。

```typescript
// ❌ 手动写 resolve 包装
await new Promise<void>((resolve) => {
  const stop = watch(someRef, (val) => {
    if (val === 'ready') { stop(); resolve() }
  }, { immediate: true })
})

// ✅ until 一个函数搞定，还带 timeout
await until(someRef).toBe('ready')
await until(someRef).toMatch(v => v.length > 3, { timeout: 5000 })
```

**来源**：`@vueuse/shared/index.mjs:822`

### - [ ] 63. `effectScope` + `createGlobalState` — 脱离组件生命周期的响应式状态

**问题场景**：需要跨组件的全局状态，但又不想引入 Pinia。手动创建的 ref 没有生命周期管理。

```typescript
// ❌ 模块顶层 ref 永远不死
const globalState = ref(0)

// ✅ effectScope(true) 创建离脱 scope，createGlobalState 懒初始化
function createGlobalState<T>(factory: () => T) {
  let state: T | undefined
  const scope = effectScope(true) // detached = true，不绑定任何组件
  return () => {
    if (!state)
      state = scope.run(() => factory())! // 第一次调用才创建
    return state
  }
}
const useGlobalCount = createGlobalState(() => useCounter())
```

**来源**：`@vueuse/shared/index.mjs:80`

---

## 十一、Pinia 源码提炼（v2.x）

> 来源：Vue 生态最广泛使用的状态管理库。

### - [ ] 64. Setup Store — 在 store 内部组合其他 store

**问题场景**：传统 Options Store 中，store A 想用 store B 的数据，只能在 action 中调用 `useBStore()`，不能在 state/getters 中引用。

```typescript
// ❌ Options Store：getters 中不能直接调用其他 store
defineStore('cart', {
  state: () => ({ items: [] }),
  getters: {
    // 想根据 user store 的 VIP 等级打折——做不到纯声明
  }
})

// ✅ Setup Store：跟组件的 setup() 一样，可以组合任意 store
defineStore('cart', () => {
  const userStore = useUserStore()
  const items = ref<CartItem[]>([])

  const totalPrice = computed(() =>
    items.value.reduce((sum, i) => sum + i.price * (userStore.isVip ? 0.9 : 1), 0)
  )
  return { items, totalPrice }
})
```

**来源**：`pinia/src/store.ts`

### - [ ] 65. 插件延迟注册 — 无论注册时机都能正确安装

**问题场景**：`pinia.use(plugin)` 在 `app.use(pinia)` 之前调用 vs 之后调用，行为不同。

```typescript
// Pinia 的实现：能处理两种时机
function createPinia() {
  const _p: PiniaPlugin[] = []
  let toBeInstalled: PiniaPlugin[] = [] // install 之前暂存

  return {
    install(app) {
      toBeInstalled.forEach(p => _p.push(p)) // flush 暂存
      toBeInstalled = []
    },
    use(plugin) {
      if (!this._a)
        toBeInstalled.push(plugin) // 未安装 → 暂存
      else _p.push(plugin) // 已安装 → 直接装
    }
  }
}
```

**来源**：`pinia/src/createPinia.ts`

### - [ ] 66. Set 存储订阅回调 — 天然去重

**问题场景**：用数组存储回调 → 同一个函数可能被注册两次 → 一次事件触发两回。

```typescript
// ❌ 用数组——同一个回调重复注册
const subs: Array<() => void> = []
subs.push(cb1); subs.push(cb1) // cb1 被注册两次
subs.forEach(fn => fn()) // cb1 执行两次

// ✅ 用 Set——天然去重，且 delete 是 O(1)
const subs = new Set<() => void>()
subs.add(cb1); subs.add(cb1) // Set 自动去重，cb1 只存一份
subs.forEach(fn => fn()) // cb1 只执行一次
```

**来源**：`pinia/src/subscriptions.ts`

### - [ ] 67. TS `as` 子句做类型级过滤 — 从 Setup Store 返回值分离 state/getters/actions

**问题场景**：Setup Store 返回值混在一起，如何在类型层面区分哪些是 state、哪些是 getter、哪些是 action？

```typescript
// Pinia 的做法——纯类型操作，零运行时开销
type _ExtractStateFromSetupStore_Keys<SS> = keyof {
  [K in keyof SS as SS[K] extends _Method | ComputedRef ? never : K]: any
}
// 动作 = 是函数的键
type _ExtractActionsFromSetupStore_Keys<SS> = keyof {
  [K in keyof SS as SS[K] extends _Method ? K : never]: any
}
// 获取器 = 是 ComputedRef 的键
type _ExtractGettersFromSetupStore_Keys<SS> = keyof {
  [K in keyof SS as SS[K] extends ComputedRef ? K : never]: any
}
// 然后 Pick 这三组键，缝合为 Store 类型
type Store<SS> = Pick<SS, StateKeys> & Pick<SS, GetterKeys> & Pick<SS, ActionKeys>
```

**来源**：`pinia/src/types.ts`

### - [ ] 68. Symbol 标记防止函数被重复包装

**问题场景**：HMR 或多次调用时，action 包装函数可能被外层逻辑再次包装，导致嵌套。

```typescript
// ❌ 无标记——每次都包，HMR 后包了 3 层
function wrapAction(fn) {
  return function wrapped(...args) { /* 包装逻辑 */ }
}
// HMR 后：wrapAction(wrapAction(wrapAction(original))) = 3 层嵌套

// ✅ Symbol 标记——如果是已包装的，跳过
const ACTION_MARKER = Symbol()
function wrapAction(fn) {
  if (ACTION_MARKER in fn)
    return fn // 已经包过，跳过
  const wrapped = function (...args) { /* 包装逻辑 */ }
  wrapped[ACTION_MARKER] = true
  return wrapped
}
```

**来源**：`pinia/src/store.ts`

### - [ ] 69. `$patch` 期间的订阅暂停

**问题场景**：批量 patch 多个字段时，每个字段更新都触发 `$subscribe` 回调，订阅方反复重渲染。

```typescript
// ❌ 逐个更新——每个字段触发一次 watch
store.state.a = 1 // 触发订阅 → 渲染
store.state.b = 2 // 触发订阅 → 渲染
store.state.c = 3 // 触发订阅 → 渲染

// ✅ $patch 批量更新——只在最后触发一次
store.$patch({ a: 1, b: 2, c: 3 })
// 内部：isListening = false（暂停订阅）
// → 执行合并更新
// → nextTick().then(() => isListening = true)（恢复）
// → 触发一次订阅
```

**来源**：`pinia/src/store.ts`

---

## 十二、Vite 源码提炼（v6.x）

> 来源：新一代构建工具，插件系统和模块管理被广泛参考。

### - [ ] 70. 三桶插件排序 — `enforce` 字段而非优先级数字

**问题场景**：用户插件和框架内部插件的执行顺序需要精确控制，优先级数字难以管理和排序。

```typescript
// ❌ 用优先级数字——两个插件的 priority 都是 100，谁先？
{ name: 'plugin-a', priority: 100 }

// ✅ Vite 三桶策略：只用 pre / 不填 / post
// pre 桶 → 框架内部插件群 → 默认桶 → 框架内部插件群 → post 桶
function sortUserPlugins(plugins: Plugin[]) {
  const prePlugins: Plugin[] = []
  const postPlugins: Plugin[] = []
  const normalPlugins: Plugin[] = []
  for (const p of plugins) {
    if (p.enforce === 'pre') prePlugins.push(p)
    else if (p.enforce === 'post') postPlugins.push(p)
    else normalPlugins.push(p)
  }
  return [prePlugins, normalPlugins, postPlugins]
}
// 最终拼装：[frameworkPre, ...prePlugins, framework, ...normal, frameworkPost, ...post]
```

**来源**：`vite/src/node/config.ts`

### - [ ] 71. 中间件管道 + 双注入点 — 明确的插入位置，而非数字优先级

**问题场景**：中间件需要知道在哪里插入，传统做法是给一个"优先级数字"然后在排序时插入。

```typescript
// ❌ 模糊的注入方式
server.use(middleware, { priority: 5 }) // 5 是什么意思？

// ✅ Vite：两个确定的注入点——configureServer 钩子内调用 .use()（前），返回函数（后）
function configureServer(server) {
  server.middlewares.use(myMiddleware) // 在核心 transform 之前
  // 内置中间件（transform、static）
  return () => {
    server.middlewares.use(myPostMiddleware) // 在核心 transform 之后
  }
}
// 最终顺序一目了然：myMiddleware → transform → static → myPostMiddleware
```

**来源**：`vite/src/node/server/index.ts`

### - [ ] 72. 软/硬模块失效 — 区分"需要完全重建"和"只需更新时间戳"

**问题场景**：一个文件改了，所有 import 它的文件都需要重新 transform 吗？大多数情况不需要。

```typescript
// ❌ 全盘硬失效——改一个 CSS 导致整个依赖链全部重新 transform
invalidateModule(mod) // 所有 importer → 硬失效 → 重建

// ✅ Vite 的三态模型：有效 → 软失效（更新时间戳）→ 硬失效（完全重建）
// 场景：main.ts 静态导入了 utils.ts，utils.ts 被修改
// → utils.ts：硬失效（自己是修改源）
// → main.ts：软失效（只更新 import 时间戳，不需要重新 transform 整个文件）
if (importer.staticImportedUrls?.has(mod.url)) {
  importer.invalidationState = prevResult // 软失效
}
```

**来源**：`vite/src/node/server/moduleGraph.ts`

### - [ ] 73. 默认并行钩子 + `sequential` 标记 — 一个执行引擎覆盖两种语义

**问题场景**：有些 hook 需要按插件顺序串行执行（如 resolveId），有些可以并行（如 buildStart）。维护两套执行引擎太复杂。

```typescript
// ✅ Vite 的做法：一个引擎，hook 声明 sequential 就串行
async function hookParallel(hookName, args) {
  const parallelPromises: Promise<void>[] = []
  for (const plugin of sortedPlugins) {
    const handler = plugin[hookName]
    if ((hook as any).sequential) {
      await Promise.all(parallelPromises) // 排空前面的异步
      parallelPromises.length = 0
    }
    parallelPromises.push(handler.apply(ctx, args))
  }
  await Promise.all(parallelPromises)
}
// parallel hooks: 所有插件同时 fire
// sequential hooks + sequential: true → 插件按顺序执行
```

**来源**：`vite/src/node/server/pluginContainer.ts`

### - [ ] 74. 双模式错误中间件 — 同一个工厂产出"记录"和"阻断"两种模式

**问题场景**：有的错误需要阻断请求并返回错误页面，有的只需要记录日志然后继续。

```typescript
// ✅ 一个 factory 函数通过参数控制行为
function errorMiddleware(server, allowNext?: boolean) {
  return (err, req, res, next) => {
    logError(server, err)
    server.environments.client.hot.send({ type: 'error', ...err })
    if (allowNext)
      return next() // 模式 1：记录并放行
    res.statusCode = 500; res.end(renderErrorPage(err)) // 模式 2：终止请求
  }
}
```

**来源**：`vite/src/node/server/middlewares/error.ts`

### - [ ] 75. WebSocket 重连探测 + 错误缓冲 — 不丢失连接事件之间的错误

**问题场景**：HMR WebSocket 断开期间发生的编译错误，用户重连后就看不到了。

```typescript
// ✅ 三步策略
// 1. 重连前发 vite-ping 探测——验证服务端存活
// 2. 存活后再建完整 HMR 连接——避免双重连接
// 3. 连接断开期间的错误缓存起来——新客户端连上时补发
const bufferedErrorPayloads: ErrorPayload[] = []
function send(payload) {
  if (wss.clients.size === 0) {
    bufferedErrorPayloads.push(payload) // 没有客户端 → 缓存
  }
  else {
    wss.clients.forEach(c => c.send(JSON.stringify(payload)))
  }
}
// 新客户端连接时：发送所有缓存的错误
```

**来源**：`vite/src/node/server/ws.ts`

---

## 十三、Element Plus 源码提炼（v2.14.1）

> 来源：项目已使用的 UI 库，可直接参考其模式。

### - [ ] 76. `useNamespace` — 统一 BEM 类名 + CSS 变量

**问题场景**：每个组件手写 `el-button__wrapper`、`el-button--primary`，拼错一个就会样式失效，且 CSS 变量命名不一致。

```typescript
// ❌ 手写 BEM 字符串，拼错概率高
const ns = 'el-button'
const classes = `${ns}__wrapper ${ns}--${type}` // 容易漏连字符

// ✅ useNamespace 通过方法调用生成，永不拼错
const ns = useNamespace('button')
ns.b() // 'el-button'
ns.e('wrapper') // 'el-button__wrapper'
ns.m('primary') // 'el-button--primary'
ns.is('disabled') // 'is-disabled'
ns.cssVarBlock({ bgColor: '#409EFF' }) // { '--el-button-bg-color': '#409EFF' }
// 命名空间可通过 ConfigProvider 改为 'my-app'，所有组件自动适配
```

**来源**：`hooks/use-namespace/index.mjs`

### - [ ] 77. 表单 provide/inject 链 — 多级优先级自动回溯

**问题场景**：`el-input` 的 size 可能来自：自己的 prop → el-form-item → el-form → ConfigProvider。每个组件自己写这个回溯逻辑会大量重复。

```typescript
// ❌ 每个组件都自己回溯
const size = computed(() =>
  props.size || formItem?.size || form?.size || globalConfig?.size || ''
)

// ✅ 抽象为一个 composable
function useFormSize(fallback?) {
  const form = inject(formContextKey, undefined)
  const formItem = inject(formItemContextKey, undefined)
  const globalConfig = useGlobalSize()
  return computed(() =>
    props.size || fallback || formItem?.size || form?.size || globalConfig.value || ''
  )
}
// el-input 只需：const size = useFormSize()
```

**来源**：`form/src/hooks/use-form-common-props.mjs`

### - [ ] 78. `buildProps` — 封装 Vue props 定义，加运行时枚举值校验

**问题场景**：Vue 的 props 验证只报"Invalid prop"，不告诉调用方这个 prop 的可选值有哪些。

```typescript
// ❌ 标准 Vue props——验证失败只报 Invalid prop
props: { type: { type: String, validator: v => ['primary', 'success'].includes(v) } }

// ✅ Element Plus 的 buildProps——开发环境报错时列出所有可选值
const buttonProps = buildProps({
  type: { type: String, values: ['primary', 'success', 'warning', 'info', 'danger'], default: '' }
})
// 控制台输出：Invalid prop: type. Expected one of [primary, success, warning, info, danger]
```

**来源**：`utils/vue/props/runtime.mjs`

### - [ ] 79. Symbol 做 provide/inject key — ButtonGroup 不污染 CheckboxGroup

**问题场景**：用字符串做 provide key，不同容器可能撞名。

```typescript
// ❌ 字符串 key——两个不同的 group 可能撞名
provide('group', { size: 'large' })

// ✅ Symbol key——保证全局唯一
const buttonGroupContextKey = Symbol('buttonGroupContextKey')
const checkboxGroupContextKey = Symbol('checkboxGroupContextKey')
// 两个 key 永远不会冲突
provide(buttonGroupContextKey, { size: 'large' })
```

**来源**：`checkbox/src/composables/use-checkbox-disabled.mjs`

### - [ ] 80. `useModelToggle` — 20+ 组件共享的 v-model 显示/隐藏逻辑

**问题场景**：Dialog、Drawer、Popover、Tooltip、Dropdown 等都需要：`modelValue` prop + `update:modelValue` emit + 内部状态 + show/hide/toggle 方法。各自实现一份 = 20 份重复代码。

```typescript
// ❌ 每个组件重复这套模板
const props = defineProps({ modelValue: Boolean })
const emit = defineEmits(['update:modelValue'])
const show = () => emit('update:modelValue', true)
const hide = () => emit('update:modelValue', false)
// 还要处理"用户没传 v-model"的情况

// ✅ createModelToggleComposable 把这一切封装起来
const { useModelToggle, useModelToggleProps } = createModelToggleComposable('modelValue')
// 组件只需：
const { show, hide, toggle } = useModelToggle({ /* 配置 */ })
// 正确处理 default: null（未绑定）和 default: false（显式关闭）的区别
```

**来源**：`hooks/use-model-toggle/index.mjs`

### - [ ] 81. `inheritAttrs: false` + `useAttrs` — 精确控制 attrs 落到哪个元素

**问题场景**：用户传了 `placeholder` 和 `class` 给 ElInput，期望 placeholder 到内部的 `<input>`，class 到外层的 `<div>`——但 Vue 默认把所有 attrs 都落到根元素。

```typescript
// ❌ 用户传的 placeholder 落到了外层 div，对 input 无效
// ❌ 同时 class 也丢了

// ✅ inheritAttrs: false → 手动分派
const rawAttrs = useAttrs() // class、style、事件
const containerAttrs = useAttrs({ excludeListeners: true }) // 只含 placeholder、aria-* 等

// 模板：class/style 走外层 div，placeholder 走内部 input
// <div class="..." style="...">
//   <input v-bind="containerAttrs" />
// </div>
```

**来源**：`hooks/use-attrs/index.mjs`

### - [ ] 82. VNode 工具集 — `flattedChildren`、`renderIf`、`getFirstValidNode`

**问题场景**：Vue 的插槽内容可能是 Fragment、注释节点、文本节点、组件。直接操作子节点很麻烦。

```typescript
// ❌ 直接拿 children——可能是 Fragment，不能直接操作
const children = slots.default?.()

// ✅ Element Plus 的工具集
flattedChildren(children) // 递归展开 Fragment，返回平列表
getFirstValidNode(children) // 跳过 Comment/Text 找到第一个可视元素
renderIf(condition, ...nodes) // 代替 <template v-if>，返回 VNode 或 Comment
```

**来源**：`utils/vue/vnode.mjs`

### - [ ] 83. 运行时 CSS 变量颜色 — 不用编译新 CSS，用 JS 计算 + 内联 style

**问题场景**：用户传入 `color="#FF5733"` 给按钮，需要生成这个颜色的 hover/active/disabled 变体。传统方案是编译新的 CSS 或使用 color-mix()（有兼容性问题）。

```typescript
// ✅ 用 tinycolor 在 JS 中计算所有变体，设成 CSS 变量
function useButtonCustomStyle(props) {
  return computed(() => {
    if (!props.color)
      return {}
    const color = new TinyColor(props.color)
    return {
      '--el-button-bg-color': props.color,
      '--el-button-hover-bg-color': color.tint(30).toString(),
      '--el-button-active-bg-color': color.mix('#141414', 20).toString(),
      // ... 更多变体
    }
  })
}
// <button :style="customStyle"> — CSS 中通过 var(--el-button-bg-color) 引用
```

**来源**：`button/src/button-custom.mjs`

### - [ ] 84. `useFocusController` — 焦点行为抽象

**问题场景**：ElInput、ElSelect、ElCheckbox 都需要处理焦点事件，但各自实现会导致行为不一致（如内部元素之间切换焦点是否视为 blur）。

```typescript
// ✅ 统一的焦点控制器
function useFocusController(target, { afterBlur, afterFocus }) {
  const isFocused = ref(false)
  const handleFocus = (event: FocusEvent) => {
    if (isFocused.value)
      return
    isFocused.value = true
    afterFocus?.()
  }
  const handleBlur = (event: FocusEvent) => {
    // 关键：焦点在 wrapper 内部的元素之间跳转，不视为 blur
    if (event.relatedTarget && wrapperRef.value?.contains(event.relatedTarget))
      return
    isFocused.value = false
    afterBlur?.()
  }
  // useEventListener 绑定事件
  return { isFocused, wrapperRef }
}
// 使用时：
const { isFocused, wrapperRef } = useFocusController(inputRef, {
  afterBlur: () => elFormItem?.validate?.('blur')
})
```

**来源**：`hooks/use-focus-controller/index.mjs`

### - [ ] 85. ConfigProvider 嵌套合并 — 只覆盖部分字段，保留其余

**问题场景**：外层 ConfigProvider 设置了 `locale` 和 `namespace`，内层只想改 `size`。如果完全替换就丢了外层的 `locale` 和 `namespace`。

```typescript
// ❌ 完全替换——内层丢了外层的配置
provide(configKey, newConfig)

// ✅ merge——内层只覆盖显式传入的字段
function provideGlobalConfig(config, app) {
  const oldConfig = inject(configKey, undefined) // 读取外层配置
  const mergedConfig = computed(() =>
    oldConfig ? merge(oldConfig.value, unref(config)) // merge，不替换
      : unref(config)
  )
  provide(configKey, mergedConfig)
}
// 外层：{ locale, namespace, size: 'default' }
// 内层只传 { size: 'small' }
// 结果：{ locale, namespace, size: 'small' } ← 正确
```

**来源**：`config-provider/src/hooks/use-global-config.mjs`
