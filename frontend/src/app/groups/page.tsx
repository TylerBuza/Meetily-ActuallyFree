'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { GroupsList } from '@/components/groups/GroupsList';
import { GroupDetailView } from '@/components/groups/GroupDetailView';

function GroupsPageInner() {
  const groupId = useSearchParams().get('id');
  return groupId ? <GroupDetailView key={groupId} groupId={groupId} /> : <GroupsList />;
}

export default function GroupsPage() {
  return (
    <Suspense fallback={<div className="h-full bg-af-panel" />}>
      <GroupsPageInner />
    </Suspense>
  );
}
