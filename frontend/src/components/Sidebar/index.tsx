'use client';

/**
 * Primary left navigation sidebar.
 *
 * Layout (top → bottom): brand ("Meetily · Actually Free", see Logo.tsx),
 * a "Search" field (⌘K), a teal "New Recording" action, a "RECENT MEETINGS"
 * list (dot + title + date-subtitle from `created_at`, with a "View all
 * library" toggle capped by RECENT_LIMIT), and a Settings-only footer.
 *
 * Supports shift/ctrl multi-select + bulk delete of meetings.
 *
 * State/wiring:
 *  - Reads the meetings list + current meeting + recording status from
 *    SidebarProvider (useSidebar) — the single source of truth kept in sync
 *    with the Rust core via Tauri commands/events.
 *  - Navigation uses next/navigation; selecting a meeting routes to
 *    /meeting-details?id=...  (see app/meeting-details/page-content.tsx).
 *  - Default state is expanded (isCollapsed=false in SidebarProvider).
 */

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { ShieldCheck, ChevronDown, ChevronRight, File, FileText, AudioLines, ArrowRight, Settings, ChevronLeftCircle, ChevronRightCircle, Calendar, StickyNote, Home, LayoutDashboard, Trash2, Mic, Square, Plus, Search, Pencil, NotebookPen, SearchIcon, X, Upload } from 'lucide-react';
import { useRouter, usePathname } from 'next/navigation';
import { useSidebar } from './SidebarProvider';
import type { CurrentMeeting } from '@/components/Sidebar/SidebarProvider';
import { ConfirmationModal } from '../ConfirmationModel/confirmation-modal';
import { ModelConfig } from '@/components/ModelSettingsModal';
import { TranscriptModelProps } from '@/components/TranscriptSettings';
import Analytics from '@/lib/analytics';
import { invoke } from '@tauri-apps/api/core';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { useConfig } from '@/contexts/ConfigContext';

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { VisuallyHidden } from "@/components/ui/visually-hidden"

import { MessageToast } from '../MessageToast';
import Logo from '../Logo';
import { ComplianceNotification } from '../ComplianceNotification';
import { Input } from '../ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../ui/input-group';

interface SidebarItem {
  id: string;
  title: string;
  type: 'folder' | 'file';
  children?: SidebarItem[];
  createdAt?: string;
}

// "RECENT MEETINGS" rows show a date/time subtitle. Meetings created before the
// timestamp was tracked fall back to parsing it out of the auto-generated title
// (e.g. "Meeting 2026-08-05_21-59-55").
function parseMeetingDate(item: { createdAt?: string; title?: string }): Date | null {
  if (item.createdAt) {
    const d = new Date(item.createdAt);
    if (!isNaN(d.getTime())) return d;
  }
  const m = item.title?.match(/(\d{4})-(\d{2})-(\d{2})[_ T](\d{2})[-:](\d{2})(?:[-:](\d{2}))?/);
  if (m) {
    const [, y, mo, da, h, mi, s] = m;
    const d = new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(s || '0'));
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function formatMeetingDate(d: Date): string {
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatMeetingTime(d: Date): string {
  return d.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' });
}

const Sidebar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const {
    currentMeeting,
    setCurrentMeeting,
    sidebarItems,
    isCollapsed,
    toggleCollapse,
    handleRecordingToggle,
    searchTranscripts,
    searchResults,
    isSearching,
    meetings,
    setMeetings,
    serverAddress
  } = useSidebar();

  // Get recording state from RecordingStateContext (single source of truth)
  const { isRecording } = useRecordingState();
  const { openImportDialog } = useImportDialog();
  const { betaFeatures } = useConfig();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['meetings']));
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: 'ollama',
    model: '',
    whisperModel: '',
    apiKey: null,
    ollamaEndpoint: null
  });
  const [transcriptModelConfig, setTranscriptModelConfig] = useState<TranscriptModelProps>({
    provider: 'parakeet',
    model: 'parakeet-tdt-0.6b-v3-int8',
  });
  const [settingsSaveSuccess, setSettingsSaveSuccess] = useState<boolean | null>(null);

  // State for edit modal
  const [editModalState, setEditModalState] = useState<{ isOpen: boolean; meetingId: string | null; currentTitle: string }>({
    isOpen: false,
    meetingId: null,
    currentTitle: ''
  });
  const [editingTitle, setEditingTitle] = useState<string>('');

  // Ensure 'meetings' folder is always expanded
  useEffect(() => {
    if (!expandedFolders.has('meetings')) {
      const newExpanded = new Set(expandedFolders);
      newExpanded.add('meetings');
      setExpandedFolders(newExpanded);
    }
  }, [expandedFolders]);

  // useEffect(() => {
  //   if (settingsSaveSuccess !== null) {
  //     const timer = setTimeout(() => {
  //       setSettingsSaveSuccess(null);
  //     }, 3000);
  //   }
  // }, [settingsSaveSuccess]);


  const [deleteModalState, setDeleteModalState] = useState<{ isOpen: boolean; itemId: string | null }>({ isOpen: false, itemId: null });

  // Multi-select for the meeting list: shift-click selects a range, ctrl/cmd
  // click toggles one, and the selection can be deleted in bulk.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // "RECENT MEETINGS" shows the newest few with a "View all library" toggle.
  const RECENT_LIMIT = 8;
  const [showAllMeetings, setShowAllMeetings] = useState(false);

  useEffect(() => {
    // Note: Don't set hardcoded defaults - let DB be the source of truth
    const fetchModelConfig = async () => {
      // Only make API call if serverAddress is loaded
      if (!serverAddress) {
        console.log('Waiting for server address to load before fetching model config');
        return;
      }

      try {
        const data = await invoke('api_get_model_config') as any;
        if (data && data.provider !== null) {
          // Fetch API key if not included and provider requires it
          if (data.provider !== 'ollama' && !data.apiKey) {
            try {
              const apiKeyData = await invoke('api_get_api_key', {
                provider: data.provider
              }) as string;
              data.apiKey = apiKeyData;
            } catch (err) {
              console.error('Failed to fetch API key:', err);
            }
          }
          setModelConfig(data);
        }
      } catch (error) {
        console.error('Failed to fetch model config:', error);
      }
    };

    fetchModelConfig();
  }, [serverAddress]);


  useEffect(() => {
    // Note: Don't set hardcoded defaults - let DB be the source of truth
    const fetchTranscriptSettings = async () => {
      // Only make API call if serverAddress is loaded
      if (!serverAddress) {
        console.log('Waiting for server address to load before fetching transcript settings');
        return;
      }

      try {
        const data = await invoke('api_get_transcript_config') as any;
        if (data && data.provider !== null) {
          setTranscriptModelConfig(data);
        }
      } catch (error) {
        console.error('Failed to fetch transcript settings:', error);
      }
    };
    fetchTranscriptSettings();
  }, [serverAddress]);

  // Listen for model config updates from other components
  useEffect(() => {
    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<ModelConfig>('model-config-updated', (event) => {
        console.log('Sidebar received model-config-updated event:', event.payload);
        setModelConfig(event.payload);
      });

      return unlisten;
    };

    let cleanup: (() => void) | undefined;
    setupListener().then(fn => cleanup = fn);

    return () => {
      cleanup?.();
    };
  }, []);



  // Handle model config save
  const handleSaveModelConfig = async (config: ModelConfig) => {
    try {
      await invoke('api_save_model_config', {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey,
        ollamaEndpoint: config.ollamaEndpoint,
      });

      setModelConfig(config);
      console.log('Model config saved successfully');
      setSettingsSaveSuccess(true);

      // Emit event to sync other components
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);

      // Track settings change
      await Analytics.trackSettingsChanged('model_config', `${config.provider}_${config.model}`);
    } catch (error) {
      console.error('Error saving model config:', error);
      setSettingsSaveSuccess(false);
    }
  };

  const handleSaveTranscriptConfig = async (updatedConfig?: TranscriptModelProps) => {
    try {
      const configToSave = updatedConfig || transcriptModelConfig;
      const payload = {
        provider: configToSave.provider,
        model: configToSave.model,
        apiKey: configToSave.apiKey ?? null
      };
      console.log('Saving transcript config with payload:', payload);

      await invoke('api_save_transcript_config', {
        provider: payload.provider,
        model: payload.model,
        apiKey: payload.apiKey,
      });


      setSettingsSaveSuccess(true);

      // Track settings change
      const transcriptConfigToSave = updatedConfig || transcriptModelConfig;
      await Analytics.trackSettingsChanged('transcript_config', `${transcriptConfigToSave.provider}_${transcriptConfigToSave.model}`);
    } catch (error) {
      console.error('Failed to save transcript config:', error);
      setSettingsSaveSuccess(false);
    }
  };

  // Handle search input changes
  const handleSearchChange = useCallback(async (value: string) => {
    setSearchQuery(value);

    // If search query is empty, just return to normal view
    if (!value.trim()) return;

    // Search through transcripts
    await searchTranscripts(value);

    // Make sure the meetings folder is expanded when searching
    if (!expandedFolders.has('meetings')) {
      const newExpanded = new Set(expandedFolders);
      newExpanded.add('meetings');
      setExpandedFolders(newExpanded);
    }
  }, [expandedFolders, searchTranscripts]);

  // Combine search results with sidebar items
  const filteredSidebarItems = useMemo(() => {
    if (!searchQuery.trim()) return sidebarItems;

    // If we have search results, highlight matching meetings
    if (searchResults.length > 0) {
      // Get the IDs of meetings that matched in transcripts
      const matchedMeetingIds = new Set(searchResults.map(result => result.id));

      return sidebarItems
        .map(folder => {
          // Always include folders in the results
          if (folder.type === 'folder') {
            if (!folder.children) return folder;

            // Filter children based on search results or title match
            const filteredChildren = folder.children.filter(item => {
              // Include if the meeting ID is in our search results
              if (matchedMeetingIds.has(item.id)) return true;

              // Or if the title matches the search query
              return item.title.toLowerCase().includes(searchQuery.toLowerCase());
            });

            return {
              ...folder,
              children: filteredChildren
            };
          }

          // For non-folder items, check if they match the search
          return (matchedMeetingIds.has(folder.id) ||
            folder.title.toLowerCase().includes(searchQuery.toLowerCase()))
            ? folder : undefined;
        })
        .filter((item): item is SidebarItem => item !== undefined); // Type-safe filter
    } else {
      // Fall back to title-only filtering if no transcript results
      return sidebarItems
        .map(folder => {
          // Always include folders in the results
          if (folder.type === 'folder') {
            if (!folder.children) return folder;

            // Filter children based on search query
            const filteredChildren = folder.children.filter(item =>
              item.title.toLowerCase().includes(searchQuery.toLowerCase())
            );

            return {
              ...folder,
              children: filteredChildren
            };
          }

          // For non-folder items, check if they match the search
          return folder.title.toLowerCase().includes(searchQuery.toLowerCase()) ? folder : undefined;
        })
        .filter((item): item is SidebarItem => item !== undefined); // Type-safe filter
    }
  }, [sidebarItems, searchQuery, searchResults, expandedFolders]);


  const handleDelete = async (itemId: string) => {
    console.log('Deleting item:', itemId);
    const payload = {
      meetingId: itemId
    };

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('api_delete_meeting', {
        meetingId: itemId,
      });
      console.log('Meeting deleted successfully');
      const updatedMeetings = meetings.filter((m: CurrentMeeting) => m.id !== itemId);
      setMeetings(updatedMeetings);

      // Track meeting deletion
      Analytics.trackMeetingDeleted(itemId);

      // Show success toast
      toast.success("Meeting deleted successfully", {
        description: "All associated data has been removed"
      });

      // If deleting the active meeting, navigate to home
      if (currentMeeting?.id === itemId) {
        setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
        router.push('/');
      }
    } catch (error) {
      console.error('Failed to delete meeting:', error);
      toast.error("Failed to delete meeting", {
        description: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const handleDeleteConfirm = () => {
    if (deleteModalState.itemId) {
      handleDelete(deleteModalState.itemId);
    }
    setDeleteModalState({ isOpen: false, itemId: null });
  };

  // Flat, ordered list of meeting ids as currently displayed — needed so a
  // shift-click can select the contiguous range between two clicks.
  const orderedMeetingIds = useMemo(() => {
    const ids: string[] = [];
    for (const folder of filteredSidebarItems) {
      if (folder.type === 'folder' && folder.children) {
        for (const child of folder.children) {
          if (child.type === 'file' && child.id.includes('-') && !child.id.startsWith('intro-call')) {
            ids.push(child.id);
          }
        }
      }
    }
    return ids;
  }, [filteredSidebarItems]);

  const clearSelection = () => {
    setSelectedIds(new Set());
    setLastSelectedId(null);
  };

  const handleMeetingSelect = (id: string, e: React.MouseEvent) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (e.shiftKey && lastSelectedId) {
        const a = orderedMeetingIds.indexOf(lastSelectedId);
        const b = orderedMeetingIds.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(orderedMeetingIds[i]);
        } else {
          next.has(id) ? next.delete(id) : next.add(id);
        }
      } else {
        next.has(id) ? next.delete(id) : next.add(id);
      }
      return next;
    });
    setLastSelectedId(id);
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    let ok = 0;
    for (const id of ids) {
      try {
        await invoke('api_delete_meeting', { meetingId: id });
        Analytics.trackMeetingDeleted(id);
        ok++;
      } catch (error) {
        console.error('Failed to delete meeting', id, error);
      }
    }
    setMeetings(meetings.filter((m: CurrentMeeting) => !selectedIds.has(m.id)));
    if (currentMeeting && selectedIds.has(currentMeeting.id)) {
      setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
      router.push('/');
    }
    if (ok > 0) {
      toast.success(`Deleted ${ok} meeting${ok === 1 ? '' : 's'}`, {
        description: 'All associated data has been removed',
      });
    }
    if (ok < ids.length) {
      toast.error(`Failed to delete ${ids.length - ok} meeting${ids.length - ok === 1 ? '' : 's'}`);
    }
    clearSelection();
    setBulkDeleteOpen(false);
  };

  // Handle modal editing of meeting names
  const handleEditStart = (meetingId: string, currentTitle: string) => {
    setEditModalState({
      isOpen: true,
      meetingId: meetingId,
      currentTitle: currentTitle
    });
    setEditingTitle(currentTitle);
  };

  const handleEditConfirm = async () => {
    const newTitle = editingTitle.trim();
    const meetingId = editModalState.meetingId;

    if (!meetingId) return;

    // Prevent empty titles
    if (!newTitle) {
      toast.error("Meeting title cannot be empty");
      return;
    }

    try {
      await invoke('api_save_meeting_title', {
        meetingId: meetingId,
        title: newTitle,
      });

      // Update local state
      const updatedMeetings = meetings.map((m: CurrentMeeting) =>
        m.id === meetingId ? { ...m, title: newTitle } : m
      );
      setMeetings(updatedMeetings);

      // Update current meeting if it's the one being edited
      if (currentMeeting?.id === meetingId) {
        setCurrentMeeting({ id: meetingId, title: newTitle });
      }

      // Track the edit
      Analytics.trackButtonClick('edit_meeting_title', 'sidebar');

      toast.success("Meeting title updated successfully");

      // Close modal and reset state
      setEditModalState({ isOpen: false, meetingId: null, currentTitle: '' });
      setEditingTitle('');
    } catch (error) {
      console.error('Failed to update meeting title:', error);
      toast.error("Failed to update meeting title", {
        description: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const handleEditCancel = () => {
    setEditModalState({ isOpen: false, meetingId: null, currentTitle: '' });
    setEditingTitle('');
  };

  const toggleFolder = (folderId: string) => {
    // Normal toggle behavior for all folders
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(folderId)) {
      newExpanded.delete(folderId);
    } else {
      newExpanded.add(folderId);
    }
    setExpandedFolders(newExpanded);
  };

  // Expose setShowModelSettings to window for Rust tray to call
  useEffect(() => {
    (window as any).openSettings = () => {
      setShowModelSettings(true);
    };

    // Cleanup on unmount
    return () => {
      delete (window as any).openSettings;
    };
  }, []);

  const renderCollapsedIcons = () => {
    if (!isCollapsed) return null;

    const isHomePage = pathname === '/';
    const isMeetingPage = pathname?.includes('/meeting-details');
    const isSettingsPage = pathname === '/settings';

    return (
      <TooltipProvider>
        <div className="flex h-full flex-col items-center">
          <div className="flex flex-col items-center space-y-4 mt-4">
            <Logo isCollapsed={isCollapsed} />

            {/* New Recording */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleRecordingToggle}
                  disabled={isRecording}
                  className={`p-2 ${isRecording ? 'bg-red-500 cursor-not-allowed' : 'bg-red-500 hover:bg-red-600'} rounded-full transition-colors duration-150 shadow-sm`}
                >
                  {isRecording ? (
                    <Square className="w-5 h-5 text-white" />
                  ) : (
                    <Mic className="w-5 h-5 text-white" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>{isRecording ? "Recording in progress..." : "Start Recording"}</p>
              </TooltipContent>
            </Tooltip>

            {/* Meetings */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    if (isCollapsed) toggleCollapse();
                    toggleFolder('meetings');
                  }}
                  className={`p-2 rounded-lg transition-colors duration-150 ${isMeetingPage ? 'bg-gray-100' : 'hover:bg-gray-100'
                    }`}
                >
                  <NotebookPen className="w-5 h-5 text-gray-600" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>Meetings</p>
              </TooltipContent>
            </Tooltip>

            {/* Import Audio (below Meetings) */}
            {betaFeatures.importAndRetranscribe && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => openImportDialog()}
                    className="p-2 rounded-lg transition-colors duration-150 hover:bg-blue-100 bg-blue-50"
                  >
                    <Upload className="w-5 h-5 text-blue-600" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>Import Audio</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* Settings pinned to the bottom */}
          <div className="mt-auto mb-4">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => router.push('/settings')}
                  className={`p-2 rounded-lg transition-colors duration-150 ${isSettingsPage ? 'bg-gray-100' : 'hover:bg-gray-100'
                    }`}
                >
                  <Settings className="w-5 h-5 text-gray-600" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>Settings</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </TooltipProvider>
    );
  };

  // Find matching transcript snippet for a meeting item
  const findMatchingSnippet = (itemId: string) => {
    if (!searchQuery.trim() || !searchResults.length) return null;
    return searchResults.find(result => result.id === itemId);
  };

  const renderItem = (item: SidebarItem, depth = 0) => {
    const isExpanded = expandedFolders.has(item.id);
    const paddingLeft = `${depth * 12 + 12}px`;
    const isActive = item.type === 'file' && currentMeeting?.id === item.id;
    const isMeetingItem = item.id.includes('-') && !item.id.startsWith('intro-call');
    const isSelected = selectedIds.has(item.id);

    // Check if this item has a matching transcript snippet
    const matchingResult = isMeetingItem ? findMatchingSnippet(item.id) : null;
    const hasTranscriptMatch = !!matchingResult;

    if (isCollapsed) return null;

    return (
      <div key={item.id}>
        <div
          className={`flex items-center transition-all duration-150 group select-none ${item.type === 'folder' && depth === 0
            ? 'p-3 text-lg font-semibold h-10 mx-3 mt-3 rounded-lg'
            : `px-2.5 py-2 my-0.5 rounded-lg text-sm ${isSelected ? 'bg-[var(--af-panel-2)] text-[var(--af-text)] ring-1 ring-[var(--af-accent)]/50' :
              isActive ? 'bg-[var(--af-panel-2)] text-[var(--af-text)] font-medium' :
                hasTranscriptMatch ? 'bg-yellow-50' : 'hover:bg-[var(--af-hover)]'
            } cursor-pointer`
            }`}
          style={item.type === 'folder' && depth === 0 ? {} : { paddingLeft }}
          onClick={(e) => {
            if (item.type === 'folder') {
              toggleFolder(item.id);
              return;
            }
            // Shift / Ctrl / Cmd click manages a multi-selection instead of
            // navigating, so several meetings can be deleted at once.
            if (isMeetingItem && (e.shiftKey || e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleMeetingSelect(item.id, e);
              return;
            }
            if (selectedIds.size > 0) clearSelection();
            setCurrentMeeting({ id: item.id, title: item.title });
            const basePath = item.id.startsWith('intro-call') ? '/' :
              item.id.includes('-') ? `/meeting-details?id=${item.id}` : `/notes/${item.id}`;
            router.push(basePath);
          }}
        >
          {item.type === 'folder' ? (
            <>
              {item.id === 'meetings' ? (
                <Calendar className="w-4 h-4 mr-2" />
              ) : item.id === 'notes' ? (
                <Calendar className="w-4 h-4 mr-2" />
              ) : null}
              <span className={depth === 0 ? "" : "font-medium"}>{item.title}</span>
              <div className="ml-auto">
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-gray-500" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-500" />
                )}
              </div>
              {searchQuery && item.id === 'meetings' && isSearching && (
                <span className="ml-2 text-xs text-blue-500 animate-pulse">Searching...</span>
              )}
            </>
          ) : (
            (() => {
              const meetingDate = isMeetingItem ? parseMeetingDate(item) : null;
              return (
                <div className="flex w-full items-center gap-2.5">
                  {isMeetingItem ? (
                    <span className={`flex-shrink-0 flex items-center justify-center w-7 h-7 ${isActive ? 'text-[var(--af-accent)]' : 'text-[var(--af-text-3)]'}`}>
                      {isActive ? <AudioLines className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                    </span>
                  ) : (
                    <span className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-blue-100 text-blue-600">
                      <Plus className="w-3.5 h-3.5" />
                    </span>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate">{item.title}</span>
                      {isMeetingItem && isActive && meetingDate && (
                        <span className="ml-auto shrink-0 text-xs font-normal text-[var(--af-text-3)]">
                          {formatMeetingTime(meetingDate)}
                        </span>
                      )}
                    </div>
                    {isMeetingItem && !isActive && meetingDate && (
                      <div className="mt-0.5 text-xs text-[var(--af-text-3)]">{formatMeetingDate(meetingDate)}</div>
                    )}
                    {hasTranscriptMatch && (
                      <div className="mt-1 text-xs text-gray-500 bg-yellow-50 p-1.5 rounded border border-yellow-100 line-clamp-2">
                        <span className="font-medium text-yellow-600">Match:</span> {matchingResult.matchContext}
                      </div>
                    )}
                  </div>

                  {isMeetingItem && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditStart(item.id, item.title);
                        }}
                        className="p-1 rounded-md text-[var(--af-text-3)] hover:text-[var(--af-accent)] hover:bg-[var(--af-hover)] flex-shrink-0"
                        aria-label="Edit meeting title"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteModalState({ isOpen: true, itemId: item.id });
                        }}
                        className="p-1 rounded-md text-[var(--af-text-3)] hover:text-red-500 hover:bg-red-500/10 flex-shrink-0"
                        aria-label="Delete meeting"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })()
          )}
        </div>
        {item.type === 'folder' && isExpanded && item.children && (
          <div className="ml-1">
            {item.children.map(child => renderItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed top-0 left-0 h-screen z-40">
      {/* Floating collapse button */}
      <button
        onClick={toggleCollapse}
        className="absolute -right-6 top-20 z-50 p-1 rounded-full shadow-lg border bg-[var(--af-panel,#fff)] border-[var(--af-border,#e5e7eb)] text-[var(--af-text,#374151)] hover:bg-[var(--af-hover,#f3f4f6)] transition-colors"
        style={{ transform: 'translateX(50%)' }}
      >
        {isCollapsed ? (
          <ChevronRightCircle className="w-6 h-6" />
        ) : (
          <ChevronLeftCircle className="w-6 h-6" />
        )}
      </button>

      <div
        className={`h-screen bg-white border-r shadow-sm flex flex-col transition-all duration-300 ${isCollapsed ? 'w-16' : 'w-64'
          }`}
      >
        {/* Header: brand, search, New Recording */}
        <div className="flex-shrink-0">
          {!isCollapsed && (
            <div className="px-3 pt-5 pb-4 space-y-4">
              <div className="pt-1 pb-1">
                <Logo isCollapsed={isCollapsed} />
              </div>

              <div className="relative">
                <InputGroup>
                  <InputGroupInput placeholder='Search' value={searchQuery}
                    onChange={(e) => handleSearchChange(e.target.value)}
                  />
                  <InputGroupAddon>
                    <SearchIcon />
                  </InputGroupAddon>
                  {searchQuery && (
                    <InputGroupAddon align={'inline-end'}>
                      <InputGroupButton onClick={() => handleSearchChange('')}>
                        <X />
                      </InputGroupButton>
                    </InputGroupAddon>
                  )}
                </InputGroup>
              </div>

              <button
                onClick={handleRecordingToggle}
                disabled={isRecording}
                className={`w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold text-white transition-[filter] bg-[var(--af-accent)] ${isRecording ? 'opacity-70 cursor-not-allowed' : 'hover:brightness-110'}`}
              >
                {isRecording ? (
                  <>
                    <Square className="w-4 h-4" />
                    <span>Recording in progress…</span>
                  </>
                ) : (
                  <>
                    <AudioLines className="w-4 h-4" />
                    <span>New Recording</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Main content - scrollable area */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* Content area */}
          <div className="flex-1 flex flex-col min-h-0">
            {renderCollapsedIcons()}
            {/* Meetings folder header - fixed */}
            {!isCollapsed && (
              <div className="flex-shrink-0">
                {filteredSidebarItems.filter(item => item.type === 'folder').map(item => (
                  <div
                    key={item.id}
                    className="flex items-center px-4 pt-5 pb-2 text-xs font-semibold uppercase tracking-wider text-[var(--af-text-3)]"
                  >
                    <span>{item.title}</span>
                    {searchQuery && item.id === 'meetings' && isSearching && (
                      <span className="ml-2 normal-case tracking-normal text-blue-500 animate-pulse">Searching...</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Bulk-selection action bar */}
            {!isCollapsed && selectedIds.size > 0 && (
              <div className="mx-3 mb-1 flex items-center justify-between rounded-md bg-blue-50 px-3 py-2 text-sm">
                <span className="font-medium text-blue-700">{selectedIds.size} selected</span>
                <div className="flex items-center gap-2">
                  <button onClick={clearSelection} className="text-gray-500 hover:text-gray-700">Clear</button>
                  <button
                    onClick={() => setBulkDeleteOpen(true)}
                    className="inline-flex items-center gap-1 rounded-md bg-red-500 px-2 py-1 font-medium text-white hover:bg-red-600"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                </div>
              </div>
            )}

            {/* Scrollable meeting items */}
            {!isCollapsed && (
              <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0 px-1">
                {filteredSidebarItems
                  .filter(item => item.type === 'folder' && expandedFolders.has(item.id) && item.children)
                  .map(item => {
                    const children = item.children!;
                    const showAll = showAllMeetings || searchQuery.trim().length > 0;
                    const shown = showAll ? children : children.slice(0, RECENT_LIMIT);
                    const hasMore = children.length > RECENT_LIMIT;
                    return (
                      <div key={`${item.id}-children`} className="mx-3">
                        {shown.map(child => renderItem(child, 1))}
                        {item.id === 'meetings' && hasMore && (
                          <button
                            onClick={() => setShowAllMeetings(v => !v)}
                            className="mt-3 mb-2 flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--af-border-strong)] px-3 py-2 text-sm font-medium text-[var(--af-text-2)] transition-colors hover:bg-[var(--af-hover)] hover:text-[var(--af-text)]"
                          >
                            {showAllMeetings ? 'Show recent only' : 'View all library'}
                            <ArrowRight className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        {!isCollapsed && (
          <div className="flex-shrink-0 p-2 border-t border-[var(--af-border)]">
            {betaFeatures.importAndRetranscribe && (
              <button
                onClick={() => openImportDialog()}
                className="w-full flex items-center gap-2.5 px-3 py-2 mb-1 text-sm font-medium text-[var(--af-text-2)] hover:bg-[var(--af-hover)] hover:text-[var(--af-text)] rounded-lg transition-colors"
              >
                <Upload className="w-4 h-4" />
                <span>Import Audio</span>
              </button>
            )}
            <button
              onClick={() => router.push('/settings')}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium text-[var(--af-text-2)] hover:bg-[var(--af-hover)] hover:text-[var(--af-text)] rounded-lg transition-colors"
            >
              <Settings className="w-4 h-4" />
              <span>Settings</span>
            </button>
          </div>
        )}
      </div>

      {/* Confirmation Modal for Delete */}
      <ConfirmationModal
        isOpen={deleteModalState.isOpen}
        text="Are you sure you want to delete this meeting? This action cannot be undone."
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteModalState({ isOpen: false, itemId: null })}
      />

      {/* Confirmation Modal for Bulk Delete */}
      <ConfirmationModal
        isOpen={bulkDeleteOpen}
        text={`Delete ${selectedIds.size} selected meeting${selectedIds.size === 1 ? '' : 's'}? This action cannot be undone.`}
        onConfirm={handleBulkDelete}
        onCancel={() => setBulkDeleteOpen(false)}
      />

      {/* Edit Meeting Title Modal */}
      <Dialog open={editModalState.isOpen} onOpenChange={(open) => {
        if (!open) handleEditCancel();
      }}>
        <DialogContent className="sm:max-w-[425px]">
          <VisuallyHidden>
            <DialogTitle>Edit Meeting Title</DialogTitle>
          </VisuallyHidden>
          <div className="py-4">
            <h3 className="text-lg font-semibold mb-4">Edit Meeting Title</h3>
            <div className="space-y-4">
              <div>
                <label htmlFor="meeting-title" className="block text-sm font-medium text-gray-700 mb-2">
                  Meeting Title
                </label>
                <input
                  id="meeting-title"
                  type="text"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleEditConfirm();
                    } else if (e.key === 'Escape') {
                      handleEditCancel();
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Enter meeting title"
                  autoFocus
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={handleEditCancel}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleEditConfirm}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
            >
              Save
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Sidebar;
