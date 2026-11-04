# DS 鲸鱼娘素材来源

原作者与项目：https://github.com/PC2005-cloud/dsh-pet
固定版本：ad991f55c8ad6e7c01d4cf19b285934d0f274636（2026-10-17 获取）

原项目 README「许可」原文：

- 代码：MIT
- 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**
- 二次创作（二创）约定：基于本项目的衍生 / 改版 / 换皮作品，在任何介绍、展示、分发该作品的地方，须附上原作者 GitHub 地址：https://github.com/PC2005-cloud/dsh-pet

用户已确认当前仅在本地自己使用，后续选择自行生成或联系原作者授权。当前素材只用于本地审阅，商业分发须先获得授权，不能将 MIT 代码许可证理解为动画的商用授权。原始 README 和 LICENSE 随本目录保留。

`clips.json` 记录原项目完整 106 段 WebM 动画，分类与原动作名称保留，包含「时节 → 舞狮头」。所有源文件均固定在上述上游版本，完整目录在 `upstream-tree.json`。

执行 `python3 scripts/convert-dsh-video.py` 可从本目录重建视频与配置，需要 imageio-ffmpeg。转换显式使用 libvpx-vp9 解码透明通道，将 RGB 与灰度 alpha 并排打包为 H.264 MP4，保留原视频帧率和时长，完整保留原画面，仅上下补透明边以统一方形画布。`scripts/measure-dsh-video-bounds.py` 统计完整动作的透明边界并更新目录，播放器按 bounds 收紧显示，保留道具和统一角色比例；不需要重新编码视频。播放器以 WebGL 合成透明输出，不依赖 WebM alpha 解码。

手机端只包含 MP4、播放器及署名；不打包源 WebM、PNG 图集或备份。当前全部视频约 105 MiB，按需播放，不预解码整套动画。随机播放沿用原配置的分类权重；点击回应、拖拽、工作状态、余额等事件动画可在菜单中手动点播，当前没有照搬 DSH 的业务事件。

原精灵图集和配置保存在 ../archive/elf-v3；先前 25 动作的 PNG 方案保存在 ../archive/dsh-png，仅供回看。新播放协议 API v2，旧基座需要重新原生编译。

验证：`node scripts/verify-pet-video.cjs` 使用 Playwright 验证真实视频解码、透明像素、播放结束和快速切换；可通过 PET_TEST_BROWSER 指定本机 Chromium/Chrome 路径。最终透明悬浮窗、后台播放、菜单与拖动仍需 Android 真机验收。
