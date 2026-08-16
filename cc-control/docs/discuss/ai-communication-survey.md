# 智能沟通开源方案调研（2026）

> 2026-08-16 · 调研四类分化场景（客服 / 陪伴 / 个人智能助手 / 养成游戏）的高 star 开源方案，用于横向对照与能力借鉴。星数为公开报道值，部分来自 SEO/AI 生成文章，个别数据有出入，仅作量级参考，非精确值。

## 1. 客服（Customer Service）

| 项目 | 星数 | 定位与差异点 |
|------|------|------|
| Rasa | ~21k | 最成熟的对话式客服框架，文本+语音；开源版转维护模式，活跃开发移入 Rasa Pro |
| Parlant | ~18k | 专为「面向客户的 Agent」设计，行为可控、语气合规，Apache-2.0 |
| LiveKit Agents | ~12k | 实时语音 Agent 框架，多模态，适合电话/语音客服 |
| FastGPT | ~27k+ | 知识库优先的 RAG+Agent，轻量（2 核 4G 可跑），私有化/合规友好，适合 FAQ 客服 |
| Dify | ~100k+ | 全栈 LLMOps 平台，可视化工作流，复杂多步 Agent，企业级（部署较重） |
| RAGFlow | ~75k | 文档解析最强（复杂 PDF/表格），RAG 精度场景首选 |

## 2. 陪伴（Companionship）

| 项目 | 星数 | 定位与差异点 |
|------|------|------|
| AIRI | ~22k–30k | 开源「AI 伴侣/VTuber」，Neuro-sama 重实现；实时语音+聊天，可陪玩 Minecraft/Factorio，VRM/Live2D，30+ LLM，本地自托管 |
| SillyTavern | ~30k–31k | 角色扮演前端事实标准，角色卡+世界书+群聊+视觉小说模式，接任意后端 |
| Open-LLM-VTuber | ~8k | 可完全离线，Live2D 表情映射，桌面宠物模式，支持本地模型 |
| Soul of Waifu / Meuxe / LingChat | 中小 | 桌宠+视觉化陪伴，Live2D/VRM，关系状态、情绪识别、多角色剧情 |

## 3. 个人智能助手（Personal AI Assistant）

| 项目 | 星数 | 定位与差异点 |
|------|------|------|
| OpenHuman | ~31k–36k | 本地优先桌面 Agent，人类可读「记忆树」存 Markdown（可 Obsidian 查看），118+ OAuth 集成，TokenJuice 压缩降本 |
| Hermes Agent | ~47k | Nous Research 出品，自改进、跨会话记忆、技能自动生成、多端消息 |
| OpenClaw / Clawdbot (Moltbot) | 高（数值争议大） | 消息平台型个人助手，WhatsApp/Telegram/Slack 多通道 |
| OpenWorker（吴恩达） | ~3.7k | 桌面 Agent，基于 aisuite |
| MiroFish | ~29k | 多智能体模拟沙盒，偏「上帝视角预测」而非单人体 |

## 4. 养成游戏（Nurture / Raising Games）

| 项目 | 星数 | 定位与差异点 |
|------|------|------|
| OpenHer | 中 | 人格从「神经驱动力」涌现而非 prompt 堆砌，情绪热力学、主动发消息、长期记忆 |
| Hearth（一隅） | 中 | 五层生命体征（血糖/精力/压力/多巴胺/情绪），三层记忆，5 级亲密度，关系树可视化 |
| CyberPersona（赛博女友） | 中 | 大五人格，五维关系追踪（信任/安全感/亲密/依恋/占有），18 成就+好感度 0-1000 |
| minecraft-ai-companion | 中 | 情感温度引擎（0-100），持久记忆、自我认知演化、欲望层自主行为 |
| MuseAI / dsh-rp-distribution | 中小 | 角色卡+世界书+羁绊档案，文字冒险/穿书，SillyTavern 卡兼容 |

## 5. 四场景共性设计

跨场景看，高星项目核心竞争点收敛到同一组能力：

1. **记忆架构分层** — 短期上下文 / 长期记忆 / 关系档案三层是标配（Hearth、Soul of Waifu、OpenHuman 均显式分层）。OpenHuman 用「本地 Markdown 记忆树」可读可编辑，是可迁移的亮点。
2. **状态持久化 + 演化** — 陪伴/养成类普遍维护一套「生命体征/情绪/关系」状态机，状态随交互**衰减或演化**，非静态档案（Hearth、CyberPersona、minecraft-ai-companion）。
3. **人格建模** — 从「prompt 人设」转向「驱动力/数值驱动」涌现（OpenHer 的 neural drives、CyberPersona 的大五人格）。
4. **主动触达** — 陪伴类普遍有「主动发消息」而非纯被动问答（Hearth、OpenHer）。
5. **可观测/可视化** — 关系树、记忆树、状态面板，让 AI 内部状态对用户透明。

## 6. 对 ai-workflow 的参考

这些共性落在 ai-workflow 的记忆 + 状态 + 工作流三块里，可作为 `awf-state` 数据结构的演进参照：

| 外部共性 | 可能落点 |
|---------|---------|
| 记忆分层（短期/长期/关系档案） | state.json 记忆字段结构化，而非单一 blob |
| 状态演化（衰减/驱动） | awf-state 增加「状态随时间演化」的语义 |
| 人格建模（驱动力/数值） | 若未来做陪伴/养成方向，可扩展 state 模型 |
| 主动触达 | 现有 `awf_await_*` 是「被动等用户」，主动触达是反向能力 |
| 可观测性 | 记忆/状态可视化面板，对标「记忆树」「关系树」 |

## 7. 数据来源与时效说明

- 调研时间：2026-08-16，来源为公开 Web 搜索。
- 星数在不同来源间有出入（如 OpenClaw、MiroFish 的数值争议大），引用前需回 GitHub 核实当前值。
- 项目仓库地址见下，用于后续回查：

  - AIRI: github.com/moeru-ai/airi
  - SillyTavern: github.com/SillyTavern/SillyTavern
  - OpenHuman: github.com/tinyhumansai/openhuman
  - OpenHer: github.com/kellyvv/OpenHer
  - Hearth: github.com/mufengyuan666/Hearth
  - CyberPersona: github.com/harrylarryxyz/CyberPersona
  - minecraft-ai-companion: github.com/Zhu070124/minecraft-ai-companion
  - Parlant: github.com/emcie-co/parlant
  - Rasa: github.com/RasaHQ/rasa
  - LiveKit Agents: github.com/livekit/agents
  - FastGPT: github.com/labring/FastGPT
  - Dify: github.com/langgenius/dify
  - RAGFlow: github.com/infiniflow/ragflow
