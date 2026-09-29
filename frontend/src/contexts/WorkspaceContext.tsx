'use client';

/**
 * Shared, cached workspace records: groups and contacts. Every surface that
 * shows a group chip or a contact picker reads from here, and any change
 * announced through `announceChange` refreshes all of them at once.
 *
 * Also runs the one-time action item backfill: meetings summarised before
 * action items became real records are read once, in the background.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  listGroups,
  listPeople,
  onWorkspaceChange,
  type ContactRow,
  type GroupSummary,
} from '@/lib/workspace-api';
import { backfillActionItems } from '@/lib/action-item-sync';

interface WorkspaceContextValue {
  groups: GroupSummary[];
  groupsLoaded: boolean;
  groupById: (id?: string | null) => GroupSummary | undefined;
  refreshGroups: () => Promise<void>;
  people: ContactRow[];
  peopleLoaded: boolean;
  personById: (id?: string | null) => ContactRow | undefined;
  refreshPeople: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [people, setPeople] = useState<ContactRow[]>([]);
  const [peopleLoaded, setPeopleLoaded] = useState(false);
  const backfillStarted = useRef(false);

  const refreshGroups = useCallback(async () => {
    try {
      setGroups(await listGroups());
    } catch (error) {
      console.error('Failed to load groups', error);
    } finally {
      setGroupsLoaded(true);
    }
  }, []);

  const refreshPeople = useCallback(async () => {
    try {
      setPeople(await listPeople());
    } catch (error) {
      console.error('Failed to load contacts', error);
    } finally {
      setPeopleLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshGroups();
    void refreshPeople();
    const offGroups = onWorkspaceChange(['groups', 'meetings'], () => void refreshGroups());
    const offPeople = onWorkspaceChange(['people'], () => void refreshPeople());
    return () => {
      offGroups();
      offPeople();
    };
  }, [refreshGroups, refreshPeople]);

  useEffect(() => {
    // Older summaries still carry their action items as text; turn them into rows.
    if (backfillStarted.current) return;
    backfillStarted.current = true;
    // Let startup settle first; the backfill is background work.
    const timer = window.setTimeout(() => void backfillActionItems(), 6_000);
    return () => window.clearTimeout(timer);
  }, []);

  const value = useMemo<WorkspaceContextValue>(() => {
    const groupMap = new Map(groups.map((group) => [group.id, group]));
    const personMap = new Map(people.map((person) => [person.id, person]));
    return {
      groups,
      groupsLoaded,
      groupById: (id) => (id ? groupMap.get(id) : undefined),
      refreshGroups,
      people,
      peopleLoaded,
      personById: (id) => (id ? personMap.get(id) : undefined),
      refreshPeople,
    };
  }, [groups, groupsLoaded, people, peopleLoaded, refreshGroups, refreshPeople]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return context;
}
