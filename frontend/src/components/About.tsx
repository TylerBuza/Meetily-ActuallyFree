'use client'
import React, { useState, useEffect } from "react";
import { Spinner } from '@/components/ui/spinner';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import Image from 'next/image';
import { UpdateDialog } from "./UpdateDialog";
import { updateService, UpdateInfo } from '@/services/updateService';
import { Button } from './ui/button';
import { CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePlatform } from '@/hooks/usePlatform';
import { useI18n } from '@/i18n';


export function About() {
    const { t } = useI18n();
    const platform = usePlatform();
    const [currentVersion, setCurrentVersion] = useState<string>('0.0.1');
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [isChecking, setIsChecking] = useState(false);
    const [showUpdateDialog, setShowUpdateDialog] = useState(false);

    useEffect(() => {
        // Get current version on mount
        getVersion().then(setCurrentVersion).catch(console.error);
    }, []);

    const handleCheckForUpdates = async () => {
        setIsChecking(true);
        try {
            const info = await updateService.checkForUpdates(true);
            setUpdateInfo(info);
            if (info.available) {
                setShowUpdateDialog(true);
            } else {
                toast.success(t('shell.youAreUpToDate'));
            }
        } catch (error: any) {
            console.error('Failed to check for updates:', error);
            toast.error(t('shell.updateCheckFailed', { message: error.message || t('shell.unknownError') }));
        } finally {
            setIsChecking(false);
        }
    };

    const openExternal = (url: string) => {
        invoke('open_external_url', { url }).catch((error) => {
            console.error('Failed to open external link:', error);
            toast.error(t('shell.couldNotOpenLink'));
        });
    };

    return (
        <div className="p-4 space-y-4 h-[80vh] overflow-y-auto">
            {/* Compact Header */}
            <div className="text-center">
                <div className="mb-3">
                    <Image
                        src="icon_128x128.png"
                        alt={t('shell.meetilyLogo')}
                        width={64}
                        height={64}
                        className="mx-auto"
                    />
                </div>
                {/* <h1 className="text-xl font-bold text-af-text">Meetily</h1> */}
                <span className="text-sm text-af-text-3"> v{currentVersion}</span>
                <p className="text-medium text-af-text-2 mt-1">
                    {t('shell.aboutTagline')}
                </p>
                <div className="mt-3">
                    {platform === 'macos' ? (
                        <Button
                            onClick={() => openExternal('https://github.com/TylerBuza/Meetily-ActuallyFree/releases')}
                            variant="outline"
                            size="sm"
                            className="text-xs"
                        >
                            <CheckCircle2 className="h-3 w-3 mr-2" />
                            {t('shell.viewMacosReleases')}
                        </Button>
                    ) : (
                        <Button
                            onClick={handleCheckForUpdates}
                            disabled={isChecking}
                            variant="outline"
                            size="sm"
                            className="text-xs"
                        >
                            {isChecking ? (
                                <>
                                    <Spinner className="h-3 w-3 mr-2 " />
                                    {t('shell.checkingForUpdates')}
                                </>
                            ) : (
                                <>
                                    <CheckCircle2 className="h-3 w-3 mr-2" />
                                    {t('shell.checkForUpdates')}
                                </>
                            )}
                        </Button>
                    )}
                    {updateInfo?.available && (
                        <div className="mt-2 text-xs text-af-accent">
                            {t('shell.updateAvailableInline', { version: updateInfo.version ?? '' })}
                        </div>
                    )}
                </div>
            </div>

            {/* Features Grid - Compact */}
            <div className="space-y-3">
                <h2 className="text-base font-semibold text-af-text">{t('shell.whatMakesDifferent')}</h2>
                <div className="grid grid-cols-2 gap-2">
                    <div className="bg-af-panel-2 rounded p-3 hover:bg-af-panel-2 transition-colors">
                        <h3 className="font-bold text-sm text-af-text mb-1">{t('shell.privacyFirst')}</h3>
                        <p className="text-xs text-af-text-2 leading-relaxed">{t('shell.privacyFirstBody')}</p>
                    </div>
                    <div className="bg-af-panel-2 rounded p-3 hover:bg-af-panel-2 transition-colors">
                        <h3 className="font-bold text-sm text-af-text mb-1">{t('shell.useAnyModel')}</h3>
                        <p className="text-xs text-af-text-2 leading-relaxed">{t('shell.useAnyModelBody')}</p>
                    </div>
                    <div className="bg-af-panel-2 rounded p-3 hover:bg-af-panel-2 transition-colors">
                        <h3 className="font-bold text-sm text-af-text mb-1">{t('shell.costSmart')}</h3>
                        <p className="text-xs text-af-text-2 leading-relaxed">{t('shell.costSmartBody')}</p>
                    </div>
                    <div className="bg-af-panel-2 rounded p-3 hover:bg-af-panel-2 transition-colors">
                        <h3 className="font-bold text-sm text-af-text mb-1">{t('shell.worksEverywhere')}</h3>
                        <p className="text-xs text-af-text-2 leading-relaxed">{t('shell.worksEverywhereBody')}</p>
                    </div>
                </div>
            </div>

            {/* Footer - Compact */}
            <div className="pt-2 border-t border-af-border text-center">
                <p className="text-xs text-af-text-4">
                    {t('shell.aboutFooter')}
                </p>
                <p className="mt-1 text-xs text-af-text-3">
                    Tyler Buza ·{' '}
                    <button
                        type="button"
                        className="underline underline-offset-2 transition-colors hover:text-af-accent"
                        onClick={() => openExternal('https://github.com/TylerBuza')}
                    >
                        GitHub
                    </button>
                    {' '}·{' '}
                    <button
                        type="button"
                        className="underline underline-offset-2 transition-colors hover:text-af-accent"
                        onClick={() => openExternal('https://buza.dev')}
                    >
                        buza.dev
                    </button>
                </p>
            </div>

            {/* Update Dialog */}
            <UpdateDialog
                open={showUpdateDialog}
                onOpenChange={setShowUpdateDialog}
                updateInfo={updateInfo}
            />
        </div>

    )
}
