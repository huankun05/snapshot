    // ─────
      SCREENSHOT_CLOUD_TRANSLATE_APPID_STORE_KEY,
      SCREENSHOT_CLOUD_TRANSLATE_SECRET_STORE_KEY,
      type ScreenshotEngine,
      type ScreenshotOcrEngine,
      type ScreenshotTranslateEngine,
    } from '../../shared/storeKeys';
    export {
    // ─────
      SCREENSHOT_CLOUD_TRANSLATE_APPID_STORE_KEY,
      SCREENSHOT_CLOUD_TRANSLATE_SECRET_STORE_KEY,
      type ScreenshotEngine,
      type ScreenshotOcrEngine,
      type ScreenshotTranslateEngine,
    };
    
    // ─────
    
    /** 截图快捷键存储键名 */
    export const SCREENSHOT_HOTKEY_STORE_KEY = 'screenshot-hotkey';
    
    /** 切歌快捷键存储键名 */
    // ─────
     * @returns 快捷键字符串
     */
    export function readScreenshotHotkeyConfig(): string {
      const data = readJsonFile(SCREENSHOT_HOTKEY_STORE_KEY);
      return typeof data === 'string' ? data : DEFAULT_SCREENSHOT_HOTKEY;
    // ─────
     * @returns 'plugin'（原生插件优先）或 'js'（JS 回退优先），默认 'plugin'
     */
    export function readScreenshotEngineConfig(): ScreenshotEngine {
      const data = readJsonFile(SCREENSHOT_ENGINE_STORE_KEY);
      return data === 'js' ? 'js' : 'plugin';
    // ─────
     * @returns 默认 'local'（本机 Tesseract 秒开，PaddleOCR 作为可选高精度档）
     */
    export function readScreenshotOcrEngineConfig(): ScreenshotOcrEngine {
      const data = readJsonFile(SCREENSHOT_OCR_ENGINE_STORE_KEY);
      if (data === 'paddleocr' || data === 'server' || data === 'local') return data;
    // ─────
     * @returns 默认 'local'（本机免费翻译，无需账号）
     */
    export function readScreenshotTranslateEngineConfig(): ScreenshotTranslateEngine {
      const data = readJsonFile(SCREENSHOT_TRANSLATE_ENGINE_STORE_KEY);
      return data === 'server' || data === 'cloud' ? data : 'local';
    }
    
    export type ScreenshotCloudTranslateConfig = { appId: string; secretKey: string };
    
    /**
     * 读取云端翻译（百度翻译通用版）凭据；任一为空返回 null（走本地引擎）
     */
    export function readScreenshotCloudTranslateConfig(): ScreenshotCloudTranslateConfig | null {
      const appId = readJsonFile(SCREENSHOT_CLOUD_TRANSLATE_APPID_STORE_KEY);
      const secretKey = readJsonFile(SCREENSHOT_CLOUD_TRANSLATE_SECRET_STORE_KEY);
    // ─────
     * @returns 路径字符串，留空表示使用 DEFAULT_LOCAL_OCR_DIR
     */
    export function readScreenshotLocalOcrDirConfig(): string {
      const data = readJsonFile(SCREENSHOT_LOCAL_OCR_DIR_STORE_KEY);
      return typeof data === 'string' && data.trim() ? data.trim() : DEFAULT_LOCAL_OCR_DIR;