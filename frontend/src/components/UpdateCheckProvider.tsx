'use client'

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useUpdateCheck } from '@/hooks/useUpdateCheck';
import { UpdateInfo } from '@/services/updateService';
import { UpdateDialog } from './UpdateDialog';
import { setUpdateDialogCallback, showUpdateNotification } from './UpdateNotification';
import { invoke } from '@tauri-apps/api/core';
import { usePlatform } from '@/hooks/usePlatform';

interface UpdateCheckContextType {
  updateInfo: UpdateInfo | null;
  isChecking: boolean;
  checkForUpdates: (force?: boolean) => Promise<void>;
  showUpdateDialog: () => void;
}

const UpdateCheckContext = createContext<UpdateCheckContextType | undefined>(undefined);

export function UpdateCheckProvider({ children }: { children: React.ReactNode }) {
  const platform = usePlatform();
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
