// Node 侧解析 `@/...` → web/src/...。
//
// 为什么需要：web/tests 与 mock/tests 直接用 `node --test` 跑，不经 Vite；
// 而 `@/` 既不是 `./` 相对路径、也不是裸包名，Node 自己认不出来。
// Vite 侧的同一别名配在 vite.config.js —— 两处必须一致。
import { fileURLToPath } from 'node:url';

const SRC = new URL('../src/', import.meta.url);

export function resolve(specifier, context, next) {
  if (specifier === '@' || specifier.startsWith('@/')) {
    const target = new URL('.' + specifier.slice(1), SRC);
    return next(fileURLToPath(target), context);
  }
  return next(specifier, context);
}
