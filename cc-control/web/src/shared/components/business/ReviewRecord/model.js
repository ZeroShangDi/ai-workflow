export const reviewResultMessage = result =>
  result.proposal?.status === 'conflicted' ? '审批已记录，但变更冲突，未应用。' : '操作已提交';

export const optionLabel = option => typeof option === 'string' ? option : option?.label || '';

const legacyOptionDescriptions = {
  '框架无关的主题引擎': '提供可供不同 UI 框架使用的主题 token、算法和序列化能力，不绑定某个组件库。',
  '面向自有组件库的主题方案': '围绕自有组件库定义 token、算法和运行时接入方式，参考 Ant Design 的主题能力。',
  '纯 Design Tokens 规范包': '只发布 token 和命名规范，由各应用自行负责主题派生、注入和切换。',
  'Antd 主题定制层': '基于 Ant Design 现有主题 API 扩展品牌配置，复用它的 token 和组件体系。',
  '四级:seed→map→alias→component(推荐)': '依次区分基础值、算法派生值、语义别名和组件覆盖；修改基础值后可联动整套主题。',
  '三级:seed→map→component': '保留基础值、派生值和组件覆盖，省略语义别名层，结构更简单。',
  '五级:brand→seed→map→alias→component': '增加品牌层以复用多套品牌配置，同时需要明确各层的覆盖顺序。',
  'CSS 变量 + 作用域注入(推荐)': '把 token 写入指定 DOM 作用域，支持局部主题、运行时切换和普通 CSS 消费。',
  'CSS-in-JS 运行时生成': '在运行时生成并管理样式，配置灵活，但需要处理运行时开销和服务端样式。',
  '编译期产出静态 CSS': '在构建时生成静态样式，运行时更轻，但动态切换和局部覆盖能力较少。',
  '混合:CSS 变量 + 可导出静态 CSS': '运行时使用 CSS 变量，也可导出静态 CSS，兼顾动态切换和非 React 场景。',
  'pnpm monorepo 多包(推荐)': '将核心引擎、框架适配和组件集成拆成独立包，便于分别发布和维护。',
  '单包 + subpath exports': '在一个包内按子路径导出不同入口，发布简单，但模块边界由同一版本管理。',
  '双包:core + react': '将框架无关的核心逻辑与 React 接入拆开，控制包依赖和职责范围。',
};

export const optionDescription = option => {
  if (typeof option === 'object' && option) {
    return option.description || legacyOptionDescriptions[optionLabel(option)] || '';
  }
  return legacyOptionDescriptions[option] || '';
};
