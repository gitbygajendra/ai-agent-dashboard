"use client";

import * as React from "react";
import { Alert, Button, Input, Select } from "@/components/ui";
import { Dialog } from "@/components/ui/client";
import { api } from "@/lib/utils";
import { DEAL_STAGES, STAGE_META, type Deal, type DealStage } from "./constants";
import { ContactPicker, type PickedContact } from "./contact-picker";
import { FormField, errorMessage, fieldAria, toFieldErrors, type FieldErrors } from "./shared";

export function DealFormDialog({
  open,
  onClose,
  onCreated,
  currency,
  fixedContact,
  defaultStage = "new",
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (deal: Deal) => void;
  currency: string;
  /** Lock the deal to this contact (used on the contact profile). */
  fixedContact?: PickedContact;
  defaultStage?: DealStage;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="New deal" description="Automations run when deals are created or change stage.">
      <DealForm onCancel={onClose} onCreated={onCreated} currency={currency} fixedContact={fixedContact} defaultStage={defaultStage} />
    </Dialog>
  );
}

function DealForm({
  onCancel,
  onCreated,
  currency,
  fixedContact,
  defaultStage,
}: {
  onCancel: () => void;
  onCreated: (deal: Deal) => void;
  currency: string;
  fixedContact?: PickedContact;
  defaultStage: DealStage;
}) {
  const idp = React.useId();
  const id = (k: string) => `${idp}-${k}`;
  const [title, setTitle] = React.useState("");
  const [contact, setContact] = React.useState<PickedContact | null>(fixedContact ?? null);
  const [value, setValue] = React.useState("");
  const [stage, setStage] = React.useState<DealStage>(defaultStage);
  const [closeDate, setCloseDate] = React.useState("");
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const local: FieldErrors = {};
    if (!title.trim()) local.title = "Title is required.";
    const num = value.trim() === "" ? 0 : Number(value);
    if (!Number.isFinite(num) || num < 0) local.value = "Enter a value of 0 or more.";
    if (Object.keys(local).length) {
      setErrors(local);
      return;
    }
    setSaving(true);
    try {
      const res = await api<{ deal: Deal }>("/api/crm/deals", {
        method: "POST",
        json: { title: title.trim(), contact_id: contact?.id ?? null, value: num, stage, expected_close_date: closeDate || null },
      });
      onCreated(res.deal);
    } catch (err) {
      const fe = toFieldErrors(err);
      setErrors(fe);
      setFormError(Object.keys(fe).some((k) => k !== "_form") ? "Please fix the highlighted fields." : (fe._form ?? errorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {formError && <Alert tone="danger">{formError}</Alert>}
      <FormField label="Title *" htmlFor={id("title")} error={errors.title}>
        <Input {...fieldAria(id("title"), errors.title)} value={title} maxLength={200} autoFocus placeholder="e.g. Diwali hampers — 200 units" onChange={(e) => setTitle(e.target.value)} />
      </FormField>
      <FormField label="Contact" htmlFor={id("contact")} error={errors.contact_id}>
        {fixedContact ? (
          <Input id={id("contact")} value={fixedContact.name} readOnly disabled />
        ) : (
          <ContactPicker id={id("contact")} value={contact} onChange={setContact} invalid={!!errors.contact_id} describedBy={errors.contact_id ? `${id("contact")}-error` : undefined} />
        )}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={`Value (${currency})`} htmlFor={id("value")} error={errors.value}>
          <Input {...fieldAria(id("value"), errors.value)} type="number" inputMode="decimal" min={0} step="any" value={value} placeholder="0" onChange={(e) => setValue(e.target.value)} />
        </FormField>
        <FormField label="Stage" htmlFor={id("stage")} error={errors.stage}>
          <Select {...fieldAria(id("stage"), errors.stage)} value={stage} onChange={(e) => setStage(e.target.value as DealStage)}>
            {DEAL_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_META[s].label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Expected close" htmlFor={id("close")} error={errors.expected_close_date}>
          <Input {...fieldAria(id("close"), errors.expected_close_date)} type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
        </FormField>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          Create deal
        </Button>
      </div>
    </form>
  );
}
