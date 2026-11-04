# 轻影 LightVideo · 搭手插件

**FFmpeg 视频工具箱**：压缩、转格式、合并、剪辑、变速、加水印、烧录字幕、转 GIF、截图——
把最常用的视频处理做成一个点开就能用的插件，输出永不覆盖原文件。

这是 [yzfly/lightvideo](https://github.com/yzfly/lightvideo) 桌面版的搭手（da-shou）插件移植版：
界面与工具参数原样保留，外壳从 Tauri 换成搭手插件（core + 窗口），编码交给宿主的 ffmpeg 能力。

## 安装

```bash
pnpm install
pnpm plugin:build
```

产物：`dashou-dist/com.dashou.lightvideo-1.0.0.dsp`。
在搭手「插件管理 → 安装插件」选择它，或直接双击；也可以「开发者工具 → 添加项目」选 `src-dashou` 调试。

## 十七个工具

| 分组 | 工具 |
|------|------|
| **视频** | 视频压缩（CRF 肉眼无损）· 压缩到指定大小（两遍编码）· 格式转换（换容器 / 重编码）· 视频合并（同参数无损拼接）· 视频剪辑（无损快剪 / 帧级精准）· 视频变速（0.5×–3×，音调不变）· 视频倒放 |
| **画面** | 旋转翻转 · 画面裁剪（比例居中裁剪）· 横竖屏适配（模糊背景铺满）· 加水印（位置 / 大小 / 透明度） |
| **音频** | 提取音频（MP3/M4A/WAV/FLAC）· 音量调整 / 移除音轨 · 配背景音乐（混音 / 循环 / 淡出） |
| **字幕** | 烧录字幕（SRT / ASS / SSA / VTT，中文字体自动适配） |
| **图像** | 视频转 GIF（调色板两阶段）· 视频截图 |

通用能力：全局串行队列 · 实时进度（百分比 / 速度 / 剩余时间）· 单帧效果预览（水印 / 裁剪 / 横竖屏 / 字幕）·
输出与原文件同目录且自动避让重名。

## 文件入口

- 点击主区空状态或「添加」，系统文件选择框多选视频；
- 在搭手搜索条里选中视频文件后执行「用轻影处理这些视频」，文件会直接进入当前工具的队列。

> 宿主插件窗口是沙箱页面，暂不提供拖拽文件的落盘路径，所以没有做「拖进来就能用」的拖拽区。

## 与桌面版的差异

- **FFmpeg 不再随包内置**：首次添加文件 / 打开窗口时由搭手下载静态 FFmpeg 运行时（约 45MB，带进度窗口），之后复用。
  宿主提供的是完整构建（libx264 / libx265 / libvpx / libopus / libmp3lame / libass），压缩、字幕烧录等全部可用。
- **没有 ffprobe**：时长 / 分辨率 / 编码直接从 `ffmpeg -i` 的 stderr 解析。
- **AI 自动字幕 / 录音转文字暂未移植**：需要 core 侧下载 sherpa-onnx 运行时（约 218MB）与 SenseVoice 模型（约 230MB），留待后续版本。

## 工程结构

```text
src/                 Vue 3 界面（工具注册表 src/tools.ts、ffmpeg 桥 src/ffmpeg.ts）
src-dashou/
  plugin.json        插件清单：窗口、命令、能力
  index.ts           后台 core：文件选择、输出路径、临时文件、concat 列表、读预览图、定位文件
  assets/icon.png
src/dev/mock.ts      仅开发期：普通浏览器里模拟宿主桥，方便调 UI
docs/screenshots/    界面截图
```

- 窗口只做 UI；所有文件系统操作收在 core（core 的 Node 不受能力 scope 限制，用户选中的路径能直接读写）。
- ffmpeg 走宿主 `ffmpeg:default` 能力：`plugin:ffmpeg|run` 启动，`ffmpeg:progress` / `ffmpeg:log` / `ffmpeg:exit` 事件回传进度与退出码。

## 开发

```bash
pnpm dev          # 浏览器预览（带 mock）：http://localhost:5175
pnpm typecheck    # vue-tsc -b
pnpm build        # typecheck + vite build
```

真实宿主调试：开发者工具添加 `src-dashou` →「开发」，页面来自 `build.devUrl`；改 `core.mjs` / `plugin.json` 后点「重新加载」。
窗口内 F12 打开开发者工具（仅开发版）。

## 许可

MIT。原项目：[yzfly/lightvideo](https://github.com/yzfly/lightvideo)（作者 云中江树）。
内置 FFmpeg 由搭手宿主统一提供，FFmpeg 是 FFmpeg 项目的商标。
