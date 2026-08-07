'use client';

import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { ArrowLeft, Settings2, Mic, Database as DatabaseIcon, SparkleIcon, Radar, Info, Cpu } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { motion } from 'framer-motion';
import { TranscriptSettings } from '@/components/TranscriptSettings';
import { RecordingSettings } from '@/components/RecordingSettings';
import { PreferenceSettings } from '@/components/PreferenceSettings';
import { SummaryModelSettings } from '@/components/SummaryModelSettings';
import { MeetingDetectionSettings } from '@/components/MeetingDetectionSettings';
import { DiarizationSettings } from '@/components/DiarizationSettings';
import { AboutSettings } from '@/components/AboutSettings';
import { BetaSettings } from '@/components/BetaSettings';
import { LocalStackStatus } from '@/components/LocalStackStatus';
import { useConfig } from '@/contexts/ConfigContext';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

const TABS = [
  { value: 'general', label: 'General', icon: Settings2 },
  { value: 'recording', label: 'Recording', icon: Mic },
  { value: 'Transcriptionmodels', label: 'Transcription', icon: DatabaseIcon },
  { value: 'summaryModels', label: 'Summary', icon: SparkleIcon },
  { value: 'meetingDetection', label: 'Detection', icon: Radar },
  { value: 'localStack', label: 'Local stack', icon: Cpu },
  { value: 'about', label: 'About', icon: Info },
] as const;

export default function SettingsPage() {
  const router = useRouter();
  const { transcriptModelConfig, setTranscriptModelConfig } = useConfig();

  const [activeTab, setActiveTab] = useState('general');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  const [underlineStyle, setUnderlineStyle] = useState({ left: 0, width: 0 });
  const [tabsOverflow, setTabsOverflow] = useState(false);

  useEffect(() => {
    const loadTranscriptConfig = async () => {
      try {
        const config = await invoke('api_get_transcript_config') as any;
        if (config) {
          setTranscriptModelConfig({
            provider: config.provider || 'localWhisper',
            model: config.model || 'large-v3',
            apiKey: config.apiKey || null
          });
        }
      } catch (error) {
        console.error('Failed to load transcript config:', error);
      }
    };
    loadTranscriptConfig();
  }, [setTranscriptModelConfig]);

  // Keep the active tab underline aligned, and scroll it into view on narrow windows.
  useLayoutEffect(() => {
    const activeIndex = TABS.findIndex(tab => tab.value === activeTab);
    const activeTabElement = tabRefs.current[activeIndex];
    if (!activeTabElement) return;

    const { offsetLeft, offsetWidth } = activeTabElement;
    setUnderlineStyle({ left: offsetLeft, width: offsetWidth });
    activeTabElement.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  }, [activeTab]);

  // Only show the right-edge fade when the tab strip actually overflows.
  useLayoutEffect(() => {
    const el = tabsScrollRef.current;
    if (!el) return;

    const measure = () => {
      setTabsOverflow(el.scrollWidth > el.clientWidth + 2);
    };
    measure();

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden bg-gray-50">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-gray-200 bg-gray-50">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            <button
              onClick={() => router.back()}
              className="flex shrink-0 items-center gap-2 text-gray-600 transition-colors hover:text-gray-900"
            >
              <ArrowLeft className="h-5 w-5" />
              <span className="hidden sm:inline">Back</span>
            </button>
            <h1 className="truncate text-2xl font-bold sm:text-3xl">Settings</h1>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="min-w-0 max-w-full">
            {/* Horizontal scroll for tabs on narrow windows */}
            <div className="relative min-w-0 max-w-full">
              <div
                ref={tabsScrollRef}
                className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain no-scrollbar"
                style={{ WebkitOverflowScrolling: 'touch' }}
              >
                <TabsList className="relative flex h-auto w-max min-w-full flex-nowrap justify-start gap-0 rounded-none border-b border-gray-200 bg-transparent p-0">
                  {TABS.map((tab, index) => {
                    const Icon = tab.icon;
                    return (
                      <TabsTrigger
                        key={tab.value}
                        value={tab.value}
                        ref={el => { tabRefs.current[index] = el; }}
                        className="relative z-10 flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-none border-0 bg-transparent px-3 py-3 text-sm text-gray-600 shadow-none hover:text-gray-900 data-[state=active]:bg-transparent data-[state=active]:text-blue-600 data-[state=active]:shadow-none sm:gap-2 sm:px-4 sm:py-4"
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span>{tab.label}</span>
                      </TabsTrigger>
                    );
                  })}
                  <motion.div
                    className="pointer-events-none absolute bottom-0 z-20 h-0.5 bg-blue-600"
                    layoutId="settings-tab-underline"
                    style={{ left: underlineStyle.left, width: underlineStyle.width }}
                    transition={{ type: 'spring', stiffness: 400, damping: 40 }}
                  />
                </TabsList>
              </div>
              {/* Fade only when tabs overflow — uses theme bg so it isn't a white blob in dark mode */}
              {tabsOverflow && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[var(--af-bg,#0a0c10)] to-transparent"
                />
              )}
            </div>

            <div className="mt-4 min-w-0 max-w-full break-words sm:mt-6">
              <TabsContent value="general" className="mt-0 min-w-0 max-w-full focus-visible:ring-0">
                <PreferenceSettings />
              </TabsContent>
              <TabsContent value="recording" className="mt-0 min-w-0 max-w-full focus-visible:ring-0">
                <RecordingSettings />
                <div className="mt-6">
                  <BetaSettings />
                </div>
              </TabsContent>
              <TabsContent value="Transcriptionmodels" className="mt-0 min-w-0 max-w-full focus-visible:ring-0">
                <TranscriptSettings
                  transcriptModelConfig={transcriptModelConfig}
                  setTranscriptModelConfig={setTranscriptModelConfig}
                />
                <div className="mt-6">
                  <DiarizationSettings />
                </div>
              </TabsContent>
              <TabsContent value="summaryModels" className="mt-0 min-w-0 max-w-full focus-visible:ring-0">
                <SummaryModelSettings />
              </TabsContent>
              <TabsContent value="meetingDetection" className="mt-0 min-w-0 max-w-full focus-visible:ring-0">
                <MeetingDetectionSettings />
              </TabsContent>
              <TabsContent value="localStack" className="mt-0 min-w-0 max-w-full focus-visible:ring-0">
                <LocalStackStatus />
              </TabsContent>
              <TabsContent value="about" className="mt-0 min-w-0 max-w-full focus-visible:ring-0">
                <AboutSettings />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
