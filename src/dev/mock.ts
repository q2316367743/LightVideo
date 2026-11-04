/**
 * 开发预览用的宿主桥模拟。
 *
 * 只在 `vite dev` 且当前不在搭手窗口里时启用：让 UI 能在普通浏览器里调试 / 截图。
 * 不联网、不落盘，ffmpeg 用定时器模拟进度。生产构建不会加载它。
 */
import { hasInternals } from '@dashou/api'

interface DemoFile {
  path: string
  name: string
  duration: number
  width: number
  height: number
  codec: string
  audioCodec: string
  size: number
}

const DEMO_DIR = '/Users/demo/Movies'
const DEMOS: DemoFile[] = [
  {
    path: `${DEMO_DIR}/产品发布会实录.mp4`,
    name: '产品发布会实录.mp4',
    duration: 26,
    width: 3840,
    height: 2160,
    codec: 'hevc',
    audioCodec: 'aac',
    size: 2.31 * 1024 ** 3,
  },
  {
    path: `${DEMO_DIR}/团队周会录屏.mov`,
    name: '团队周会录屏.mov',
    duration: 18,
    width: 2560,
    height: 1440,
    codec: 'prores',
    audioCodec: 'pcm_s16le',
    size: 1.08 * 1024 ** 3,
  },
  {
    path: `${DEMO_DIR}/Vlog-上海城市漫步.mp4`,
    name: 'Vlog-上海城市漫步.mp4',
    duration: 12,
    width: 1920,
    height: 1080,
    codec: 'h264',
    audioCodec: 'aac',
    size: 640 * 1024 ** 2,
  },
]

type Callback = (payload: { event: string; id: number; payload: unknown }) => void

const callbacks = new Map<number, Callback>()
const listeners = new Map<string, Set<number>>()
let nextCallbackId = 1
const timers = new Map<string, ReturnType<typeof setInterval>>()

function emit(event: string, payload: unknown): void {
  for (const id of listeners.get(event) ?? []) {
    callbacks.get(id)?.({ event, id, payload })
  }
}

function demoOf(path: string): DemoFile | undefined {
  return DEMOS.find((item) => item.path === path)
}

function parseArgs(args: unknown): string[] {
  return Array.isArray(args) ? args.filter((item): item is string => typeof item === 'string') : []
}

/** 预览图：渐变底 + 时间码，跟真实 ffmpeg 抽帧一样走 data URL */
function placeholderFrame(label: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = 960
  canvas.height = 540
  const ctx = canvas.getContext('2d')
  if (ctx === null) return ''
  const gradient = ctx.createLinearGradient(0, 0, 960, 540)
  gradient.addColorStop(0, '#dbe9ff')
  gradient.addColorStop(1, '#f6f8fb')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 960, 540)
  ctx.fillStyle = 'rgba(22, 100, 255, 0.12)'
  ctx.beginPath()
  ctx.arc(720, 150, 130, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#8a94a6'
  ctx.font = '500 26px -apple-system, "PingFang SC", sans-serif'
  ctx.fillText(label, 48, 480)
  ctx.fillStyle = '#1a2233'
  ctx.font = '600 34px -apple-system, "PingFang SC", sans-serif'
  ctx.fillText('效果预览（模拟）', 48, 300)
  return canvas.toDataURL('image/png')
}

function startFfmpegRun(args: string[]): { runId: string } {
  const runId = `mock-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`

  // -version / 探测：立即结束
  if (args.includes('-version')) {
    setTimeout(() => emit('ffmpeg:exit', { runId, code: 0, signal: '' }), 30)
    return { runId }
  }

  const probe = args.includes('-i') && args.length <= 3
  if (probe) {
    const input = args[args.indexOf('-i') + 1] ?? ''
    const demo = demoOf(input)
    const logs = demo
      ? `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '${input}':\n  Duration: 00:00:${String(demo.duration).padStart(2, '0')}.00, start: 0.000000, bitrate: 138 kb/s\n  Stream #0:0[0x1](und): Video: ${demo.codec} (High) (avc1 / 0x31637661), yuv420p(tv), ${demo.width}x${demo.height} [SAR 1:1 DAR 16:9], 56 kb/s, 30 fps\n  Stream #0:1[0x2](und): Audio: ${demo.audioCodec} (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 69 kb/s\nAt least one output file must be specified\n`
      : `[mov,mp4,m4a,3gp,3g2,mj2 @ 0x0] moov atom not found\n${input}: Invalid data found when processing input\n`
    setTimeout(() => {
      emit('ffmpeg:log', { runId, text: logs })
      emit('ffmpeg:exit', { runId, code: demo ? 1 : 1, signal: '' })
    }, 60)
    return { runId }
  }

  const input = args.indexOf('-i') >= 0 ? args[args.indexOf('-i') + 1] ?? '' : ''
  const total = demoOf(input)?.duration ?? 20
  const steps = 10
  const stepMs = 300
  let elapsed = 0
  const timer = setInterval(() => {
    elapsed += total / steps
    if (elapsed >= total) {
      clearInterval(timer)
      timers.delete(runId)
      emit('ffmpeg:progress', { runId, time: formatTime(total), speed: '3.4x', size: '0' })
      setTimeout(() => emit('ffmpeg:exit', { runId, code: 0, signal: '' }), 80)
      return
    }
    emit('ffmpeg:progress', {
      runId,
      time: formatTime(elapsed),
      speed: '3.4x',
      size: String(Math.round((elapsed / total) * 40 * 1024 * 1024)),
    })
  }, stepMs)
  timers.set(runId, timer)
  return { runId }
}

function formatTime(seconds: number): string {
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0')
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
  const s = String(Math.floor(seconds % 60)).padStart(2, '0')
  return `${h}:${m}:${s}.${String(Math.round((seconds % 1) * 1e6)).padStart(6, '0')}`
}

function sizeOf(path: string): number {
  if (path.endsWith('.png') || path.endsWith('.jpg')) return 320 * 1024
  const demo = demoOf(path)
  if (demo) return demo.size
  let hash = 0
  for (const char of path) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return 40 * 1024 ** 2 + (hash % (600 * 1024 ** 2))
}

async function invoke(command: string, args?: unknown): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }> {
  const value = (args ?? {}) as Record<string, unknown>
  const ok = (result: unknown): { ok: true; result: unknown } => ({ ok: true, result })

  if (command === 'plugin:event|listen') {
    const event = String(value.event ?? '')
    const id = Number(value.handler)
    const set = listeners.get(event) ?? new Set<number>()
    set.add(id)
    listeners.set(event, set)
    return ok(0)
  }
  if (command === 'plugin:event|unlisten') {
    const event = String(value.event ?? '')
    const id = Number(value.handler)
    listeners.get(event)?.delete(id)
    callbacks.delete(id)
    return ok(0)
  }
  if (command.startsWith('plugin:ffmpeg|')) {
    if (command === 'plugin:ffmpeg|run') return ok(startFfmpegRun(parseArgs(value.args)))
    if (command === 'plugin:ffmpeg|kill' || command === 'plugin:ffmpeg|quit') {
      const runId = String(value.runId ?? '')
      const timer = timers.get(runId)
      if (timer) clearInterval(timer)
      timers.delete(runId)
      setTimeout(() => emit('ffmpeg:exit', { runId, code: -1, signal: 'SIGKILL' }), 40)
      return ok(true)
    }
  }

  if (!command.startsWith('plugin:api|')) {
    return ok({})
  }

  const method = command.slice('plugin:api|'.length)
  switch (method) {
    case 'pick': {
      const wanted = Array.isArray(value.extensions)
        ? value.extensions.map((item) => `.${String(item)}`)
        : []
      const files = DEMOS.filter((demo) =>
        wanted.some((ext) => demo.path.toLowerCase().endsWith(ext))
      ).map((demo) => ({ path: demo.path, name: demo.name, size: demo.size }))
      return ok({ files })
    }
    case 'prepareOutput': {
      const input = String(value.input ?? '')
      const suffix = String(value.suffix ?? '')
      const ext = String(value.ext ?? 'mp4')
      const stem = input.replace(/\.[^./\\]+$/, '')
      return ok({ path: `${stem}${suffix}.${ext}` })
    }
    case 'tempPath':
      return ok({ path: `/tmp/lightvideo-preview/${String(value.name ?? 'tmp')}` })
    case 'copyToTemp':
      return ok({ path: `/tmp/lightvideo-asset.${String(value.ext ?? 'bin')}` })
    case 'writeConcatList':
      return ok({ path: '/tmp/lightvideo-concat.txt' })
    case 'fileSize':
      return ok({ size: sizeOf(String(value.path ?? '')) })
    case 'readImage':
      return ok({ dataUrl: placeholderFrame(String(value.path ?? '')) })
    case 'reveal':
    case 'writeText':
    case 'removeFiles':
      return ok(null)
    case 'platform':
      return ok({ platform: 'macos' })
    default:
      return { ok: false, error: { code: 'NOT_FOUND', message: `未实现的方法：${method}` } }
  }
}

export function installMock(): void {
  if (hasInternals()) return
  const scope = window as unknown as Record<string, unknown>
  scope.__DA_SHOU_INTERNALS__ = {
    invoke,
    transformCallback: (callback: Callback) => {
      const id = nextCallbackId++
      callbacks.set(id, callback)
      return id
    },
    unregisterCallback: (id: number) => {
      callbacks.delete(id)
    },
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main', windowLabel: 'main' },
    },
    plugins: { path: { sep: '/', delimiter: ':' } },
    convertFileSrc: (path: string) => path,
    attach: async () => null,
    isDaShou: true,
  }
}
