"use client"

import { useEffect, useState } from "react"
import Image from "next/image"
import { invoke } from "@tauri-apps/api/core"
import { Github, Shield, Cpu, Heart } from "lucide-react"
import { useI18n } from "@/i18n"

/**
 * About panel for Meetily - Actually Free. Shows version, a short description,
 * and links to the source and privacy policy. Purely informational.
 */
export function AboutSettings() {
  const { t } = useI18n();
  const [version, setVersion] = useState('0.0.1');

  useEffect(() => {
    (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        setVersion(await getVersion());
      } catch {
        // Not in a Tauri context; keep the default.
      }
    })();
  }, []);

  const openUrl = (url: string) => {
    invoke('open_external_url', { url }).catch((e) => console.error('Failed to open URL:', e));
  };

  const REPO_URL = 'https://github.com/TylerBuza/Meetily-ActuallyFree';
  const ORIGINAL_MEETILY_URL = 'https://github.com/Zackriya-Solutions/meeting-minutes';
  const AUTHOR_URL = 'https://buza.dev';

  return (
    <div className="space-y-6">
      {/* Identity card */}
      <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
        <div className="flex items-center gap-4">
          <Image src="/logo-collapsed.png" alt="Meetily" width={56} height={56} className="h-14 w-14 shrink-0 rounded-2xl shadow-sm" />
          <div>
            <h3 className="text-lg font-semibold text-af-text">Meetily · Actually Free</h3>
            <p className="text-sm text-af-text-2">
              {t('labs.aboutVersionLine', { version })}
            </p>
          </div>
        </div>
        <p className="mt-4 text-sm text-af-text-2 leading-relaxed">
          {t('labs.aboutParagraph')}
        </p>
      </div>

      {/* Highlights */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <Cpu className="w-5 h-5 text-af-accent mb-2" />
          <div className="text-sm font-medium text-af-text">{t('labs.aboutOnDevice')}</div>
          <div className="text-xs text-af-text-3">{t('labs.aboutOnDeviceDescription')}</div>
        </div>
        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <Shield className="w-5 h-5 text-af-success mb-2" />
          <div className="text-sm font-medium text-af-text">{t('labs.aboutPrivate')}</div>
          <div className="text-xs text-af-text-3">{t('labs.aboutPrivateDescription')}</div>
        </div>
        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <Heart className="w-5 h-5 text-pink-500 mb-2" />
          <div className="text-sm font-medium text-af-text">{t('labs.aboutActuallyFree')}</div>
          <div className="text-xs text-af-text-3">{t('labs.aboutActuallyFreeDescription')}</div>
        </div>
      </div>

      {/* Links */}
      <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5 space-y-3">
        <h4 className="text-sm font-semibold text-af-text">{t('labs.aboutLinks')}</h4>
        <button
          onClick={() => openUrl(REPO_URL)}
          className="flex items-center gap-3 w-full text-left px-3 py-2 rounded-md border border-af-border hover:border-af-accent/40 hover:bg-af-accent/10 transition-colors"
        >
          <Github className="w-4 h-4 text-af-text-2" />
          <span className="text-sm text-af-text">{t('labs.aboutSourceCode')}</span>
        </button>
        <button
          onClick={() => openUrl(`${REPO_URL}/blob/main/PRIVACY_POLICY.md`)}
          className="flex items-center gap-3 w-full text-left px-3 py-2 rounded-md border border-af-border hover:border-af-accent/40 hover:bg-af-accent/10 transition-colors"
        >
          <Shield className="w-4 h-4 text-af-text-2" />
          <span className="text-sm text-af-text">{t('labs.aboutPrivacyPolicy')}</span>
        </button>
      </div>

      <div className="text-center text-xs text-af-text-4 space-y-1">
        <p>
          {t('labs.aboutBuiltOnThe')}
          <button
            type="button"
            onClick={() => openUrl(ORIGINAL_MEETILY_URL)}
            className="text-af-accent hover:underline"
          >
            {t('labs.aboutOpenSourceProject')}
          </button>
          {t('labs.aboutMitLicensed')}
        </p>
        <p>
          <button
            type="button"
            onClick={() => openUrl(AUTHOR_URL)}
            className="text-af-accent hover:underline"
          >
            {t('labs.aboutForkBy')}
          </button>
        </p>
      </div>
    </div>
  );
}
