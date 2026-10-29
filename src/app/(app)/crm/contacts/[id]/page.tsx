import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContactProfile, type ContactDetail } from "@/components/crm/contact-profile";
import { canWrite, requirePageContext } from "@/lib/auth/context";
import { getContact } from "@/lib/crm";
import { AppError } from "@/lib/errors";

type Props = { params: Promise<{ id: string }> };

/** Loads the contact once per request (shared by generateMetadata and the page). */
const loadContact = cache(async (id: string): Promise<ContactDetail> => {
  const ctx = await requirePageContext();
  try {
    // Round-trip through JSON so Date columns arrive as ISO strings, matching the API shape.
    return JSON.parse(JSON.stringify(await getContact(ctx, id))) as ContactDetail;
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const { contact } = await loadContact(id);
  return { title: contact.name };
}

export default async function ContactPage({ params }: Props) {
  const { id } = await params;
  const ctx = await requirePageContext();
  const detail = await loadContact(id);
  return <ContactProfile key={detail.contact.id} initial={detail} canWrite={canWrite(ctx)} currency={ctx.currency} />;
}
