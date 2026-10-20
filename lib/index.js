/**
 * dsh-dynamic-bg —— 宿主侧（Node）半区。
 *
 * 本插件不需要任何宿主服务：视频由用户在浏览器里用文件选择器挑选，
 * 存在浏览器 IndexedDB 中，由 client.js 直接渲染为全屏背景。
 *
 * 这里刻意不触碰 ctx 上的任何服务（webServer / connection / ...），
 * 因为 cordis 要求先 inject 才能取用，误取会直接让整个宿主启动失败。
 */
export function apply() {
  // no-op：插件完全由客户端半区工作。
}
