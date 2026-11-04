/** 一个媒体文件的基础信息（探测结果） */
export interface MediaInfo {
  path: string
  name: string
  size: number
  duration: number
  width: number
  height: number
  codec: string
  audioCodec: string
  error: string
}

/** 每个工具各自的参数表；工具之间结构不同，统一按字典处理 */
export type Settings = Record<string, any>

export interface Progress {
  percent: number
  speed: string
  outSize: number
  eta: number
}

export interface Killable {
  kill: () => Promise<boolean>
}

export interface RunContext {
  setStage: (text: string) => void
  onProgress: (percent: number) => void
  setChild: (child: Killable | null) => void
  cancelled: () => boolean
  outPath: (suffix: string, ext: string) => Promise<string>
}

export interface ToolField {
  key: string
  type: 'range' | 'segmented' | 'time' | 'file'
  label: string | ((s: Settings) => string)
  hint?: (s: Settings) => string
  min?: number
  max?: number
  options?: Array<{ value: string | number; label: string }>
  placeholder?: string
  showIf?: (s: Settings) => boolean
  pickTitle?: string
  filterName?: string
  exts?: string[]
}

export interface BuildOutput {
  suffix: string
  ext: string
}

export interface Tool {
  id: string
  group: string
  name: string
  desc: string
  icon: string
  action: string
  /** 完成卡片上显示压缩前后体积对比 */
  compare?: boolean
  /** 多文件按顺序合并成一个任务 */
  multiInput?: boolean
  /** 'media' = 音频 + 视频都收；默认只收视频 */
  accept?: 'media'
  defaults: Settings
  fields: ToolField[]
  output?: (item: MediaInfo, s: Settings) => BuildOutput
  totalUs?: (item: MediaInfo, s: Settings) => number
  validate?: (item: MediaInfo, s: Settings) => string | undefined
  buildArgs?: (item: MediaInfo, s: Settings, out: string) => string[] | Promise<string[]>
  /** 两遍编码之类需要串行跑多条命令 */
  buildSteps?: (item: MediaInfo, s: Settings, out: string) => string[][]
  previewArgs?: (item: MediaInfo, s: Settings, png: string) => string[] | Promise<string[]>
  /** 拖入文件后的额外校验（默认要求有视频画面） */
  check?: (info: MediaInfo) => string
  cleanup?: (out: string) => string[]
  canCopy?: (sources: MediaInfo[]) => boolean
  outputMulti?: (sources: MediaInfo[]) => BuildOutput
  totalUsMulti?: (sources: MediaInfo[]) => number
  validateMulti?: (sources: MediaInfo[]) => string | undefined
  buildArgsMulti?: (sources: MediaInfo[], out: string) => Promise<string[]>
}

export type ItemStatus = 'ready' | 'queued' | 'running' | 'done' | 'error' | 'cancelled'

/** 队列里的一行，文件任务与「合并任务」共用 */
export interface QueueItem extends MediaInfo {
  uid: number
  toolId: string
  status: ItemStatus
  message: string
  percent: number
  speed: string
  eta: number
  inSize: number
  outSize: number
  output: string
  seconds: number
  child: Killable | null
  isJob: boolean
  sources?: MediaInfo[]
  settings?: Settings
  metaText?: string
  stageText?: string
}
