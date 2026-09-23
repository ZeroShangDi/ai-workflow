// 注册 `@/` 别名解析钩子。用法：
//   node --import ./scripts/alias-loader.mjs --test tests/*.test.mjs ...
// 钩子实现见 ./alias-resolve.mjs。
import { register } from 'node:module';

register(new URL('./alias-resolve.mjs', import.meta.url));
