'use client';

/**
 * The meeting's document, beside the transcript: your notes, the action items,
 * and the AI summary, one continuous page. A second tab holds Ask AI.
 *
 * Notes and summary edits save themselves. When a summary arrives with an
 * action section, its items move into the action list (see
 * lib/action-item-sync) so nothing is shown twice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ChevronDown,
  FileText,
  Languages,
  ListChecks,
  NotebookPen,
  RefreshCw,
  Settings2,
  Sparkles,
  Square,
  Wand2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/surface';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { VisuallyHidden } from '@/components/ui/visually-hidden';
import { NotesEditor, type NotesContent } from '@/components/editor/NotesEditor';
import { ActionItemsList } from '@/components/actions/ActionItemsList';
import { ChatThread } from '@/components/chat/ChatThread';
import { LanguagePickerPopover } from '@/components/LanguagePickerPopover';
import { ModelSettingsModal, type ModelConfig } from '@/components/ModelSettingsModal';
import { useAutosave, saveStateLabel, type SaveState } from '@/hooks/useAutosave';
import {
  askMeeting,
  getMeetingNotes,
  listActionItems,
  onWorkspaceChange,
  saveMeetingNotes,
  type ActionItem,
} from '@/lib/workspace-api';
import { syncMeetingActionItems, type TranscriptLine } from '@/lib/action-item-sync';
import { extractActionItems } from '@/lib/action-items';
import { completeSummaryMarkdown } from '@/lib/summary-markdown';
import { labelForCode } from '@/lib/summary-languages';
import { readMeetingSummaryLanguage, saveMeetingSummaryLanguage } from '@/lib/summary-language-preferences';

type SummaryStatus = 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';

export interface MeetingDocumentProps {
  meetingId: string;
  aiSummary: any;
  summaryUserEdited: boolean;
  onSummaryChange: (summary: any, source: 'user' | 'system') => void;
  summaryStatus: SummaryStatus;
  summaryError: string | null;
  statusMessage: (status: SummaryStatus) => string;
  onGenerate: () => void;
  onRegenerate: (instructions: string) => Promise<void>;
  onStop: () => void;
  hasTranscript: boolean;
  transcript: TranscriptLine[];
  onSeek: (seconds: number) => void;
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig | ((prev: ModelConfig) => ModelConfig)) => void;
  onSaveModelConfig: (config?: ModelConfig) => Promise<void>;
  templates: Array<{ id: string; name: string; description: string }>;
  selectedTemplate: string;
  onTemplateSelect: (id: string, name: string) => void;
  onManageTemplates: () => void;
  /** Prefill for the regenerate dialog, e.g. after a speaker rename. */
  regenerateRequest: { open: boolean; context: string; reason?: string } | null;
  onRegenerateRequestHandled: () => void;
}

const SUGGESTIONS = ['Focus on decisions and owners', 'Keep it to five bullets', 'Highlight open questions', 'Use a more formal tone'];

function SectionTitle({ icon: Icon, children, aside }: { icon: typeof FileText; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold text-af-text">
        <Icon className="h-4 w-4 text-af-text-3" />
        {children}
      </h2>
      {aside}
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const label = saveStateLabel(state);
  if (!label) return null;
  return <span className={cn('text-[11px]', state === 'error' ? 'text-af-danger' : 'text-af-text-4')}>{label}</span>;
}

export function MeetingDocument(props: MeetingDocumentProps) {
  const [tab, setTab] = useState<'notes' | 'ask'>('notes');
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as 'notes' | 'ask')} className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-af-border px-4">
        <TabsList className="h-8">
          <TabsTrigger value="notes" className="text-xs">
            <NotebookPen className="!size-3.5" />
            Notes
          </TabsTrigger>
          <TabsTrigger value="ask" className="text-xs">
            <Sparkles className="!size-3.5" />
            Ask AI
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="notes" className="mt-0 min-h-0 flex-1 data-[state=active]:flex data-[state=inactive]:hidden" forceMount>
        <NotesTab {...props} />
      </TabsContent>
      <TabsContent value="ask" className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden" forceMount>
        <ChatThread
          historyKey={`meeting:${props.meetingId}`}
          ask={(question, history) => askMeeting(props.meetingId, question, history)}
          suggestions={['What was decided?', 'Who owns what?', 'What questions are still open?', 'Summarize the last ten minutes']}
          placeholder="Ask about this meeting…"
          emptyTitle="Ask about this meeting"
          emptyHint="Answers use the whole transcript, your notes, the summary, and the action items, with links to the moment."
          footnote="Uses your configured AI model. Cloud providers receive the parts of this meeting needed to answer."
          onSeek={props.onSeek}
        />
      </TabsContent>
    </Tabs>
  );
}

function NotesTab({
  meetingId,
  aiSummary,
  summaryUserEdited,
  onSummaryChange,
  summaryStatus,
  summaryError,
  statusMessage,
  onGenerate,
  onRegenerate,
  onStop,
  hasTranscript,
  transcript,
  onSeek,
  modelConfig,
  setModelConfig,
  onSaveModelConfig,
  templates,
  selectedTemplate,
  onTemplateSelect,
  onManageTemplates,
  regenerateRequest,
  onRegenerateRequestHandled,
}: MeetingDocumentProps) {
  // ---- Notes ---------------------------------------------------------------
  const [notes, setNotes] = useState<{ loaded: boolean; json: unknown[] | null; markdown: string | null }>({
    loaded: false,
    json: null,
    markdown: null,
  });
  useEffect(() => {
    let cancelled = false;
    setNotes({ loaded: false, json: null, markdown: null });
    void getMeetingNotes(meetingId)
      .then((stored) => !cancelled && setNotes({ loaded: true, json: stored?.json ?? null, markdown: stored?.markdown ?? null }))
      .catch(() => !cancelled && setNotes({ loaded: true, json: null, markdown: null }));
    return () => {
      cancelled = true;
    };
  }, [meetingId]);
  const notesSaver = useAutosave<NotesContent>((content) =>
    saveMeetingNotes(meetingId, content.markdown.trim() ? content.markdown : null, content.markdown.trim() ? content.json : null),
  );

  // ---- Action items --------------------------------------------------------
  const [items, setItems] = useState<ActionItem[]>([]);
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const loadItems = useCallback(async () => {
    try {
      setItems(await listActionItems({ meetingId }));
    } catch (error) {
      console.error('Failed to load action items', error);
    } finally {
      setItemsLoaded(true);
    }
  }, [meetingId]);
  useEffect(() => {
    setItemsLoaded(false);
    void loadItems();
    return onWorkspaceChange(['actions'], (detail) => {
      if (detail.source === 'list') return;
      if (!detail.meetingId || detail.meetingId === meetingId) void loadItems();
    });
  }, [meetingId, loadItems]);

  // ---- Summary -------------------------------------------------------------
  const markdown = useMemo(() => completeSummaryMarkdown(aiSummary), [aiSummary]);
  const blocks: unknown[] | null = Array.isArray(aiSummary?.summary_json) ? aiSummary.summary_json : null;
  const [revision, setRevision] = useState(0);
  const lastEditorMarkdown = useRef<string | null>(null);
  const [userEdited, setUserEdited] = useState(summaryUserEdited);
  useEffect(() => setUserEdited(summaryUserEdited), [summaryUserEdited]);

  // Remount the editor only for content it did not produce itself.
  useEffect(() => {
    if (lastEditorMarkdown.current !== null && lastEditorMarkdown.current === markdown) return;
    lastEditorMarkdown.current = null;
    setRevision((value) => value + 1);
  }, [markdown]);

  // Move a fresh summary's action section into the action list.
  const syncing = useRef(false);
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  useEffect(() => {
    if (!aiSummary || syncing.current || !markdown.trim()) return;
    // Only summaries that arrive from generation or storage are sorted; a
    // section the user is typing into stays where they put it.
    if (lastEditorMarkdown.current !== null && lastEditorMarkdown.current === markdown) return;
    if (!extractActionItems(markdown).hadActionSection) return;
    syncing.current = true;
    void syncMeetingActionItems(meetingId, aiSummary, transcriptRef.current)
      .then((outcome) => {
        if (outcome.items) setItems(outcome.items);
        if (outcome.summary) onSummaryChange(outcome.summary, 'system');
      })
      .catch((error) => console.error('Action item sync failed', error))
      .finally(() => {
        syncing.current = false;
      });
  }, [aiSummary, markdown, meetingId, onSummaryChange]);

  const summarySaver = useAutosave<NotesContent>(async (content) => {
    await invoke('api_save_meeting_summary', {
      meetingId,
      summary: { markdown: content.markdown, summary_json: content.json },
      userEdit: true,
    });
    setUserEdited(true);
  });

  const generating = summaryStatus === 'processing' || summaryStatus === 'summarizing' || summaryStatus === 'regenerating';
  const hasSummary = !!aiSummary && !!markdown.trim();

  // ---- Summary options (model, template, language) -------------------------
  const [language, setLanguage] = useState<string | null>(null);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void readMeetingSummaryLanguage(meetingId)
      .then((stored) => !cancelled && setLanguage(stored.language))
      .catch(() => !cancelled && setLanguage(null));
    return () => {
      cancelled = true;
    };
  }, [meetingId]);
  const changeLanguage = async (code: string | null) => {
    const previous = language;
    setLanguage(code);
    setLanguageOpen(false);
    try {
      const saved = await saveMeetingSummaryLanguage(meetingId, code);
      setLanguage(saved.language);
    } catch (error) {
      setLanguage(previous);
      toast.error('Could not save the summary language');
    }
  };
  const templateName = templates.find((template) => template.id === selectedTemplate)?.name ?? 'Standard';
  const modelLabel = modelConfig?.model ? modelConfig.model : 'No model';
  const languageLabel = language ? labelForCode(language) : 'Auto language';

  // ---- Regenerate ------------------------------------------------------------
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateReason, setRegenerateReason] = useState<string | undefined>();
  useEffect(() => {
    if (!regenerateRequest?.open) return;
    setInstructions(regenerateRequest.context);
    setRegenerateReason(regenerateRequest.reason);
    setRegenerateOpen(true);
    onRegenerateRequestHandled();
  }, [regenerateRequest, onRegenerateRequestHandled]);

  const submitRegenerate = async () => {
    setRegenerating(true);
    try {
      await summarySaver.flush();
      await onRegenerate(instructions.trim());
      setUserEdited(false);
      setRegenerateOpen(false);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-8 px-10 pb-16 pt-6">
        {/* Notes */}
        <section>
          <SectionTitle icon={NotebookPen} aside={<SaveIndicator state={notesSaver.state} />}>
            Your notes
          </SectionTitle>
          {notes.loaded ? (
            <NotesEditor
              key={`notes-${meetingId}`}
              initialBlocks={notes.json}
              initialMarkdown={notes.markdown}
              placeholder="Write your own notes. They stay yours: summaries never overwrite them."
              onChange={notesSaver.schedule}
            />
          ) : (
            <Skeleton className="h-16 w-full" />
          )}
        </section>

        {/* Action items */}
        <section>
          <SectionTitle
            icon={ListChecks}
            aside={
              items.length > 0 ? (
                <span className="text-[11px] tabular-nums text-af-text-4">
                  {items.filter((item) => item.done).length} of {items.length} done
                </span>
              ) : undefined
            }
          >
            Action items
          </SectionTitle>
          {itemsLoaded ? (
            <ActionItemsList
              items={items}
              onItemsChange={setItems}
              meetingId={meetingId}
              onSeek={onSeek}
              emptyText={hasSummary ? 'No action items were found.' : 'Items from the summary appear here. You can add your own any time.'}
            />
          ) : (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-4/5" />
            </div>
          )}
        </section>

        {/* Summary */}
        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-[13px] font-semibold text-af-text">
                <Sparkles className="h-4 w-4 text-af-accent" />
                AI summary
                {userEdited && hasSummary && (
                  <span className="rounded-full bg-af-panel-2 px-1.5 py-0.5 text-[10px] font-medium text-af-text-3">Edited</span>
                )}
              </h2>
              <p className="mt-0.5 truncate text-[11px] text-af-text-4">
                {modelLabel} · {templateName} · {languageLabel}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <SaveIndicator state={summarySaver.state} />
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                    <Settings2 />
                    Options
                    <ChevronDown className="!size-3" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80 space-y-3 p-3.5">
                  <p className="text-xs font-semibold text-af-text">Summary options</p>
                  <div className="space-y-1">
                    <span className="text-[11px] text-af-text-3">Model</span>
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-af-border bg-af-panel-2 px-3 py-2">
                      <span className="min-w-0 truncate text-xs text-af-text">
                        {modelConfig?.provider ? `${modelConfig.provider} · ` : ''}
                        {modelLabel}
                      </span>
                      <Button variant="ghost" size="xs" onClick={() => setModelOpen(true)}>
                        Change
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[11px] text-af-text-3">Template</span>
                    <Select value={selectedTemplate} onValueChange={(id) => onTemplateSelect(id, templates.find((t) => t.id === id)?.name ?? id)}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Standard" />
                      </SelectTrigger>
                      <SelectContent>
                        {templates.map((template) => (
                          <SelectItem key={template.id} value={template.id}>
                            {template.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <button type="button" onClick={onManageTemplates} className="text-[11px] text-af-accent hover:underline">
                      Create or edit templates…
                    </button>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[11px] text-af-text-3">Language</span>
                    <Popover open={languageOpen} onOpenChange={setLanguageOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="flex h-8 w-full items-center justify-between rounded-lg border border-af-border-strong bg-af-panel-2 px-3 text-xs text-af-text transition-colors hover:border-af-text-4/70"
                        >
                          <span className="flex items-center gap-2">
                            <Languages className="h-3.5 w-3.5 text-af-text-3" />
                            {language ? labelForCode(language) : 'Auto (match the transcript)'}
                          </span>
                          <ChevronDown className="h-3.5 w-3.5 text-af-text-3" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-auto border-0 bg-transparent p-0 shadow-none">
                        <LanguagePickerPopover
                          value={language}
                          onChange={(code) => void changeLanguage(code)}
                          onClose={() => setLanguageOpen(false)}
                          autoSubtitle="Uses the transcript's main language"
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                </PopoverContent>
              </Popover>
              {generating ? (
                <Button variant="soft" size="sm" className="h-7 text-xs" onClick={onStop}>
                  <Square className="!size-3" fill="currentColor" />
                  Stop
                </Button>
              ) : hasSummary ? (
                <Button variant="secondary" size="sm" className="h-7 text-xs" onClick={() => setRegenerateOpen(true)} disabled={!hasTranscript}>
                  <RefreshCw />
                  Regenerate
                </Button>
              ) : null}
            </div>
          </div>

          {summaryError && !generating && (
            <div role="alert" className="mb-3 flex items-start gap-3 rounded-xl border border-af-danger/30 bg-af-danger/[0.07] px-3.5 py-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-af-danger" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-af-text">The summary could not be generated</p>
                <p className="mt-0.5 break-words text-xs text-af-text-2">{summaryError}</p>
              </div>
              <Button size="xs" variant="secondary" onClick={() => (hasSummary ? setRegenerateOpen(true) : onGenerate())}>
                Try again
              </Button>
            </div>
          )}

          {generating ? (
            <div className="space-y-3 rounded-xl border border-af-border p-4">
              <p className="flex items-center gap-2 text-xs text-af-text-2">
                <Wand2 className="h-3.5 w-3.5 animate-af-breathe text-af-accent" />
                {statusMessage(summaryStatus) || 'Writing the summary…'}
              </p>
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3.5 w-3/5" />
            </div>
          ) : hasSummary ? (
            <NotesEditor
              key={`summary-${meetingId}-${revision}`}
              initialBlocks={blocks}
              initialMarkdown={blocks ? null : markdown}
              placeholder="The summary is empty."
              onChange={(content) => {
                lastEditorMarkdown.current = completeSummaryMarkdown({ markdown: content.markdown });
                onSummaryChange({ markdown: content.markdown, summary_json: content.json }, 'user');
                summarySaver.schedule(content);
              }}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-af-border-strong px-5 py-7 text-center">
              <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-af-accent/[0.12] text-af-accent">
                <Sparkles className="h-4 w-4" />
              </span>
              <p className="text-sm font-medium text-af-text">{hasTranscript ? 'No summary yet' : 'Nothing to summarize yet'}</p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-af-text-3">
                {hasTranscript
                  ? `Uses ${modelLabel} with the ${templateName} template. Action items it finds are added to the list above.`
                  : 'A summary can be written once the meeting has a transcript.'}
              </p>
              {hasTranscript && (
                <Button className="mt-4" onClick={onGenerate}>
                  <Sparkles />
                  Generate summary
                </Button>
              )}
            </div>
          )}
        </section>
      </div>

      <Dialog open={regenerateOpen} onOpenChange={(open) => !regenerating && setRegenerateOpen(open)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-af-accent" />
              Regenerate the summary
            </DialogTitle>
            <DialogDescription>
              {regenerateReason ?? 'Add one-off instructions for this run if you like. Your saved settings stay the same.'}
            </DialogDescription>
          </DialogHeader>
          {userEdited && (
            <div className="flex items-start gap-2.5 rounded-xl border border-af-warning/30 bg-af-warning/[0.08] px-3.5 py-3 text-xs text-af-text-2">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-af-warning" />
              <span>
                You edited this summary. Regenerating replaces those edits. <strong className="text-af-text">Your notes and action items are kept.</strong>
              </span>
            </div>
          )}
          <Textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={3}
            placeholder="e.g. Focus on decisions and next steps"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submitRegenerate();
            }}
          />
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setInstructions((current) => (current.trim() ? `${current.trim()}\n${suggestion}` : suggestion))}
                className="rounded-full border border-af-border px-2.5 py-1 text-[11px] text-af-text-2 transition-colors hover:border-af-accent/40 hover:text-af-text"
              >
                + {suggestion}
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRegenerateOpen(false)} disabled={regenerating}>
              Cancel
            </Button>
            <Button onClick={() => void submitRegenerate()} loading={regenerating}>
              {userEdited ? 'Replace and regenerate' : 'Regenerate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modelOpen} onOpenChange={setModelOpen}>
        <DialogContent className="max-w-2xl" aria-describedby={undefined}>
          <VisuallyHidden>
            <DialogTitle>Summary model</DialogTitle>
          </VisuallyHidden>
          <ModelSettingsModal
            onSave={async (config) => {
              await onSaveModelConfig(config);
              setModelOpen(false);
            }}
            modelConfig={modelConfig}
            setModelConfig={setModelConfig}
            skipInitialFetch
            layout="dialog"
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
