'use client'

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useUpdateCheck } from '@/hooks/useUpdateCheck';
import { UpdateInfo } from '@/services/updateService';
import { UpdateDialog } from './UpdateDialog';
import { setUpdateDialogCallback, showUpdateNotification } from './UpdateNotification';
import { invoke } from '@tauri-apps/api/core';
import { usePlatform } from '@/hooks/usePlatform';
import { toast } from 'sonner';
import type { CudaReconfigurationStatus } from '@/lib/transcription-acceleration';

interface UpdateCheckContextType {
  updateInfo: UpdateInfo | null;
  isChecking: boolean;
  checkForUpdates: (force?: boolean) => Promise<void>;
  showUpdateDialog: () => void;
}

const UpdateCheckContext = createContext<UpdateCheckContextType | undefined>(undefined);

export function UpdateCheckProvider({
  children,
  onboardingCompleted = false,
}: {
  children: React.ReactNode;
  onboardingCompleted?: boolean;
}) {
  const platform = usePlatform();
  // macOS ships as a separate DMG release with no Tauri updater artifact or
  // latest.json entry. Calling the Windows updater path there is misleading.
  const updatesSupported = platform !== 'macos';
  const [showDialog, setShowDialog] = useState(false);
  const [checkOnMount, setCheckOnMount] = useState(false);

  const handleShowDialog = useCallback(() => {
    setShowDialog(true);
  }, []);

  useEffect(() => {
    if (!updatesSupported) {
      setCheckOnMount(false);
      return;
    }
    invoke<boolean>('get_check_updates_on_launch')
      .then(setCheckOnMount)
      .catch(() => setCheckOnMount(false));
  }, [updatesSupported]);

  useEffect(() => {
    if (platform !== 'windows' || !onboardingCompleted) return;

    let cancelled = false;
    invoke<CudaReconfigurationStatus>('get_cuda_reconfiguration_status')
      .then((status) => {
        if (cancelled) return;

        const reconfigurationUrl = status.setupDownloadUrl;
        if (status.reconfigurationRequired && reconfigurationUrl) {
          toast.warning('NVIDIA CUDA is ready', {
            id: 'cuda-reconfiguration-status',
            description: `Rerun Meetily setup to replace the ${status.compiledBackend} build with the CUDA build.`,
            duration: 30000,
            action: {
              label: 'Download setup',
              onClick: () => {
                void invoke('open_external_url', { url: reconfigurationUrl });
              },
            },
          });
        } else if (status.driverUpdateRequired) {
          toast.warning('NVIDIA driver update recommended', {
            id: 'cuda-reconfiguration-status',
            description: 'Install a current NVIDIA driver, then reopen Meetily to recheck CUDA support.',
            duration: 30000,
            action: {
              label: 'Get driver',
              onClick: () => {
                void invoke('open_external_url', {
                  url: 'https://www.nvidia.com/Download/index.aspx',
                });
              },
            },
          });
        }
      })
      .catch((error) => console.error('Failed to recheck CUDA availability:', error));

    return () => {
      cancelled = true;
    };
  }, [onboardingCompleted, platform]);

  const { updateInfo, isChecking, checkForUpdates } = useUpdateCheck({
    checkOnMount: updatesSupported && checkOnMount,
    showNotification: false,
    onUpdateAvailable: (info) => {
      showUpdateNotification(info, handleShowDialog);
    },
  });

  const checkForSupportedUpdates = useCallback(
    async (force = false) => {
      if (!updatesSupported) return;
      await checkForUpdates(force);
    },
    [checkForUpdates, updatesSupported],
  );

  useEffect(() => {
    // Register the callback so UpdateNotification can trigger the dialog
    setUpdateDialogCallback(handleShowDialog);
    return () => {
      setUpdateDialogCallback(() => {});
    };
  }, [handleShowDialog]);

  // Listen for tray menu events
  useEffect(() => {
    const handleTrayCheck = () => {
      if (!updatesSupported) return;
      void checkForSupportedUpdates(true);
      setShowDialog(true);
    };

    window.addEventListener('check-updates-from-tray', handleTrayCheck);
    return () => window.removeEventListener('check-updates-from-tray', handleTrayCheck);
  }, [checkForSupportedUpdates, updatesSupported]);

  return (
    <UpdateCheckContext.Provider
      value={{
        updateInfo,
        isChecking,
        checkForUpdates: checkForSupportedUpdates,
        showUpdateDialog: handleShowDialog,
      }}
    >
      {children}
      <UpdateDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        updateInfo={updateInfo}
      />
    </UpdateCheckContext.Provider>
  );
}

export function useUpdateCheckContext() {
  const context = useContext(UpdateCheckContext);
  if (context === undefined) {
    throw new Error('useUpdateCheckContext must be used within UpdateCheckProvider');
  }
  return context;
}
