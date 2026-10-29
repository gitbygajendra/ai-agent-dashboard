"use client";

import * as React from "react";
import { Alert, Button, Input, Select } from "@/components/ui";
import { Dialog } from "@/components/ui/client";
import { api } from "@/lib/utils";
import { CONSENT_META, CONSENT_STATUSES, CONTACT_STATUSES, STATUS_META, type Contact } from "./constants";
import { FormField, errorCode, errorMessage, fieldAria, toFieldErrors, type FieldErrors } from "./shared";

type FormState = {
  name: string;
  email: string;
  phone: string;
  company: string;
  source: string;
  status: Contact["status"];
  consent_status: Contact["consent_status"];
  industry: string;
  location: string;
  company_size: string;
  tags: string;
};

function initialState(c?: Contact): FormState {
  return {
    name: c?.name ?? "",
    email: c?.email ?? "",
    phone: c?.phone ?? "",
    company: c?.company ?? "",
    source: c?.source ?? "",
    status: c?.status ?? "lead",
    consent_status: c?.consent_status ?? "unknown",
    industry: c?.industry ?? "",
    location: c?.location ?? "",
    company_size: c?.company_size ?? "",
    tags: (c?.tags ?? []).join(", "),
  };
}

export function ContactFormDialog({
  open,
  onClose,
  contact,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** When set, the dialog edits this contact; otherwise it creates one. */
  contact?: Contact;
  onSaved: (contact: Contact) => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={contact ? "Edit contact" : "Add contact"}
      description={contact ? "Changing the status runs your CRM automations." : "Automations run when leads are created — follow-ups appear as tasks."}
      className="max-w-2xl"
    >
      <ContactForm contact={contact} onCancel={onClose} onSaved={onSaved} />
    </Dialog>
  );
}

function ContactForm({ contact, onCancel, onSaved }: { contact?: Contact; onCancel: () => void; onSaved: (c: Contact) => void }) {
  const [form, setForm] = React.useState<FormState>(() => initialState(contact));
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const idp = React.useId();

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: "" }));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!form.name.trim()) {
      setErrors({ name: "Name is required." });
      return;
    }
    const payload = {
      name: form.name.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      company: form.company.trim() || null,
      source: form.source.trim() || null,
      status: form.status,
      consent_status: form.consent_status,
      industry: form.industry.trim() || null,
      location: form.location.trim() || null,
      company_size: form.company_size.trim() || null,
      tags: Array.from(new Set(form.tags.split(",").map((t) => t.trim()).filter(Boolean))),
    };
    setSaving(true);
    try {
      const res = contact
        ? await api<{ contact: Contact }>(`/api/crm/contacts/${contact.id}`, { method: "PATCH", json: payload })
        : await api<{ contact: Contact }>("/api/crm/contacts", { method: "POST", json: payload });
      onSaved(res.contact);
    } catch (err) {
      const fe = toFieldErrors(err);
      if (errorCode(err) === "CONFLICT") fe.email = errorMessage(err);
      setErrors(fe);
      setFormError(Object.keys(fe).some((k) => k !== "_form") ? "Please fix the highlighted fields." : (fe._form ?? errorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  const id = (k: string) => `${idp}-${k}`;
  const text = (k: Exclude<keyof FormState, "status" | "consent_status">, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <FormField label={label} htmlFor={id(k)} error={errors[k]} hint={hint}>
      <Input {...fieldAria(id(k), errors[k])} value={form[k]} onChange={(e) => set(k, e.target.value)} {...props} />
    </FormField>
  );

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {formError && <Alert tone="danger">{formError}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        {text("name", "Name *", { required: true, autoComplete: "off", maxLength: 200, autoFocus: true })}
        {text("email", "Email", { type: "email", autoComplete: "off", maxLength: 320 })}
        {text("phone", "Phone", { type: "tel", autoComplete: "off", maxLength: 40 })}
        {text("company", "Company", { maxLength: 200 })}
        <FormField label="Status" htmlFor={id("status")} error={errors.status}>
          <Select {...fieldAria(id("status"), errors.status)} value={form.status} onChange={(e) => set("status", e.target.value as FormState["status"])}>
            {CONTACT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_META[s].label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Marketing consent" htmlFor={id("consent_status")} error={errors.consent_status}>
          <Select
            {...fieldAria(id("consent_status"), errors.consent_status)}
            value={form.consent_status}
            onChange={(e) => set("consent_status", e.target.value as FormState["consent_status"])}
          >
            {CONSENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CONSENT_META[s].label}
              </option>
            ))}
          </Select>
        </FormField>
        {text("source", "Source", { maxLength: 80, placeholder: "e.g. Website, Referral" })}
        {text("industry", "Industry", { maxLength: 120 })}
        {text("location", "Location", { maxLength: 120 })}
        {text("company_size", "Company size", { maxLength: 60, placeholder: "e.g. 11–50" })}
        {text("tags", "Tags", { placeholder: "vip, diwali-2026" }, "Comma-separated, up to 20.")}
      </div>
      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          {contact ? "Save changes" : "Add contact"}
        </Button>
      </div>
    </form>
  );
}
