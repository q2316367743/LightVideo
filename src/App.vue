<script setup lang="ts">
import { listen, type UnlistenFn } from '@dashou/api'
import type { CommandPayload } from '@dashou/core'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  AUDIO_EXTS,
  VIDEO_EXTS,
  checkFFmpeg,
  hasExt,
  messageOf,
  outputPath,
  pickFile as pickAssetPath,
  pickMedia,
  probe,
  readImage,
  removeFile,
  revealFile,
  runFFmpeg,
  tempPath,
} from './backend'
import { ICONS } from './icons'
import { TOOL_GROUPS, TOOLS } from './tools'
import type { MediaInfo, QueueItem, Settings, Tool, ToolField } from './types'

// ---------- 工具与设置 ----------
const currentId = ref('compress')
const tool = computed<Tool>(() => TOOLS.find((item) => item.id === currentId.value) ?? TOOLS[0])

// 每个工具各自记忆自己的参数
const allSettings = reactive<Record<string, Settings>>(
  Object.fromEntries(TOOLS.map((item) => [item.id, { ...item.defaults }]))
)
const settings = computed<Settings>(() => allSettings[currentId.value] ?? {})
const visibleFields = computed(() =>
  tool.value.fields.filter((field) => !field.showIf || field.showIf(settings.value))
)

// 工具声明自己收什么文件: 默认视频; 'media' = 音频+视频
const acceptExts = computed(() =>
  tool.value.accept === 'media' ? [...AUDIO_EXTS, ...VIDEO_EXTS] : VIDEO_EXTS
)
const acceptLabel = computed(() => (tool.value.accept === 'media' ? '音频或视频文件' : '视频文件'))

// ---------- 文件队列 (全局串行，按工具归属展示) ----------
const items = ref<QueueItem[]>([])
const ffmpeg = ref<{ found: boolean; error?: string } | null>(null)
const checking = ref(false)
const groupError = ref('')
let uid = 0
let queueRunning = false
let unlistenCommand: UnlistenFn | null = null

const toolItems = computed(() => items.value.filter((item) => item.toolId === currentId.value))
const readyItems = computed(() =>
  toolItems.value.filter((item) => item.status === 'ready' && !item.isJob)
)
const doneItems = computed(() => toolItems.value.filter((item) => item.status === 'done'))
const runningCount = computed(
  () => toolItems.value.filter((item) => ['queued', 'running'].includes(item.status)).length
)

const startDisabled = computed(() => {
  if (!ffmpeg.value?.found) return true
  if (tool.value.multiInput) return readyItems.value.length < 2
  return readyItems.value.length === 0
})

function activeBadge(toolId: string): number {
  return items.value.filter(
    (item) => item.toolId === toolId && ['queued', 'running'].includes(item.status)
  ).length
}

function blankItem(toolId: string, info: MediaInfo): QueueItem {
  return {
    ...info,
    uid: ++uid,
    toolId,
    status: info.error ? 'error' : 'ready',
    message: info.error,
    percent: 0,
    speed: '',
    eta: -1,
    inSize: info.size,
    outSize: 0,
    output: '',
    seconds: 0,
    child: null,
    isJob: false,
  }
}

async function addPaths(paths: string[]): Promise<void> {
  groupError.value = ''
  const current = tool.value
  for (const path of paths) {
    if (!hasExt(path, acceptExts.value)) continue
    const duplicate = items.value.some(
      (item) =>
        item.toolId === currentId.value &&
        item.path === path &&
        ['ready', 'queued', 'running'].includes(item.status) &&
        !item.isJob
    )
    if (duplicate) continue
    const info = await probe(path)
    if (!info.error) {
      // 默认要求有视频画面; 工具可通过 check 自定义
      info.error = current.check ? current.check(info) : !info.width ? '文件中未找到视频画面' : ''
    }
    items.value.push(blankItem(currentId.value, info))
  }
}

async function pickFiles(): Promise<void> {
  await addPaths(await pickMedia(acceptLabel.value, acceptExts.value))
}

async function pickAssetFile(field: ToolField): Promise<void> {
  const path = await pickAssetPath(
    field.pickTitle ?? '选择文件',
    field.filterName ?? '文件',
    field.exts ?? []
  )
  if (path !== null) settings.value[field.key] = path
}

function startAll(): void {
  const current = tool.value
  const snapshot: Settings = { ...settings.value }
  groupError.value = ''

  if (current.multiInput) {
    const sources: MediaInfo[] = readyItems.value.map((item) => ({ ...item }))
    const invalid = current.validateMulti?.(sources)
    if (invalid) {
      groupError.value = invalid
      return
    }
    const copy = current.canCopy?.(sources) ?? false
    items.value.unshift({
      uid: ++uid,
      toolId: current.id,
      isJob: true,
      sources,
      settings: snapshot,
      path: sources[0].path,
      name: `合并 ${sources.length} 个视频`,
      metaText: `${sources.length} 个片段 · 共 ${fmtDuration(sources.reduce((sum, item) => sum + item.duration, 0))} · ${copy ? '无损拼接' : '统一重编码'}`,
      size: sources.reduce((sum, item) => sum + item.size, 0),
      inSize: sources.reduce((sum, item) => sum + item.size, 0),
      duration: sources.reduce((sum, item) => sum + item.duration, 0),
      width: sources[0].width,
      height: sources[0].height,
      status: 'queued',
      message: '',
      percent: 0,
      speed: '',
      eta: -1,
      outSize: 0,
      output: '',
      seconds: 0,
      child: null,
      codec: '',
      audioCodec: '',
      error: '',
    })
    void runQueue()
    return
  }

  for (const item of readyItems.value) {
    const invalid = current.validate?.(item, snapshot)
    if (invalid) {
      item.status = 'error'
      item.message = invalid
      continue
    }
    item.settings = snapshot
    item.status = 'queued'
  }
  void runQueue()
}

// 全局串行队列: 编码任务本身吃满全核，并行只会互相拖慢
async function runQueue(): Promise<void> {
  if (queueRunning) return
  queueRunning = true
  try {
    for (;;) {
      const item = items.value.find((entry) => entry.status === 'queued')
      if (!item) break
      await runOne(item)
    }
  } finally {
    queueRunning = false
  }
}

async function runOne(item: QueueItem): Promise<void> {
  const current = TOOLS.find((entry) => entry.id === item.toolId)
  if (!current) return
  const snapshot = item.settings ?? { ...current.defaults }
  item.status = 'running'
  item.percent = 0
  item.speed = ''
  item.eta = -1
  item.outSize = 0

  let out = ''
  try {
    const steps = await buildSteps(current, item, snapshot)
    out = steps.output
    const totalUs = steps.totalUs
    const commands = steps.commands
    for (let index = 0; index < commands.length; index += 1) {
      const { child, done } = runFFmpeg(commands[index], totalUs / commands.length, (progress) => {
        item.percent =
          progress.percent < 0
            ? -1
            : (index * 100 + progress.percent) / commands.length
        item.speed = progress.speed
        item.eta = progress.eta
        item.outSize = progress.outSize
      })
      item.child = child
      const result = await done
      item.child = null
      if (wasCancelled(item)) return
      if (!result.ok) {
        item.status = 'error'
        item.message = result.message
        return
      }
      if (index === commands.length - 1) {
        item.status = 'done'
        item.percent = 100
        item.output = result.output
        item.outSize = result.outSize
        item.seconds = result.seconds
      }
    }
  } catch (error) {
    item.child = null
    if (!wasCancelled(item)) {
      item.status = 'error'
      item.message = messageOf(error)
    }
  } finally {
    if (current.cleanup && out !== '') {
      for (const file of current.cleanup(out)) void removeFile(file)
    }
  }
}

interface BuiltRun {
  output: string
  totalUs: number
  commands: string[][]
}

/** status 会在 await 期间被取消按钮改写，抽成函数避免 TS 把类型收窄死 */
function wasCancelled(item: QueueItem): boolean {
  return item.status === 'cancelled'
}

async function buildSteps(
  current: Tool,
  item: QueueItem,
  snapshot: Settings
): Promise<BuiltRun> {
  if (item.isJob && item.sources) {
    const target = current.outputMulti?.(item.sources)
    if (!target || !current.buildArgsMulti) throw new Error('该工具不支持合并任务')
    const output = await outputPath(item.path, target.suffix, target.ext)
    return {
      output,
      totalUs: current.totalUsMulti?.(item.sources) ?? 0,
      commands: [await current.buildArgsMulti(item.sources, output)],
    }
  }

  const target = current.output?.(item, snapshot)
  if (!target) throw new Error('该工具没有声明输出格式')
  const output = await outputPath(item.path, target.suffix, target.ext)
  if (current.buildSteps) {
    return { output, totalUs: current.totalUs?.(item, snapshot) ?? 0, commands: current.buildSteps(item, snapshot, output) }
  }
  if (!current.buildArgs) throw new Error('该工具没有声明处理参数')
  return {
    output,
    totalUs: current.totalUs?.(item, snapshot) ?? 0,
    commands: [await current.buildArgs(item, snapshot, output)],
  }
}

function cancel(item: QueueItem): void {
  item.status = 'cancelled'
  void item.child?.kill()
}

function retry(item: QueueItem): void {
  item.status = item.isJob ? 'queued' : 'ready'
  item.message = ''
  item.percent = 0
  if (item.isJob) void runQueue()
}

function remove(item: QueueItem): void {
  items.value = items.value.filter((entry) => entry.uid !== item.uid)
}

function moveItem(item: QueueItem, dir: number): void {
  const list = items.value
  const indexes = list
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.toolId === item.toolId && entry.status === 'ready' && !entry.isJob
    )
    .map(({ index }) => index)
  const position = indexes.findIndex((index) => list[index].uid === item.uid)
  const target = indexes[position + dir]
  if (target === undefined) return
  const current = indexes[position]
  ;[list[current], list[target]] = [list[target], list[current]]
}

// ---------- 效果预览: 按当前参数抽一帧 ----------
const preview = reactive({ open: false, src: '', loading: false, forUid: 0 })
let previewSeq = 0

async function previewItem(item: QueueItem): Promise<void> {
  const current = tool.value
  const snapshot = settings.value
  if (!current.previewArgs) return
  const invalid = current.validate?.(item, snapshot)
  if (invalid) {
    item.status = 'error'
    item.message = invalid
    return
  }
  preview.loading = true
  preview.forUid = item.uid
  try {
    const png = await tempPath(`lightvideo-preview-${item.uid}-${++previewSeq}.png`)
    const args = await current.previewArgs(item, snapshot, png)
    const { done } = runFFmpeg(args, 0, () => {})
    const result = await done
    if (result.ok) {
      // 沙箱页面读不了本地文件：预览帧由 core 转成 data URL
      preview.src = await readImage(png)
      preview.open = true
    } else {
      groupError.value = '预览失败：' + result.message
    }
    void removeFile(png)
  } catch (error) {
    groupError.value = '预览失败：' + messageOf(error)
  } finally {
    preview.loading = false
    preview.forUid = 0
  }
}

function clearFinished(): void {
  items.value = items.value.filter(
    (item) => item.toolId !== currentId.value || !['done', 'error', 'cancelled'].includes(item.status)
  )
}

async function checkComponent(): Promise<void> {
  checking.value = true
  ffmpeg.value = await checkFFmpeg()
  checking.value = false
}

onMounted(async () => {
  void checkComponent()
  // 搜索条里选中文件后执行「用轻影处理这些视频」：命令会排队补发给窗口
  unlistenCommand = await listen<CommandPayload>('command', (event) => {
    const attachment = event.payload?.attachment
    if (attachment?.kind === 'files') {
      const paths = attachment.files.filter((file) => file.isFile).map((file) => file.path)
      void addPaths(paths)
    }
  })
})

onBeforeUnmount(() => {
  unlistenCommand?.()
  unlistenCommand = null
})

// ---------- 格式化 ----------
function fmtSize(bytes: number): string {
  if (!bytes) return '-'
  if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + ' GB'
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB'
  return (bytes / 1024).toFixed(0) + ' KB'
}

function fmtDuration(sec: number): string {
  if (!sec) return '-'
  const total = Math.round(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

function fmtEta(sec: number): string {
  if (sec < 0) return ''
  if (sec < 60) return `剩余 ${sec} 秒`
  return `剩余 ${Math.ceil(sec / 60)} 分钟`
}

function savedPct(item: QueueItem): number {
  if (!item.inSize || !item.outSize) return 0
  return Math.round((1 - item.outSize / item.inSize) * 100)
}

function baseName(path: string): string {
  return path ? path.split(/[/\\]/).pop() ?? '' : ''
}
</script>

<template>
  <div class="app">
    <!-- 侧栏 -->
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-logo" v-html="ICONS.brand"></span>
        <div class="brand-text">
          <div class="brand-name">轻影</div>
          <div class="brand-sub">LightVideo</div>
        </div>
      </div>

      <nav class="nav">
        <template v-for="g in TOOL_GROUPS" :key="g.name">
          <div class="nav-group">{{ g.name }}</div>
          <button
            v-for="t in g.tools"
            :key="t.id"
            class="nav-item"
            :class="{ active: t.id === currentId }"
            @click="currentId = t.id; groupError = ''"
          >
            <span class="nav-icon" v-html="ICONS[t.icon]"></span>
            <span class="nav-label">{{ t.name }}</span>
            <span v-if="activeBadge(t.id)" class="nav-badge">{{ activeBadge(t.id) }}</span>
          </button>
        </template>
      </nav>

      <div class="sidebar-foot">
        <div>云中江树</div>
        <div class="sidebar-foot-sub">微信公众号「云中江树」</div>
      </div>
    </aside>

    <!-- 主区 -->
    <main class="content">
      <header class="tool-head">
        <h1>{{ tool.name }}</h1>
        <p>{{ tool.desc }}</p>
      </header>

      <div v-if="ffmpeg && !ffmpeg.found" class="alert">
        <span>视频处理组件不可用{{ ffmpeg.error ? '：' + ffmpeg.error : '' }}</span>
        <button class="btn ghost small" :disabled="checking" @click="checkComponent">
          {{ checking ? '检测中…' : '重试' }}
        </button>
      </div>
      <div v-if="groupError" class="alert">{{ groupError }}</div>

      <!-- 参数面板 -->
      <section class="panel" v-if="visibleFields.length">
        <div v-for="f in visibleFields" :key="f.key" class="field">
          <div class="field-label">
            {{ typeof f.label === 'function' ? f.label(settings) : f.label }}
          </div>

          <input
            v-if="f.type === 'range'"
            type="range"
            :min="f.min"
            :max="f.max"
            v-model.number="settings[f.key]"
            :disabled="runningCount > 0"
          />

          <div v-else-if="f.type === 'segmented'" class="segmented">
            <button
              v-for="o in f.options"
              :key="o.value"
              :class="{ active: settings[f.key] === o.value }"
              :disabled="runningCount > 0"
              @click="settings[f.key] = o.value"
            >
              {{ o.label }}
            </button>
          </div>

          <input
            v-else-if="f.type === 'time'"
            type="text"
            class="time-input"
            :placeholder="f.placeholder"
            v-model.trim="settings[f.key]"
            :disabled="runningCount > 0"
            spellcheck="false"
          />

          <div v-else-if="f.type === 'file'" class="file-field">
            <button class="btn ghost small" :disabled="runningCount > 0" @click="pickAssetFile(f)">选择文件</button>
            <span class="file-name" :class="{ empty: !settings[f.key] }" :title="settings[f.key]">
              {{ settings[f.key] ? baseName(settings[f.key]) : '未选择' }}
            </span>
          </div>

          <div class="field-hint">{{ f.hint ? f.hint(settings) : '' }}</div>
        </div>
      </section>

      <!-- 空状态：点击选择文件 -->
      <section v-if="toolItems.length === 0" class="dropzone" @click="pickFiles">
        <div class="dropzone-art">
          <span class="dropzone-icon" v-html="ICONS[tool.icon]"></span>
        </div>
        <div class="dropzone-title">
          {{ tool.multiInput ? '选择多个视频，按顺序拼接' : `点击选择${acceptLabel}` }}
        </div>
        <div class="dropzone-hint">
          {{ tool.accept === 'media' ? '支持 MP3 / M4A / WAV / FLAC 等录音格式，也接受视频' : '支持 MP4 / MOV / MKV / AVI / FLV / WebM 等格式' }}
          · 输出不覆盖原文件
        </div>
        <div class="dropzone-tip">也可以在搜索条选中视频文件后执行「用轻影处理这些视频」</div>
      </section>

      <!-- 队列 -->
      <section v-else class="queue">
        <div class="queue-head">
          <div class="queue-title">
            {{ tool.multiInput ? '素材与任务' : '任务' }}
            <span class="count">{{ toolItems.length }}</span>
            <span v-if="tool.compare && doneItems.length" class="saved-total">
              共节省 {{ fmtSize(doneItems.reduce((s, i) => s + Math.max(0, i.inSize - i.outSize), 0)) }}
            </span>
          </div>
          <div class="queue-actions">
            <button v-if="doneItems.length" class="btn ghost" @click="clearFinished">清除已完成</button>
            <button class="btn ghost" @click="pickFiles">
              <span class="btn-icon" v-html="ICONS.plus"></span>添加
            </button>
            <button class="btn primary" :disabled="startDisabled" @click="startAll">
              {{ tool.action }}{{ !tool.multiInput && readyItems.length > 1 ? ` (${readyItems.length})` : '' }}
            </button>
          </div>
        </div>

        <TransitionGroup name="list" tag="div" class="items">
          <div class="item" v-for="item in toolItems" :key="item.uid">
            <div class="item-main">
              <div class="item-name" :title="item.path">{{ item.name }}</div>
              <div class="item-meta">
                <template v-if="item.metaText">{{ item.metaText }}</template>
                <template v-else-if="item.width">
                  {{ item.width }}×{{ item.height }} · {{ item.codec }} · {{ fmtDuration(item.duration) }} · {{ fmtSize(item.size) }}
                </template>
                <template v-else-if="item.audioCodec">
                  录音 · {{ item.audioCodec }} · {{ fmtDuration(item.duration) }} · {{ fmtSize(item.size) }}
                </template>
              </div>

              <!-- 进行中 -->
              <div v-if="item.status === 'running'" class="progress-row">
                <div class="progress-bar" :class="{ indeterminate: item.percent < 0 }">
                  <div class="progress-fill" :style="item.percent >= 0 ? { width: item.percent + '%' } : {}"></div>
                </div>
                <span v-if="item.percent >= 0" class="progress-text">
                  {{ item.stageText ? item.stageText + ' · ' : '' }}{{ item.percent.toFixed(0) }}%
                  <template v-if="!item.stageText">· {{ item.speed }} {{ fmtEta(item.eta) }}</template>
                </span>
                <span v-else class="progress-text">{{ item.stageText || '处理中…' }}</span>
              </div>

              <!-- 完成 -->
              <div v-else-if="item.status === 'done'" class="result">
                <template v-if="tool.compare">
                  <span class="size-before">{{ fmtSize(item.inSize) }}</span>
                  <span class="arrow">→</span>
                  <span class="size-after">{{ fmtSize(item.outSize) }}</span>
                  <span class="badge success" v-if="savedPct(item) > 0">瘦身 {{ savedPct(item) }}%</span>
                  <span class="badge warn" v-else>未变小，原文件已高度压缩</span>
                </template>
                <template v-else>
                  <span class="badge success">完成</span>
                  <span class="out-name">{{ baseName(item.output) }}</span>
                  <span class="out-size">{{ fmtSize(item.outSize) }}</span>
                </template>
              </div>

              <div v-else-if="item.status === 'error'" class="result">
                <span class="badge danger" :title="item.message">{{ item.message }}</span>
              </div>

              <div v-else-if="item.status === 'cancelled'" class="result">
                <span class="badge gray">已取消</span>
              </div>

              <div v-else-if="item.status === 'queued'" class="result">
                <span class="badge gray">排队中…</span>
              </div>
            </div>

            <div class="item-actions">
              <template v-if="tool.multiInput && item.status === 'ready'">
                <button class="btn ghost small" title="上移" @click="moveItem(item, -1)">↑</button>
                <button class="btn ghost small" title="下移" @click="moveItem(item, 1)">↓</button>
              </template>
              <button
                v-if="tool.previewArgs && item.status === 'ready'"
                class="btn ghost small"
                :disabled="preview.loading"
                @click="previewItem(item)"
              >
                {{ preview.loading && preview.forUid === item.uid ? '生成中…' : '预览效果' }}
              </button>
              <button v-if="['queued', 'running'].includes(item.status)" class="btn ghost small" @click="cancel(item)">取消</button>
              <button v-if="item.status === 'done'" class="btn ghost small" @click="revealFile(item.output)">显示文件</button>
              <button v-if="['error', 'cancelled'].includes(item.status) && (item.width || item.audioCodec || item.isJob)" class="btn ghost small" @click="retry(item)">重试</button>
              <button v-if="!['queued', 'running'].includes(item.status)" class="btn ghost small quiet" @click="remove(item)">移除</button>
            </div>
          </div>
        </TransitionGroup>
      </section>
    </main>

    <!-- 效果预览弹层 -->
    <div v-if="preview.open" class="preview-mask" @click="preview.open = false">
      <div class="preview-box" @click.stop>
        <img :src="preview.src" alt="效果预览" />
        <div class="preview-foot">
          <span>按当前参数生成的单帧预览</span>
          <button class="btn primary" @click="preview.open = false">好的</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  overflow: hidden;
}

/* ============ 侧栏 ============ */
.sidebar {
  width: 216px;
  flex-shrink: 0;
  background: #fff;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 20px 12px 16px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 10px 16px;
}
.brand-logo {
  width: 38px;
  height: 38px;
  display: block;
  filter: drop-shadow(0 3px 8px rgba(22, 100, 255, 0.35));
}
.brand-logo :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.brand-name {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.02em;
  line-height: 1.2;
}
.brand-sub {
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 0.04em;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  overflow-y: auto;
  margin: 0 -4px;
  padding: 0 4px;
}
.nav-group {
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 0.08em;
  padding: 12px 12px 5px;
}
.nav-group:first-child {
  padding-top: 2px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7.5px 12px;
  border-radius: var(--radius);
  font-size: 13.5px;
  color: var(--text-2);
  transition: background 0.18s, color 0.18s, transform 0.12s;
  text-align: left;
  flex-shrink: 0;
}
.nav-item:hover {
  background: var(--fill-1);
  color: var(--text-1);
}
.nav-item:active {
  transform: scale(0.98);
}
.nav-item.active {
  background: var(--primary-light);
  color: var(--primary);
  font-weight: 600;
}
.nav-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
.nav-icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.nav-label {
  flex: 1;
}
.nav-badge {
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  border-radius: 99px;
  background: var(--primary);
  color: #fff;
  font-size: 10.5px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}

.sidebar-foot {
  padding: 12px 10px 0;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-2);
}
.sidebar-foot-sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 1px;
}

/* ============ 主区 ============ */
.content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 26px 28px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.tool-head h1 {
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.tool-head p {
  font-size: 13px;
  color: var(--text-3);
  margin-top: 3px;
}

.alert {
  background: var(--danger-light);
  color: var(--danger);
  padding: 12px 16px;
  border-radius: var(--radius);
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* 参数面板 */
.panel {
  background: #fff;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 18px 22px 13px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 18px 26px;
  flex-shrink: 0;
}
.field-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
  margin-bottom: 9px;
  font-variant-numeric: tabular-nums;
}
.field-hint {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 7px;
  min-height: 16px;
}
.field input[type='range'] {
  width: 100%;
  accent-color: var(--primary);
  cursor: pointer;
}

.segmented {
  display: flex;
  background: var(--fill-2);
  border-radius: var(--radius-sm);
  padding: 3px;
  gap: 2px;
}
.segmented button {
  flex: 1;
  padding: 5.5px 4px;
  font-size: 12.5px;
  border-radius: 5px;
  color: var(--text-2);
  transition: all 0.16s;
  white-space: nowrap;
}
.segmented button:hover:not(.active):not(:disabled) {
  color: var(--text-1);
}
.segmented button.active {
  background: #fff;
  color: var(--primary);
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(26, 34, 51, 0.1);
}
.segmented button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.time-input {
  width: 100%;
  padding: 6.5px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
  background: #fff;
  transition: border-color 0.16s, box-shadow 0.16s;
}
.time-input:hover {
  border-color: #c9d2e3;
}
.time-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(22, 100, 255, 0.12);
  outline: none;
}
.time-input:disabled {
  background: var(--fill-1);
  color: var(--text-3);
}

.file-field {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.file-name {
  font-size: 12.5px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-name.empty {
  color: var(--text-3);
}

/* 拖放区 */
.dropzone {
  flex: 1;
  min-height: 240px;
  border: 1.5px dashed #cfd8e8;
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
  background: rgba(255, 255, 255, 0.55);
}
.dropzone:hover {
  border-color: var(--primary);
  background: var(--primary-lighter);
}
.dropzone-art {
  width: 68px;
  height: 68px;
  border-radius: 20px;
  background: var(--primary-light);
  color: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 10px;
  transition: transform 0.25s;
}
.dropzone:hover .dropzone-art {
  transform: translateY(-3px) scale(1.04);
}
.dropzone-icon {
  width: 32px;
  height: 32px;
}
.dropzone-icon :deep(svg) {
  width: 100%;
  height: 100%;
}
.dropzone-title {
  font-size: 15.5px;
  font-weight: 600;
}
.dropzone-hint {
  font-size: 12px;
  color: var(--text-3);
}
.dropzone-tip {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--text-3);
  opacity: 0.85;
}

/* 队列 */
.queue {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.queue-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.queue-title {
  font-size: 14.5px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.count {
  font-size: 11.5px;
  color: var(--text-3);
  background: var(--fill-2);
  padding: 1px 8px;
  border-radius: 99px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.saved-total {
  font-size: 12px;
  color: var(--success);
  background: var(--success-light);
  padding: 1px 9px;
  border-radius: 99px;
  font-weight: 500;
}
.queue-actions {
  display: flex;
  gap: 8px;
}

/* 按钮 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 16px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  transition: all 0.16s;
}
.btn:active:not(:disabled) {
  transform: scale(0.97);
}
.btn.primary {
  background: var(--primary);
  color: #fff;
  font-weight: 500;
  box-shadow: var(--shadow-pop);
}
.btn.primary:hover:not(:disabled) {
  background: var(--primary-hover);
  transform: translateY(-1px);
}
.btn.primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
}
.btn.ghost {
  color: var(--text-2);
  background: #fff;
  border: 1px solid var(--border);
}
.btn.ghost:hover:not(:disabled) {
  color: var(--primary);
  border-color: rgba(22, 100, 255, 0.4);
}
.btn.ghost:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn.small {
  padding: 4px 11px;
  font-size: 12px;
}
.btn.quiet {
  border-color: transparent;
  background: transparent;
  color: var(--text-3);
}
.btn.quiet:hover:not(:disabled) {
  color: var(--danger);
  border-color: transparent;
  background: var(--danger-light);
}
.btn-icon {
  width: 13px;
  height: 13px;
  display: block;
}
.btn-icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

/* 任务卡片 */
.items {
  display: flex;
  flex-direction: column;
  gap: 9px;
  position: relative;
}
.item {
  display: flex;
  align-items: center;
  gap: 16px;
  background: #fff;
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  padding: 13px 18px;
}
.item-main {
  flex: 1;
  min-width: 0;
}
.item-name {
  font-size: 13.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.item-meta {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
}
.item-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

/* 进度 */
.progress-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 9px;
}
.progress-bar {
  flex: 1;
  height: 6px;
  background: var(--fill-2);
  border-radius: 99px;
  overflow: hidden;
  position: relative;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #3d7fff, var(--primary));
  border-radius: 99px;
  transition: width 0.35s ease;
}
.progress-bar.indeterminate .progress-fill {
  position: absolute;
  width: 36%;
  animation: slide 1.1s ease-in-out infinite;
}
@keyframes slide {
  0% {
    left: -36%;
  }
  100% {
    left: 100%;
  }
}
.progress-text {
  font-size: 12px;
  color: var(--text-2);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

/* 结果 */
.result {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
  font-size: 13px;
  min-width: 0;
}
.size-before {
  color: var(--text-3);
  text-decoration: line-through;
  font-variant-numeric: tabular-nums;
}
.arrow {
  color: var(--text-3);
}
.size-after {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.out-name {
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.out-size {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.badge {
  font-size: 12px;
  padding: 1.5px 9px;
  border-radius: 5px;
  flex-shrink: 0;
}
.badge.success {
  color: var(--success);
  background: var(--success-light);
  font-weight: 500;
}
.badge.warn {
  color: var(--warning);
  background: var(--warning-light);
}
.badge.danger {
  color: var(--danger);
  background: var(--danger-light);
  max-width: 520px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}
.badge.gray {
  color: var(--text-3);
  background: var(--fill-2);
}

/* 列表动画 */
.list-enter-active {
  transition: all 0.3s ease;
}
.list-leave-active {
  transition: all 0.2s ease;
  position: absolute;
  width: 100%;
}
.list-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.list-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
.list-move {
  transition: transform 0.25s ease;
}

/* 效果预览 */
.preview-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 22, 36, 0.55);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  animation: fadeIn 0.18s ease;
}
@keyframes fadeIn {
  from {
    opacity: 0;
  }
}
.preview-box {
  background: #fff;
  border-radius: 14px;
  padding: 12px;
  max-width: min(78vw, 900px);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 24px 80px rgba(10, 20, 40, 0.35);
  animation: popIn 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
@keyframes popIn {
  from {
    opacity: 0;
    transform: scale(0.94);
  }
}
.preview-box img {
  max-width: 100%;
  max-height: calc(86vh - 74px);
  object-fit: contain;
  border-radius: 8px;
  background: var(--fill-2);
}
.preview-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 2px;
  font-size: 12px;
  color: var(--text-3);
}
</style>
