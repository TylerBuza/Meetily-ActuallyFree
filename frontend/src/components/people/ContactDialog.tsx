'use client';

/** Create a contact, or edit one's name and details. */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { announceChange, createPerson, updatePerson, type ContactRow, type PersonInput } from '@/lib/workspace-api';
import { useI18n } from '@/i18n';

const EMPTY: PersonInput = { displayName: '', role: '', company: '', email: '', phone: '' };

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-af-text-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-af-text-4">{hint}</span>}
    </label>
  );
}

export function ContactDialog({
  open,
  onOpenChange,
  contact,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this contact; omit to create one. */
  contact?: Pick<ContactRow, 'id' | 'displayName' | 'role' | 'company' | 'email' | 'phone'> | null;
  onSaved?: (contact: ContactRow) => void;
}) {
  const [form, setForm] = useState<PersonInput>(EMPTY);
  const [saving, setSaving] = useState(false);
  const { t } = useI18n();
  const editing = !!contact;

  useEffect(() => {
    if (!open) return;
    setForm(
      contact
        ? {
            displayName: contact.displayName,
            role: contact.role ?? '',
            company: contact.company ?? '',
            email: contact.email ?? '',
            phone: contact.phone ?? '',
          }
        : EMPTY,
    );
  }, [open, contact]);

  const set = (key: keyof PersonInput) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const save = async () => {
    const name = form.displayName.trim();
    if (!name) return;
    setSaving(true);
    try {
      const input: PersonInput = {
        displayName: name,
        role: form.role?.trim() || null,
        company: form.company?.trim() || null,
        email: form.email?.trim() || null,
        phone: form.phone?.trim() || null,
      };
      const saved = editing ? await updatePerson(contact!.id, input) : await createPerson(input);
      announceChange('people');
      toast.success(editing ? t('people.contactUpdated') : t('people.contactAdded', { name }));
      onSaved?.(saved);
      onOpenChange(false);
    } catch (error) {
      toast.error(editing ? t('people.couldNotUpdateContact') : t('people.couldNotAddContact'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <Avatar name={form.displayName.trim() || '?'} size="md" />
            {editing ? t('people.editContact') : t('people.newContact')}
          </DialogTitle>
          <DialogDescription>
            {editing ? t('people.editContactDescription') : t('people.newContactDescription')}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label={t('people.name')}>
            <Input autoFocus value={form.displayName} onChange={set('displayName')} placeholder={t('people.fullNamePlaceholder')} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('people.role')}>
              <Input value={form.role ?? ''} onChange={set('role')} placeholder={t('people.rolePlaceholder')} />
            </Field>
            <Field label={t('people.company')}>
              <Input value={form.company ?? ''} onChange={set('company')} placeholder={t('people.companyPlaceholder')} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('people.email')}>
              <Input type="email" value={form.email ?? ''} onChange={set('email')} placeholder="name@company.com" />
            </Field>
            <Field label={t('people.phone')}>
              <Input type="tel" value={form.phone ?? ''} onChange={set('phone')} placeholder={t('common.optional')} />
            </Field>
          </div>
          {/* Lets Enter submit from any field. */}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={!form.displayName.trim()}>
            {editing ? t('common.save') : t('people.addContact')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
