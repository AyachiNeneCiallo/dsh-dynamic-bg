/**
 * dsh-dynamic-bg —— 宿主侧（Node）半区。
 *
 * 客户端需要的 Wallpaper Engine 数据都由这里读盘并提供：
 *   1. 扫描 Steam 创意工坊 431960 目录，列出本机所有壁纸；
 *   2. 解析 scene.pkg（PKGV 容器），取出 scene.json 并整理成客户端能直接用的图层描述；
 *   3. 把 .tex 纹理解码成浏览器可直接上传的格式：
 *        - 内嵌 PNG 的原样直传（最快，本项目多数贴图如此）；
 *        - 否则按 TEXI 头的像素格式取原始数据，LZ4 压缩的先解压，再转成 RGBA8888。
 *
 * 只做只读操作，且所有读盘路径都限制在 `dir` 之内；除 webServer 外不接触其它服务，
 * 避免插件加载失败时把整个宿主带崩。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

export const name = 'dsh-dynamic-bg'
/** 只需要 webServer 一个服务；拿不到就不注册路由，插件其余部分照常。 */
export const inject = ['webServer']

const API_PREFIX = '/api/dsh-dynamic-bg'
const WE_APP_ID = '431960'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** 去掉可能的 BOM 后解析 JSON；失败返回 undefined。 */
function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

function basenameOf(p) {
  const parts = String(p).split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/* ------------------------------------------------------------------ */
/* PKGV 容器（scene.pkg）                                              */
/* ------------------------------------------------------------------ */

/**
 * 解析 Wallpaper Engine 的 pkg 容器。
 * 结构：int32 magicLen + magic("PKGV00xx") + int32 count +
 *       count 个 { int32 nameLen, name, int32 offset, int32 length } + 数据区。
 */
export function parsePkg(buf) {
  let pos = 0
  const magicLen = buf.readInt32LE(pos); pos += 4
  const magic = buf.toString('utf8', pos, pos + magicLen); pos += magicLen
  if (!magic.startsWith('PKGV')) throw new Error(`不是 Wallpaper Engine 的 pkg 容器（magic=${magic}）`)
  const count = buf.readInt32LE(pos); pos += 4
  const entries = new Map()
  for (let i = 0; i < count; i += 1) {
    const nameLen = buf.readInt32LE(pos); pos += 4
    const name = buf.toString('utf8', pos, pos + nameLen); pos += nameLen
    const offset = buf.readInt32LE(pos); pos += 4
    const length = buf.readInt32LE(pos); pos += 4
    entries.set(name, { offset, length })
  }
  return { entries, dataStart: pos }
}

function pkgEntryBuffer(pkg, name) {
  const entry = pkg.entries.get(name)
  if (entry === undefined) return undefined
  return pkg.buf.subarray(pkg.dataStart + entry.offset, pkg.dataStart + entry.offset + entry.length)
}

/* ------------------------------------------------------------------ */
/* LZ4 block 解压                                                      */
/* ------------------------------------------------------------------ */

/**
 * 解压 LZ4 block（无 frame 头的裸块格式，WE 的 .tex 用的就是它）。
 * @param {Buffer} src 压缩数据
 * @param {number} expected 期望的输出字节数
 */
export function lz4Decompress(src, expected) {
  const dst = Buffer.allocUnsafe(expected)
  let ip = 0
  let op = 0
  const end = src.length
  while (ip < end) {
    const token = src[ip]; ip += 1
    let literals = token >> 4
    if (literals === 15) {
      for (;;) {
        const b = src[ip]; ip += 1
        literals += b
        if (b !== 255) break
      }
    }
    if (literals > 0) {
      src.copy(dst, op, ip, ip + literals)
      ip += literals
      op += literals
    }
    if (ip >= end) break
    const offset = src[ip] | (src[ip + 1] << 8); ip += 2
    let match = token & 15
    if (match === 15) {
      for (;;) {
        const b = src[ip]; ip += 1
        match += b
        if (b !== 255) break
      }
    }
    match += 4
    let from = op - offset
    if (from < 0) break
    // 允许重叠拷贝，必须按字节走
    for (let k = 0; k < match; k += 1) {
      dst[op] = dst[from]
      op += 1
      from += 1
    }
  }
  return dst.subarray(0, Math.min(op, expected))
}

/* ------------------------------------------------------------------ */
/* .tex 解码                                                           */
/* ------------------------------------------------------------------ */

/**
 * 把 .tex 解码成浏览器可直接使用的纹理。
 * @returns {{ encoding:'png'|'rgba', width:number, height:number, data:Buffer }}
 */
export function decodeTex(buf) {
  const texI = buf.indexOf(Buffer.from('TEXI0001'))
  const texB = buf.indexOf(Buffer.from('TEXB0003'))
  if (texI < 0 || texB < 0) throw new Error('不是 Wallpaper Engine 的 .tex 文件')

  // TEXI 头：magic(8) + 1 个填充字节 + format/flags/width/height/width2/height2
  const format = buf.readInt32LE(texI + 9)

  // TEXB 体：magic(8) + 1 个填充字节 + imagesCount/mipMarker/one/width/height/one2/uncompressed/stored
  const body = texB + 9
  const width = buf.readInt32LE(body + 12)
  const height = buf.readInt32LE(body + 16)
  const uncompressed = buf.readInt32LE(body + 24)
  const stored = buf.readInt32LE(body + 28)
  const data = buf.subarray(body + 32, body + 32 + stored)

  // 情况一：贴图本身是内嵌 PNG，直接原样交给浏览器（4K 图也几乎零成本）
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { encoding: 'png', width, height, data }
  }

  // 其余情况拿到原始像素：stored == uncompressed 时未压缩，否则是 LZ4
  const raw = uncompressed === 0 || uncompressed === stored
    ? data
    : lz4Decompress(data, uncompressed)

  if (format === 0 && raw.length >= width * height * 4) {
    return { encoding: 'rgba', width, height, data: raw.subarray(0, width * height * 4) }
  }
  return { encoding: 'rgba', width, height, data: expandToRgba(raw, width, height, format) }
}

/** 把 R8 / RG88 / R16 之类展开成 RGBA8888，客户端就不用关心这些细节。 */
function expandToRgba(raw, width, height, format) {
  const px = width * height
  const out = Buffer.allocUnsafe(px * 4)
  if ((format === 8 || format === 7) && raw.length >= px * 2) {
    // RG88：水流朝向贴图，用 .rg
    for (let i = 0; i < px; i += 1) {
      out[i * 4] = raw[i * 2]
      out[i * 4 + 1] = raw[i * 2 + 1]
      out[i * 4 + 2] = 0
      out[i * 4 + 3] = 255
    }
    return out
  }
  if (format === 9 && raw.length >= px) {
    // R8：遮罩，客户端按 .r 采样
    for (let i = 0; i < px; i += 1) {
      out[i * 4] = raw[i]
      out[i * 4 + 1] = 0
      out[i * 4 + 2] = 0
      out[i * 4 + 3] = 255
    }
    return out
  }
  if (format === 15 && raw.length >= px * 2) {
    for (let i = 0; i < px; i += 1) {
      const v = Math.round((raw.readUInt16LE(i * 2) / 65535) * 255)
      out[i * 4] = v
      out[i * 4 + 1] = 0
      out[i * 4 + 2] = 0
      out[i * 4 + 3] = 255
    }
    return out
  }
  // 兜底：按 RGBA 逐字节尽力而为
  const n = Math.min(px * 4, raw.length)
  raw.copy(out, 0, 0, n)
  for (let i = Math.floor(n / 4) * 4; i < px * 4; i += 1) out[i] = i % 4 === 3 ? 255 : 0
  return out
}

/* ------------------------------------------------------------------ */
/* Steam 创意工坊发现                                                  */
/* ------------------------------------------------------------------ */

function vdfPaths(text) {
  const out = []
  const re = /"path"\s*"([^"]+)"/gi
  let m = re.exec(text)
  while (m !== null) {
    out.push(m[1].replace(/\\\\/g, '\\'))
    m = re.exec(text)
  }
  return out
}

/** 找出本机所有 Steam 库根目录（含多盘/多库）。 */
export function steamLibraries() {
  const roots = new Set()
  for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    for (const tail of ['Steam', 'Program Files (x86)\\Steam', 'Program Files\\Steam', 'Games\\Steam', 'SteamLibrary']) {
      const p = `${drive}:\\${tail}`
      if (existsSync(join(p, 'steamapps'))) roots.add(p)
    }
  }
  // 再顺着 libraryfolders.vdf 把其它库拉进来
  for (const root of [...roots]) {
    for (const rel of ['steamapps\\libraryfolders.vdf', 'config\\libraryfolders.vdf']) {
      const file = join(root, rel)
      if (!existsSync(file)) continue
      try {
        for (const p of vdfPaths(readFileSync(file, 'utf8'))) roots.add(p)
      } catch {
        /* 单个 vdf 坏了不影响其它库 */
      }
    }
  }
  return [...roots].filter((p) => existsSync(p))
}

/** 列出所有创意工坊壁纸目录及其 project.json 元数据。 */
export function scanWallpapers() {
  const out = []
  const seen = new Set()
  for (const lib of steamLibraries()) {
    const contentDir = join(lib, 'steamapps', 'workshop', 'content', WE_APP_ID)
    if (!existsSync(contentDir)) continue
    let ids = []
    try {
      ids = readdirSync(contentDir)
    } catch {
      continue
    }
    for (const id of ids) {
      const dir = join(contentDir, id)
      if (seen.has(dir)) continue
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const project = readJsonFile(join(dir, 'project.json'))
      if (project === undefined) continue
      seen.add(dir)
      const type = typeof project.type === 'string' ? project.type : 'scene'
      const file = typeof project.file === 'string' ? project.file : ''
      out.push({
        id,
        dir,
        title: typeof project.title === 'string' && project.title !== '' ? project.title : id,
        type,
        preview: typeof project.preview === 'string' ? project.preview : '',
        scene: type.toLowerCase() === 'scene' && existsSync(join(dir, 'scene.pkg')),
      })
    }
  }
  out.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  return out
}

/* ------------------------------------------------------------------ */
/* scene.pkg -> 客户端图层描述                                         */
/* ------------------------------------------------------------------ */

/** 把 "3840.00000 2160.00000" 之类拆成 [w, h]。 */
function nums(text) {
  if (typeof text !== 'string') return []
  const out = []
  for (const p of text.trim().split(/\s+/)) {
    const n = Number(p)
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/** 材质里引用的贴图名（"mama_bg"）解析成 pkg 内的完整条目名。 */
function resolveTextureName(pkg, base) {
  const cleaned = String(base).replace(/^materials\//, '').replace(/\.tex$/, '')
  for (const t of [`materials/${cleaned}.tex`, `materials/${cleaned}`, `${cleaned}.tex`, cleaned]) {
    if (pkg.entries.has(t)) return t
  }
  return undefined
}

/**
 * 把 scene.json 解析成客户端可渲染的图层列表。
 * 只保留「一张贴图 + 若干可移植着色器效果」这种结构，其余记进 unsupported。
 */
export function buildSceneGraph(pkg, dir) {
  const sceneBuf = pkgEntryBuffer(pkg, 'scene.json')
  if (sceneBuf === undefined) throw new Error('scene.pkg 里没有 scene.json')
  const scene = JSON.parse(sceneBuf.toString('utf8').replace(/^\uFEFF/, ''))

  const readPkgJson = (name) => {
    const b = pkgEntryBuffer(pkg, name)
    if (b === undefined) return undefined
    try {
      return JSON.parse(b.toString('utf8').replace(/^\uFEFF/, ''))
    } catch {
      return undefined
    }
  }

  const ortho = scene.general?.orthogonalprojection
  const width = ortho?.width ?? 3840
  const height = ortho?.height ?? 2160

  const layers = []
  const unsupported = []

  for (const object of scene.objects ?? []) {
    if (typeof object.image !== 'string') {
      unsupported.push({ kind: 'object', name: object.name ?? '' })
      continue
    }
    const model = readPkgJson(object.image)
    const material = model?.material ? readPkgJson(model.material) : undefined
    const pass = material?.passes?.[0]
    const texBase = Array.isArray(pass?.textures) ? pass.textures[0] : undefined
    if (typeof texBase !== 'string') {
      unsupported.push({ kind: 'layer', name: object.name ?? object.image })
      continue
    }
    const texture = resolveTextureName(pkg, texBase)
    if (texture === undefined) {
      unsupported.push({ kind: 'texture', name: texBase })
      continue
    }

    const effects = []
    for (const effect of object.effects ?? []) {
      if (typeof effect.file !== 'string') continue
      // 用户在 project.json 里关掉的效果不启用
      if (effect.visible !== undefined && effect.visible !== null && effect.visible.value === false) continue
      const effectJson = readPkgJson(effect.file)
      const effectMaterialPath = effectJson?.passes?.[0]?.material
      const effectMaterial = effectMaterialPath ? readPkgJson(effectMaterialPath) : undefined
      const shader = effectMaterial?.passes?.[0]?.shader
      if (typeof shader !== 'string') continue
      const shaderName = shader.replace(/^shaders\//, '')
      const effectPass = Array.isArray(effect.passes) ? effect.passes[0] : undefined
      const constants = effectPass?.constantshadervalues ?? {}
      const passTextures = Array.isArray(effectPass?.textures) ? effectPass.textures : []

      // 目前客户端实现了水流（waterflow）：需要「朝向图」+「相位图」
      if (shaderName === 'effects/waterflow') {
        effects.push({
          shader: 'waterflow',
          mask: typeof passTextures[1] === 'string' ? resolveTextureName(pkg, passTextures[1]) : undefined,
          phase: typeof passTextures[2] === 'string' ? resolveTextureName(pkg, passTextures[2]) : undefined,
          speed: Number(constants.speed ?? 1),
          strength: Number(constants.strength ?? 1),
          phaseScale: Number(constants.phasescale ?? 2),
        })
      }

      // 摆叶/发丝摆动（foliagesway）：需要一张遮罩，噪声用着色器内的程序化噪声替代
      if (shaderName === 'effects/foliagesway') {
        effects.push({
          shader: 'foliagesway',
          mask: typeof passTextures[1] === 'string' ? resolveTextureName(pkg, passTextures[1]) : undefined,
          strength: Number(constants.strength ?? 0.4),
          speed: Number(constants.speeduv ?? 5),
          phase: Number(constants.phase ?? 0.5),
          power: Number(constants.power ?? 1),
          ratio: Number(constants.ratio ?? 0.3),
          scale: Number(constants.scale ?? 0.05),
          direction: Number(constants.scrolldirection ?? 0),
        })
      }
    }

    const size = nums(object.size)
    const origin = nums(object.origin)
    layers.push({
      name: object.name ?? object.image,
      texture,
      width: size[0] ?? width,
      height: size[1] ?? height,
      originX: origin[0] ?? width / 2,
      originY: origin[1] ?? height / 2,
      effects,
    })
  }

  return { kind: 'scene', title: basenameOf(dir), width, height, layers, unsupported }
}

/* ------------------------------------------------------------------ */
/* 缓存与路由                                                          */
/* ------------------------------------------------------------------ */

const pkgCache = new Map()
const texCache = new Map()
const TEX_CACHE_LIMIT = 24

function loadPkg(dir) {
  const file = join(dir, 'scene.pkg')
  const st = statSync(file)
  const cached = pkgCache.get(dir)
  if (cached !== undefined && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached
  const buf = readFileSync(file)
  const record = { mtimeMs: st.mtimeMs, size: st.size, buf, ...parsePkg(buf) }
  pkgCache.set(dir, record)
  return record
}

function assertWallpaperDir(dir) {
  if (typeof dir !== 'string' || dir === '') throw new Error('缺少 dir 参数')
  if (!isAbsolute(dir)) throw new Error('dir 必须是绝对路径')
  if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`)
  const project = readJsonFile(join(dir, 'project.json'))
  if (project === undefined || !existsSync(join(dir, 'scene.pkg'))) {
    throw new Error('这不是一个 Wallpaper Engine 场景壁纸目录（缺少 project.json 或 scene.pkg）')
  }
  return project
}

function servePreview(res, dir, project) {
  const name = typeof project.preview === 'string' ? project.preview : ''
  const file = name === '' ? '' : resolve(dir, name)
  if (file === '' || !file.startsWith(resolve(dir) + sep) || !existsSync(file)) {
    sendJson(res, 404, { error: '没有预览图' })
    return
  }
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
  res.statusCode = 200
  res.setHeader('content-type', ext === '.gif' ? 'image/gif' : ext === '.png' ? 'image/png' : 'image/jpeg')
  res.setHeader('cache-control', 'public, max-age=600')
  res.end(readFileSync(file))
}

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: async (req, res) => {
            const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
            const route = url.pathname.slice(API_PREFIX.length) || '/'
            const dir = url.searchParams.get('dir') ?? ''
            const name = url.searchParams.get('name') ?? ''

            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.statusCode = 405
              res.end()
              return
            }

            try {
              if (route === '/scan') {
                sendJson(res, 200, { wallpapers: scanWallpapers() })
                return
              }

              if (route === '/preview') {
                servePreview(res, dir, assertWallpaperDir(dir))
                return
              }

              if (route === '/scene') {
                const project = assertWallpaperDir(dir)
                const graph = buildSceneGraph(loadPkg(dir), dir)
                sendJson(res, 200, {
                  ...graph,
                  title: typeof project.title === 'string' && project.title !== '' ? project.title : graph.title,
                  project: {
                    title: project.title ?? '',
                    description: project.description ?? '',
                    preview: typeof project.preview === 'string' ? project.preview : '',
                  },
                })
                return
              }

              if (route === '/asset') {
                assertWallpaperDir(dir)
                const cacheKey = `${dir}|${name}`
                let decoded = texCache.get(cacheKey)
                if (decoded === undefined) {
                  const entry = pkgEntryBuffer(loadPkg(dir), name)
                  if (entry === undefined) throw new Error(`pkg 里没有 ${name}`)
                  decoded = decodeTex(Buffer.from(entry))
                  if (texCache.size >= TEX_CACHE_LIMIT) texCache.delete(texCache.keys().next().value)
                  texCache.set(cacheKey, decoded)
                }
                res.statusCode = 200
                res.setHeader('content-type', 'application/octet-stream')
                res.setHeader('x-we-encoding', decoded.encoding)
                res.setHeader('x-we-width', String(decoded.width))
                res.setHeader('x-we-height', String(decoded.height))
                res.setHeader('cache-control', 'public, max-age=3600')
                if (req.method === 'HEAD') {
                  res.end()
                  return
                }
                res.end(decoded.data)
                return
              }

              sendJson(res, 404, { error: `未知路由 ${route}` })
            } catch (error) {
              sendJson(res, 400, { error: String(error?.message ?? error) })
            }
          },
        }),
      'dsh-dynamic-bg: Wallpaper Engine 资源接口',
    )
  })
}
