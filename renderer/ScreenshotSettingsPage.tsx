/*
 * eIsland - A sleek, Apple Dynamic Island inspired floating widget for Windows, built with Electron.
 * https://github.com/JNTMTMTM/eIsland
 *
 * Copyright (C) 2026 JNTMTMTM
 * Copyright (C) 2026 pyisland.com
 *
 * Original author: JNTMTMTM[](https://github.com/JNTMTMTM)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 */

/**
 * @file ScreenshotSettingsPage.tsx
 * @description 设置页面 - 软件设置截图设置子界面
 * @author 鸡哥
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { SvgIcon, ServiceIcon } from '../../../../../../../../utils/SvgIcon';
import { resolveCountryIcon } from '../../../../../../../../utils/SvgIcon/country-icon';
import { TRANSLATE_LANGUAGES, TRANSLATE_TARGET_LANGUAGES } from '../../../../tools/config/translateToolConfig';
import {
  SCREENSHOT_TRANSLATE_SOURCE_LANG_STORE_KEY,
  SCREENSHOT_TRANSLATE_TARGET_LANG_STORE_KEY,
  SCREENSHOT_ENGINE_STORE_KEY,
  SCREENSHOT_OCR_ENGINE_STORE_KEY,
  SCREENSHOT_TRANSLATE_ENGINE_STORE_KEY,
  SCREENSHOT_LOCAL_OCR_DIR_STORE_KEY,
  SCREENSHOT_CLOUD_TRANSLATE_APPID_STORE_KEY,
  SCREENSHOT_CLOUD_TRANSLATE_SECRET_STORE_KEY,
} from '../../../config/settingsTabConfig';

/** 翻译语言选项 */
interface LangOption {
  readonly code: string;
  readonly labelKey: string;
}

/**
 * 翻译语言下拉选择器
 * @param options - 可选语言列表
 * @param value - 当前选中的语言代码
 * @param onChange - 语言变更回调
 */
function TranslateLangDropdown({
  options,
  value,
  onChange,
}: {
  options: readonly LangOption[];
  value: string;
  onChange: (code: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const selected = options.find((o) => o.code === value);
  const selectedFlag = resolveCountryIcon(value);
  const selectedIcon = selectedFlag ?? (value === 'auto' ? SvgIcon.AI : undefined);

  return (
    <div className="translate-lang-dropdown" ref={wrapperRef}>
      <button
        type="button"
        className="translate-lang-dropdown-trigger"
        onClick={() => setOpen((prev) => !prev)}
      >
        {selectedIcon ? (
          <img
            className={selectedFlag ? 'translate-lang-flag no-filter' : 'translate-lang-ai-icon'}
            src={selectedIcon}
            alt=""
            draggable={false}
          />
        ) : (
          <span className="translate-lang-flag-placeholder" />
        )}
        <span className="translate-lang-dropdown-label">
          {selected ? t(selected.labelKey) : value}
        </span>
        <span className="translate-lang-dropdown-arrow">▾</span>
      </button>
      {open && (
        <div className="translate-lang-dropdown-menu">
          {options.map((lang) => {
            const flag = resolveCountryIcon(lang.code);
            const icon = flag ?? (lang.code === 'auto' ? SvgIcon.AI : undefined);
            return (
              <button
                key={lang.code}
                type="button"
                className={`translate-lang-dropdown-item ${lang.code === value ? 'active' : ''}`}
                onClick={() => {
                  onChange(lang.code);
                  setOpen(false);
                }}
              >
                {icon ? (
                  <img
                    className={flag ? 'translate-lang-flag no-filter' : 'translate-lang-ai-icon'}
                    src={icon}
                    alt=""
                    draggable={false}
                  />
                ) : (
                  <span className="translate-lang-flag-placeholder" />
                )}
                <span>{t(lang.labelKey)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 渲染截图设置页面
 * @returns 截图设置页面
 */
export function ScreenshotSettingsPage(): ReactElement {
  const { t } = useTranslation();
  const [sourceLang, setSourceLang] = useState('auto');
  const [targetLang, setTargetLang] = useState('en');
  const [screenshotEngine, setScreenshotEngine] = useState<'plugin' | 'js'>('plugin');
  const [ocrEngine, setOcrEngine] = useState<'local' | 'paddleocr' | 'server'>('local');
  const [translateEngine, setTranslateEngine] = useState<'local' | 'cloud' | 'server'>('local');
  const [cloudTranslateAppId, setCloudTranslateAppId] = useState('');
  const [cloudTranslateSecret, setCloudTranslateSecret] = useState('');
  const [localOcrDir, setLocalOcrDir] = useState('');

  useEffect(() => {
    let cancelled = false;
    window.api.storeRead(SCREENSHOT_TRANSLATE_SOURCE_LANG_STORE_KEY).then((value) => {
      if (cancelled || typeof value !== 'string') return;
      setSourceLang(value);
    }).catch(() => {});
    window.api.storeRead(SCREENSHOT_TRANSLATE_TARGET_LANG_STORE_KEY).then((value) => {
      if (cancelled || typeof value !== 'string') return;
      setTargetLang(value);
    }).catch(() => {});
    window.api.storeRead(SCREENSHOT_ENGINE_STORE_KEY).then((value) => {
      if (cancelled) return;
      setScreenshotEngine(value === 'js' ? 'js' : 'plugin');
    }).catch(() => {});
    window.api.storeRead(SCREENSHOT_OCR_ENGINE_STORE_KEY).then((value) => {
      if (cancelled) return;
      setOcrEngine(value === 'paddleocr' || value === 'server' ? value : 'local');
    }).catch(() => {});
    window.api.storeRead(SCREENSHOT_TRANSLATE_ENGINE_STORE_KEY).then((value) => {
      if (cancelled) return;
      setTranslateEngine(value === 'server' || value === 'cloud' ? value : 'local');
    }).catch(() => {});
    window.api.storeRead(SCREENSHOT_CLOUD_TRANSLATE_APPID_STORE_KEY).then((value) => {
      if (cancelled || typeof value !== 'string') return;
      setCloudTranslateAppId(value);
    }).catch(() => {});
    window.api.storeRead(SCREENSHOT_CLOUD_TRANSLATE_SECRET_STORE_KEY).then((value) => {
      if (cancelled || typeof value !== 'string') return;
      setCloudTranslateSecret(value);
    }).catch(() => {});
    window.api.storeRead(SCREENSHOT_LOCAL_OCR_DIR_STORE_KEY).then((value) => {
      if (cancelled || typeof value !== 'string') return;
      setLocalOcrDir(value);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSourceLangChange = (code: string): void => {
    setSourceLang(code);
    void window.api.storeWrite(SCREENSHOT_TRANSLATE_SOURCE_LANG_STORE_KEY, code);
  };

  const handleTargetLangChange = (code: string): void => {
    setTargetLang(code);
    void window.api.storeWrite(SCREENSHOT_TRANSLATE_TARGET_LANG_STORE_KEY, code);
  };

  const handleScreenshotEngineChange = (engine: 'plugin' | 'js'): void => {
    setScreenshotEngine(engine);
    void window.api.storeWrite(SCREENSHOT_ENGINE_STORE_KEY, engine);
  };

  const handleOcrEngineChange = (engine: 'local' | 'paddleocr' | 'server'): void => {
    setOcrEngine(engine);
    void window.api.storeWrite(SCREENSHOT_OCR_ENGINE_STORE_KEY, engine);
  };

  const handleTranslateEngineChange = (engine: 'local' | 'cloud' | 'server'): void => {
    setTranslateEngine(engine);
    void window.api.storeWrite(SCREENSHOT_TRANSLATE_ENGINE_STORE_KEY, engine);
  };

  const handleCloudTranslateAppIdChange = (value: string): void => {
    setCloudTranslateAppId(value);
    void window.api.storeWrite(SCREENSHOT_CLOUD_TRANSLATE_APPID_STORE_KEY, value);
  };

  const handleCloudTranslateSecretChange = (value: string): void => {
    setCloudTranslateSecret(value);
    void window.api.storeWrite(SCREENSHOT_CLOUD_TRANSLATE_SECRET_STORE_KEY, value);
  };

  const handleLocalOcrDirChange = (path: string): void => {
    setLocalOcrDir(path);
    void window.api.storeWrite(SCREENSHOT_LOCAL_OCR_DIR_STORE_KEY, path);
  };

  return (
    <div className="settings-screenshot-page-panel">
      <div className="settings-cards">
        <div className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              {t('settings.app.screenshotSettings.engineTitle', { defaultValue: '截图引擎' })}
            </div>
            <div className="settings-card-subtitle">
              {t('settings.app.screenshotSettings.engineHint', { defaultValue: '选择截图使用的引擎。插件模式支持多显示器截图，JS 模式兼容性更好。' })}
            </div>
          </div>
          <div className="settings-card-inline-row">
            <label className="settings-card-check">
              <input
                type="radio"
                name="screenshot-engine"
                checked={screenshotEngine === 'plugin'}
                onChange={() => { handleScreenshotEngineChange('plugin'); }}
              />
              {t('settings.app.screenshotSettings.enginePlugin', { defaultValue: '插件模式' })}
            </label>
            <label className="settings-card-check">
              <input
                type="radio"
                name="screenshot-engine"
                checked={screenshotEngine === 'js'}
                onChange={() => { handleScreenshotEngineChange('js'); }}
              />
              {t('settings.app.screenshotSettings.engineJs', { defaultValue: 'JS 模式' })}
            </label>
          </div>
        </div>
        <div className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              {t('settings.app.screenshotSettings.ocrEngineTitle')}
            </div>
            <div className="settings-card-subtitle">
              {t('settings.app.screenshotSettings.ocrEngineHint')}
            </div>
          </div>
          <div className="settings-card-inline-row">
            <label className="settings-card-check">
              <input
                type="radio"
                name="screenshot-ocr-engine"
                checked={ocrEngine === 'local'}
                onChange={() => { handleOcrEngineChange('local'); }}
              />
              {t('settings.app.screenshotSettings.ocrEngineLocal', { defaultValue: '本机 Tesseract（秒开）' })}
            </label>
            <label className="settings-card-check" style={{ whiteSpace: 'nowrap' }}>
              <input
                type="radio"
                name="screenshot-ocr-engine"
                checked={ocrEngine === 'paddleocr'}
                onChange={() => { handleOcrEngineChange('paddleocr'); }}
              />
              {t('settings.app.screenshotSettings.ocrEnginePaddle', { defaultValue: '本机 PaddleOCR（高精度）' })}
            </label>
            <label className="settings-card-check" style={{ whiteSpace: 'nowrap' }}>
              <input
                type="radio"
                name="screenshot-ocr-engine"
                checked={ocrEngine === 'server'}
                onChange={() => { handleOcrEngineChange('server'); }}
              />
              <img className="settings-inline-icon" src={ServiceIcon.ALIBABACLOUD} alt="" />
              <img className="settings-inline-icon" src={SvgIcon.PRO} alt="" />
              {t('settings.app.screenshotSettings.ocrEngineServer', { defaultValue: '服务端（需会员）' })}
            </label>
          </div>
        </div>
        <div className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              {t('settings.app.screenshotSettings.translateEngineTitle', { defaultValue: '截图翻译引擎' })}
            </div>
            <div className="settings-card-subtitle">
              {t('settings.app.screenshotSettings.translateEngineHint', { defaultValue: '本机 Hy-MT2：免费、离线、无需账号；云端百度翻译：免费额度、速度快；服务端：需作者 Pro 账号。' })}
            </div>
          </div>
          <div className="settings-card-inline-row">
            <label className="settings-card-check">
              <input
                type="radio"
                name="screenshot-translate-engine"
                checked={translateEngine === 'local'}
                onChange={() => { handleTranslateEngineChange('local'); }}
              />
              {t('settings.app.screenshotSettings.translateEngineLocal', { defaultValue: '本机 Hy-MT2（免费离线）' })}
            </label>
            <label className="settings-card-check" style={{ whiteSpace: 'nowrap' }}>
              <input
                type="radio"
                name="screenshot-translate-engine"
                checked={translateEngine === 'cloud'}
                onChange={() => { handleTranslateEngineChange('cloud'); }}
              />
              <img className="settings-inline-icon" src={ServiceIcon.ALIBABACLOUD} alt="" />
              {t('settings.app.screenshotSettings.translateEngineCloud', { defaultValue: '云端百度翻译（免费额度）' })}
            </label>
            <label className="settings-card-check" style={{ whiteSpace: 'nowrap' }}>
              <input
                type="radio"
                name="screenshot-translate-engine"
                checked={translateEngine === 'server'}
                onChange={() => { handleTranslateEngineChange('server'); }}
              />
              <img className="settings-inline-icon" src={ServiceIcon.ALIBABACLOUD} alt="" />
              <img className="settings-inline-icon" src={SvgIcon.PRO} alt="" />
              {t('settings.app.screenshotSettings.translateEngineServer', { defaultValue: '服务端（需会员）' })}
            </label>
          </div>
          {translateEngine === 'cloud' && (
            <div className="settings-card-body">
              <input
                className="settings-card-text-input"
                type="text"
                placeholder={t('settings.app.screenshotSettings.cloudTranslateAppIdPlaceholder', { defaultValue: '百度翻译 APP ID（fanyi-api.baidu.com 免费申请）' })}
                value={cloudTranslateAppId}
                onChange={(e) => { handleCloudTranslateAppIdChange(e.target.value); }}
              />
              <input
                className="settings-card-text-input"
                type="password"
                placeholder={t('settings.app.screenshotSettings.cloudTranslateSecretPlaceholder', { defaultValue: '百度翻译密钥' })}
                value={cloudTranslateSecret}
                onChange={(e) => { handleCloudTranslateSecretChange(e.target.value); }}
              />
              <div className="settings-card-subtitle">
                {t('settings.app.screenshotSettings.cloudTranslateHint', { defaultValue: '在 fanyi-api.baidu.com 申请「通用翻译」即可免费使用（标准版每月免费额度）；云端失败时自动回退本机引擎。' })}
              </div>
            </div>
          )}
        </div>
        <div className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              {t('settings.app.screenshotSettings.localOcrDirTitle', { defaultValue: '本地 OCR/翻译服务目录' })}
            </div>
            <div className="settings-card-subtitle">
              {t('settings.app.screenshotSettings.localOcrDirHint', { defaultValue: '本机 PaddleOCR / Hy-MT2 服务（local_capture_service.py）所在目录。留空使用默认 F:\\Work\\Create\\OCR。' })}
            </div>
          </div>
          <div className="settings-card-body">
            <input
              className="settings-card-text-input"
              type="text"
              placeholder={t('settings.app.screenshotSettings.localOcrDirPlaceholder', { defaultValue: 'local_capture_service.py 所在目录（可选）' })}
              value={localOcrDir}
              onChange={(e) => { handleLocalOcrDirChange(e.target.value); }}
            />
          </div>
        </div>
        <div className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              {t('settings.app.screenshotSettings.translateTitle', { defaultValue: '截图翻译语言' })}
            </div>
            <div className="settings-card-subtitle">
              {t('settings.app.screenshotSettings.translateHint', { defaultValue: '配置截图翻译的源语言和目标语言。' })}
            </div>
          </div>
          <div className="settings-card-body">
            <div className="translate-lang-row">
              <TranslateLangDropdown
                options={TRANSLATE_LANGUAGES}
                value={sourceLang}
                onChange={handleSourceLangChange}
              />
              <button
                className="settings-lyrics-source-btn"
                type="button"
                onClick={() => {
                  if (sourceLang === 'auto') return;
                  const nextSource = targetLang;
                  const nextTarget = sourceLang;
                  handleSourceLangChange(nextSource);
                  handleTargetLangChange(nextTarget);
                }}
                disabled={sourceLang === 'auto'}
                title={t('maxExpand.toolbox.translate.swap')}
              >
                <img className="settings-inline-icon" src={SvgIcon.SWITCHING} alt="" draggable={false} />
              </button>
              <TranslateLangDropdown
                options={TRANSLATE_TARGET_LANGUAGES}
                value={targetLang}
                onChange={handleTargetLangChange}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
