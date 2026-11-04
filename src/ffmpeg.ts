import { invoke, listen, type UnlistenFn } from '@dashou/api'

/**
 * 宿主 ffmpeg 能力的最小封装。
 *
 * 宿主自带的 `runFfmpeg()` 只 resolve 进程结束、不给退出码，也没暴露 runId，
 * 而任务成败要靠退出码判断；这里直接走 `plugin:ffmpeg|*` 命令 + 原始事件，
 * 拿到 runId / code / stderr，并负责在结束时退订。
 *
 * 首次调用时宿主会先下载 ffmpeg 运行时（约 45MB，带不可关闭的进度窗口）。
 */

export interface FfmpegProgress {
  /** 已处理秒数 */
  seconds: number
  /** 0-100；总时长未知时为 -1 */
  percent: number
  speed: string
  /** 输出文件已写入的字节数 */
  size: number
  /** 预计剩余秒数；无法估算时为 -1 */
  eta: number
}

export interface FfmpegResult {
  code: number
  /** 完整 stderr（探测元信息用） */
  logs: string
  /** stderr 末尾，报错给用户看 */
  tail: string
}

export interface FfmpegHandle {
  done: Promise<FfmpegResult>
  /** 强制结束；返回是否真的发出了结束请求 */
  kill: () => Promise<boolean>
}

interface HostProgressPayload {
  runId?: unknown
  time?: unknown
  speed?: unknown
  size?: unknown
}

interface HostExitPayload {
  runId?: unknown
  code?: unknown
}

interface HostLogPayload {
  runId?: unknown
  text?: unknown
}

const MAX_LOG_BYTES = 256 * 1024

/** "00:01:02.500000" -> 秒；"N/A" 等无法解析的值返回 0 */
function timecodeSeconds(value: string): number {
  const parts = value.trim().split(':')
  if (parts.length !== 3) return 0
  const [h, m, s] = parts.map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return 0
  return h * 3600 + m * 60 + s
}

/**
 * 启动一个 ffmpeg 进程。
 * @param totalUs 预期总时长（微秒），0 表示进度不可估算
 */
export function startFfmpeg(
  args: string[],
  totalUs: number,
  onProgress?: (progress: FfmpegProgress) => void
): FfmpegHandle {
  let runId = ''
  let finished = false
  let killRequested = false
  let logs = ''
  let tail = ''
  const unlisteners: UnlistenFn[] = []
  const pending: Array<{ name: string; payload: Record<string, unknown> }> = []

  let resolveDone: (result: FfmpegResult) => void = () => {}
  let rejectDone: (error: unknown) => void = () => {}
  const done = new Promise<FfmpegResult>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const cleanup = (): void => {
    for (const off of unlisteners.splice(0)) off()
    pending.length = 0
  }

  const handleEvent = (name: string, payload: Record<string, unknown>): void => {
    if (finished) return
    if (name === 'ffmpeg:progress') {
      const seconds = timecodeSeconds(typeof payload.time === 'string' ? payload.time : '')
      const speed = typeof payload.speed === 'string' ? payload.speed.trim() : ''
      const size = Number(payload.size) || 0
      const speedValue = Number.parseFloat(speed)
      const totalSeconds = totalUs / 1e6
      const percent =
        totalSeconds > 0 ? Math.min((seconds / totalSeconds) * 100, 99.9) : -1
      const eta =
        totalSeconds > 0 && Number.isFinite(speedValue) && speedValue > 0
          ? Math.max(0, Math.round((totalSeconds - seconds) / speedValue))
          : -1
      onProgress?.({ seconds, percent, speed, size, eta })
      return
    }
    if (name === 'ffmpeg:log') {
      const text = typeof payload.text === 'string' ? payload.text : ''
      if (text === '') return
      if (logs.length < MAX_LOG_BYTES) logs += text
      tail = (tail + text).slice(-2000)
      return
    }
    if (name === 'ffmpeg:exit') {
      finished = true
      cleanup()
      resolveDone({
        code: typeof payload.code === 'number' ? payload.code : -1,
        logs,
        tail: tail.trim()
      })
    }
  }

  const receive = (name: string, payload: unknown): void => {
    const record =
      payload !== null && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {}
    if (runId === '') {
      pending.push({ name, payload: record })
      return
    }
    if (record.runId !== runId) return
    handleEvent(name, record)
  }

  const start = async (): Promise<void> => {
    try {
      unlisteners.push(
        await listen<HostProgressPayload>('ffmpeg:progress', (event) =>
          receive('ffmpeg:progress', event.payload)
        ),
        await listen<HostLogPayload>('ffmpeg:log', (event) =>
          receive('ffmpeg:log', event.payload)
        ),
        await listen<HostExitPayload>('ffmpeg:exit', (event) =>
          receive('ffmpeg:exit', event.payload)
        )
      )
      const result = await invoke<{ runId: string }>('plugin:ffmpeg|run', {
        args,
        cwd: ''
      })
      runId = result.runId
      // 取消可能发生在运行时下载期间（那时还没有 runId）：拿到后立刻补一刀
      if (killRequested) void invoke('plugin:ffmpeg|kill', { runId })
      for (const item of pending.splice(0)) {
        if (item.payload.runId !== runId) continue
        handleEvent(item.name, item.payload)
      }
    } catch (error) {
      finished = true
      cleanup()
      rejectDone(error)
    }
  }

  void start()

  return {
    done,
    kill: async (): Promise<boolean> => {
      if (finished) return false
      if (runId === '') {
        // 还在下载运行时：先记下来，进程一起来就结束它
        killRequested = true
        return true
      }
      try {
        return await invoke<boolean>('plugin:ffmpeg|kill', { runId })
      } catch {
        return false
      }
    }
  }
}
