'use client';

import { useCallback, useEffect, useState } from 'react';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { PENDING_GROUP_EVENT, readPendingGroup, writePendingGroup, type PendingGroup } from '@/lib/groups';

/**
 * The group the next recording goes into, shared by the record card, the
 * live header, the sidebar and the home page. The name follows renames.
 */
export function usePendingGroup() {
  const { groups, groupsLoaded } = useWorkspace();
  const [pending, setPending] = useState<PendingGroup | null>(null);

  useEffect(() => {
    const sync = () => setPending(readPendingGroup());
    sync();
    window.addEventListener(PENDING_GROUP_EVENT, sync);
    return () => window.removeEventListener(PENDING_GROUP_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!pending || !groupsLoaded) return;
    // A group created from a picker may not be listed yet, so only follow renames
    // here; deleting a group clears it (see deleteGroup).
    const current = groups.find((group) => group.id === pending.id);
    if (current && current.name !== pending.name) writePendingGroup({ id: current.id, name: current.name });
  }, [groups, groupsLoaded, pending]);

  const choose = useCallback(
    (groupId: string | null, name?: string) => {
      if (!groupId) return writePendingGroup(null);
      const group = groups.find((candidate) => candidate.id === groupId);
      const label = group?.name ?? name;
      if (label) writePendingGroup({ id: groupId, name: label });
    },
    [groups],
  );

  return [pending, choose] as const;
}
