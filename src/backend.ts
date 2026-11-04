import { platform, useApi } from '@dashou/api'
import type { Api } from '../src-dashou'
import { startFfmpeg } from './ffmpeg'
import type { MediaInfo, Progress } from './types'

/**
 * 窗口侧的后端适配层：
 * - ffmpeg 走宿主能力（首次使用自动下载运行时）；
 * - 文件选择、路径计算、临时文件、写字幕、定位文件走 core 自有 API。
 */
export const api = useApi<Api>()

export const VIDEO_EXTS = [
  'mp4', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'webm', 'm4v',
  'ts', 'mts', 'm2ts', '3gp', 'mpg', 'mpeg', 'rmvb',
]

export const AUDIO_EXTS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'amr', 'aiff', 'caf']

export function hasExt(path: string, exts: string[]): boolean {
  const ext = path.split('.').pop()?.toLowerCase()
  return ext !== undefined && exts.includes(ext)
}

export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/** 检查 ffmpeg 是否可用；首次调用会触发宿主下载运行时 */
export async function checkFFmpeg(): Promise<{ found: boolean; error?: string }> {
  try {
    const result = await startFfmpeg(['-hide_banner', '-loglevel', 'error', '-version'], 0).done
    if (result.code === 0) return { found: true }
    return { found: false, error: result.tail || '视频处理组件不可用' }
  } catch (error) {
    return { found: false, error: messageOf(error) }
  }
}

/** 系统文件选择框（多选） */
export async function pickMedia(title: string, extensions: string[]): Promise<string[]> {
  const result = await api.pick({ title, extensions, multiple: true })
  return result.files.map((file) => file.path)
}

/** 单选素材文件（水印图 / 字幕 / 背景音乐） */
export async function pickFile(
  title: string,
  name: string,
  extensions: string[]
): Promise<string | null> {
  const result = await api.pick({ title, label: name, extensions, multiple: false })
  return result.files[0]?.path ?? null
}

interface ProbeFields {
  duration: number
  width: number
  height: number
  codec: string
  audioCodec: string
  error: string
}

const DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/
const STREAM_RE = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio): ([^\n]+)/g

/** 从 ffmpeg 的 stderr 里读出时长 / 分辨率 / 编码（宿主没有 ffprobe） */
export function parseProbeLog(logs: string): ProbeFields {
  const fields: ProbeFields = {
    duration: 0,
    width: 0,
    height: 0,
    codec: '',
    audioCodec: '',
    error: '',
  }

  const duration = DURATION_RE.exec(logs)
  if (duration !== null) {
    fields.duration = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
  }

  for (const match of logs.matchAll(STREAM_RE)) {
    const kind = match[1]
    // 去掉括号里的编码档位 / 像素格式，避免把 "0x31637661" 当成分辨率
    const detail = match[2].replace(/\([^)]*\)/g, ' ')
    if (kind === 'Video' && fields.codec === '') {
      fields.codec = (detail.trim().match(/^[\w-]+/)?.[0] ?? '').toLowerCase()
      const size = /(\d{2,5})x(\d{2,5})/.exec(detail)
      if (size !== null) {
        fields.width = Number(size[1])
        fields.height = Number(size[2])
      }
    } else if (kind === 'Audio' && fields.audioCodec === '') {
      fields.audioCodec = (detail.trim().match(/^[\w-]+/)?.[0] ?? '').toLowerCase()
    }
  }

  if (/No such file or directory/i.test(logs)) {
    fields.error = '文件不存在或无法访问'
  } else if (/Permission denied/i.test(logs)) {
    fields.error = '没有权限读取该文件'
  } else if (/Is a directory/i.test(logs)) {
    fields.error = '这是一个文件夹，请选择视频文件'
  } else if (/Invalid data found when processing input|moov atom not found|could not find codec parameters/i.test(logs)) {
    fields.error = '无法解析该文件，可能不是有效的视频'
  } else if (fields.duration === 0 && fields.codec === '' && fields.audioCodec === '') {
    fields.error = '无法解析该文件，可能不是有效的视频'
  }

  return fields
}

/** 探测一个本地文件的元信息 */
export async function probe(path: string): Promise<MediaInfo> {
  const name = path.split(/[/\\]/).pop() ?? path
  const info: MediaInfo = {
    path,
    name,
    size: 0,
    duration: 0,
    width: 0,
    height: 0,
    codec: '',
    audioCodec: '',
    error: '',
  }

  try {
    const { size } = await api.fileSize({ path })
    info.size = size
  } catch {
    // 大小读不到不影响后续处理
  }

  try {
    // 只给 -i、不给输出：ffmpeg 打印完流信息就以 "At least one output file" 退出
    const result = await startFfmpeg(['-hide_banner', '-i', path], 0).done
    return { ...info, ...parseProbeLog(result.logs) }
  } catch (error) {
    return { ...info, error: messageOf(error) }
  }
}

export interface RunResult {
  ok: boolean
  output: string
  outSize: number
  seconds: number
  message: string
}

export interface RunHandle {
  child: { kill: () => Promise<boolean> }
  done: Promise<RunResult>
}

/**
 * 执行一个 ffmpeg 任务。
 * @param args    完整参数，输出文件须是最后一个参数
 * @param totalUs 总时长（微秒），0 表示进度不可估算（percent 回调为 -1）
 */
export function runFFmpeg(
  args: string[],
  totalUs: number,
  onProgress: (progress: Progress) => void
): RunHandle {
  const out = args[args.length - 1]
  // 进度走 stdout，日志只留错误；宿主看到已有 -progress 就不会重复添加
  const full = [...args.slice(0, -1), '-progress', 'pipe:1', '-nostats', '-loglevel', 'error', out]
  const started = Date.now()
  const handle = startFfmpeg(full, totalUs, (progress) => {
    onProgress({
      percent: progress.percent,
      speed: progress.speed,
      outSize: progress.size,
      eta: progress.eta,
    })
  })

  const done = (async (): Promise<RunResult> => {
    try {
      const result = await handle.done
      if (result.code === 0) {
        const { size } = await api.fileSize({ path: out })
        return {
          ok: true,
          output: out,
          outSize: size,
          seconds: Math.round((Date.now() - started) / 1000),
          message: '',
        }
      }
      await discard(out)
      return {
        ok: false,
        output: '',
        outSize: 0,
        seconds: 0,
        message: result.tail || `ffmpeg 退出码 ${result.code}`,
      }
    } catch (error) {
      await discard(out)
      return { ok: false, output: '', outSize: 0, seconds: 0, message: messageOf(error) }
    }
  })()

  return { child: handle, done }
}

/** 失败 / 取消时删掉半成品；null muxer 的 "-" 不能当路径删 */
async function discard(path: string): Promise<void> {
  if (path === '-' || path === 'pipe:1' || path === '') return
  try {
    await api.removeFiles({ paths: [path] })
  } catch {
    // 清理失败不影响任务结果
  }
}

export async function outputPath(input: string, suffix: string, ext: string): Promise<string> {
  const result = await api.prepareOutput({ input, suffix, ext })
  return result.path
}

export async function fileSize(path: string): Promise<number> {
  const result = await api.fileSize({ path })
  return result.size
}

export async function tempPath(name: string): Promise<string> {
  const result = await api.tempPath({ name })
  return result.path
}

export async function writeConcatList(paths: string[]): Promise<string> {
  const result = await api.writeConcatList({ paths })
  return result.path
}

export async function copyToTemp(src: string, ext: string): Promise<string> {
  const result = await api.copyToTemp({ src, ext })
  return result.path
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await api.writeText({ path, content })
}

export async function removeFile(path: string): Promise<void> {
  if (path === '') return
  await api.removeFiles({ paths: [path] })
}

export function revealFile(path: string): void {
  void api.reveal({ path })
}

/** 预览帧转 data URL：沙箱页面读不了本地图片 */
export async function readImage(path: string): Promise<string> {
  const result = await api.readImage({ path })
  return result.dataUrl
}

/** 中文字幕需要显式指定字体，否则 fontconfig 可能把 CJK 渲染成方块 */
export function subtitleFont(): string {
  const current = platform()
  // 浏览器预览没有宿主桥（platform() 返回 unknown），按 UA 猜一个
  const mac = current === 'macos' || (current === 'unknown' && /Mac/.test(navigator.platform))
  if (mac) return 'PingFang SC'
  const win = current === 'windows' || (current === 'unknown' && /Win/.test(navigator.platform))
  if (win) return 'Microsoft YaHei'
  return 'Noto Sans CJK SC'
}
