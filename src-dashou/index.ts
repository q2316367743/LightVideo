import { definePluginApi } from '@dashou/core'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

/**
 * 后台脚本：所有碰得到文件系统的活儿都在这里做。
 *
 * 窗口是沙箱页面，用户从系统选择框里选中的路径也没有默认可读权限；
 * 而 core 的 Node 不受能力网关限制，所以路径计算、临时文件、写字幕、
 * 在文件夹中显示这些动作统一收在 core 里，窗口只拿结果。
 */

export interface PickedFile {
  path: string
  name: string
  size: number
}

export interface PickedFiles {
  files: PickedFile[]
}

export interface PickOptions {
  title?: string
  /** 文件类型名，如「视频文件」，只用于系统选择框的筛选描述 */
  label?: string
  extensions?: string[]
  multiple?: boolean
}

/** 预览帧走 data URL 回窗口，超过这个大小就当异常处理 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

let tempReady: Promise<string> | null = null
let seq = 0

function tempDirOf(temp: string): Promise<string> {
  if (tempReady === null) {
    tempReady = mkdir(temp, { recursive: true }).then(() => temp)
  }
  return tempReady
}

function plusSeq(): number {
  seq += 1
  return seq
}

/** 只保留安全的 ASCII 文件名，给 ffmpeg 滤镜参数用（中文 / 空格 / 冒号一律绕开） */
function safeName(name: string): string {
  const base = basename(name)
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[._]+/, '')
  return base === '' ? 'file' : base
}

function safeExt(ext: string): string {
  const value = ext.replace(/^\./, '').replace(/[^\w]/g, '').toLowerCase()
  return value === '' ? 'bin' : value
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 与源文件同目录的唯一输出名：video_slim.mp4 → video_slim_2.mp4，永不复用已有文件 */
async function uniqueOutput(input: string, suffix: string, ext: string): Promise<string> {
  const dir = dirname(input)
  const file = basename(input)
  const dot = file.lastIndexOf('.')
  const stem = dot > 0 ? file.slice(0, dot) : file
  const cleanExt = safeExt(ext)
  let candidate = join(dir, `${stem}${suffix}.${cleanExt}`)
  let n = 2
  while (await exists(candidate)) {
    candidate = join(dir, `${stem}${suffix}_${n}.${cleanExt}`)
    n += 1
  }
  return candidate
}

async function collectFiles(paths: string[]): Promise<PickedFile[]> {
  const files: PickedFile[] = []
  for (const path of paths) {
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      files.push({ path, name: basename(path), size: info.size })
    } catch {
      // 选完又删掉 / 没有权限：直接跳过，不打断整批导入
    }
  }
  return files
}

function revealInFolder(path: string): void {
  const done = (): void => {}
  if (process.platform === 'darwin') {
    execFile('open', ['-R', path], done)
    return
  }
  if (process.platform === 'win32') {
    execFile('explorer', [`/select,${path}`], done)
    return
  }
  execFile('xdg-open', [dirname(path)], done)
}

const plugin = definePluginApi({
  async onReady(ctx) {
    await tempDirOf(ctx.paths.temp)
    ctx.log('轻影已启动', 'info')
  },

  api: {
    /** 系统文件选择框；返回真实存在的文件（含大小），取消时为空数组 */
    async pick(ctx, args: PickOptions | undefined): Promise<PickedFiles> {
      const extensions = (args?.extensions ?? [])
        .map((item) => item.replace(/^\./, '').toLowerCase())
        .filter((item) => item !== '')
      const paths = await ctx.dialog.open({
        title: args?.title ?? '选择文件',
        multiple: args?.multiple !== false,
        filters:
          extensions.length > 0
            ? [{ name: args?.label ?? '文件', extensions }]
            : undefined
      })
      return { files: await collectFiles(paths) }
    },

    /** 与源视频同目录、带后缀、绝不覆盖已有文件 */
    async prepareOutput(
      _ctx,
      args: { input: string; suffix?: string; ext: string }
    ): Promise<{ path: string }> {
      return { path: await uniqueOutput(args.input, args.suffix ?? '', args.ext) }
    },

    /** 插件私有临时目录里的路径（预览帧、抽出的音频等） */
    async tempPath(ctx, args: { name: string }): Promise<{ path: string }> {
      const dir = await tempDirOf(ctx.paths.temp)
      return { path: join(dir, safeName(args.name)) }
    },

    /** 把素材复制到临时目录并改成安全 ASCII 名（字幕 / 水印等要被滤镜参数引用的文件） */
    async copyToTemp(ctx, args: { src: string; ext: string }): Promise<{ path: string }> {
      const dir = await tempDirOf(ctx.paths.temp)
      const dest = join(dir, `asset-${process.pid}-${plusSeq()}.${safeExt(args.ext)}`)
      await copyFile(args.src, dest)
      return { path: dest }
    },

    /** 写 concat 列表文件，返回路径 */
    async writeConcatList(ctx, args: { paths: string[] }): Promise<{ path: string }> {
      const dir = await tempDirOf(ctx.paths.temp)
      const content = args.paths
        .map((path) => `file '${path.replace(/'/g, "'\\''")}'`)
        .join('\n')
      const file = join(dir, `concat-${process.pid}-${plusSeq()}.txt`)
      await writeFile(file, `${content}\n`, 'utf8')
      return { path: file }
    },

    async fileSize(_ctx, args: { path: string }): Promise<{ size: number }> {
      try {
        const info = await stat(args.path)
        return { size: info.isFile() ? info.size : 0 }
      } catch {
        return { size: 0 }
      }
    },

    /** 读预览图 / 截图并转成 data URL：沙箱页面读不了本地文件 */
    async readImage(_ctx, args: { path: string }): Promise<{ dataUrl: string }> {
      let info
      try {
        info = await stat(args.path)
      } catch {
        throw new Error('图片已不存在，请重新生成预览。')
      }
      if (!info.isFile() || info.size === 0) throw new Error('图片生成失败，请重试。')
      if (info.size > MAX_IMAGE_BYTES) throw new Error('图片过大，无法预览。')
      const data = await readFile(args.path)
      const ext = extname(args.path).toLowerCase()
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png'
      return { dataUrl: `data:${mime};base64,${data.toString('base64')}` }
    },

    async writeText(_ctx, args: { path: string; content: string }): Promise<void> {
      await writeFile(args.path, args.content, 'utf8')
    },

    /** 失败 / 取消任务留下的半成品统一清理 */
    async removeFiles(_ctx, args: { paths: string[] }): Promise<void> {
      await Promise.all(
        args.paths.map(async (path) => {
          try {
            await unlink(path)
          } catch {
            // 文件本来就不在：忽略
          }
        })
      )
    },

    /** 在系统文件管理器中定位文件 */
    async reveal(_ctx, args: { path: string }): Promise<void> {
      revealInFolder(args.path)
    },

    /** ffmpeg 组件由宿主按需下载，这里只回报平台，供窗口选字体 */
    async platform(): Promise<{ platform: string }> {
      return { platform: process.platform }
    }
  }
})

export default plugin
export type Api = typeof plugin.api
