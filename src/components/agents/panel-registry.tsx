"use client";

import type { ComponentType } from "react";
import type { AgentSlug } from "@/lib/agents/registry";
import type { InputPanelProps, ResultViewProps } from "./types";
import { AnalyticsInputPanel, AnalyticsResultView } from "./panels/analytics";
import { AdvisoryExtras, AdvisoryInputPanel, AdvisoryResultView } from "./panels/advisory";
import { CrmInputPanel, CrmResultView } from "./panels/crm";
import { EmailInputPanel, EmailResultView } from "./panels/email";
import { FinanceInputPanel, FinanceResultView } from "./panels/finance";
import { LeadsInputPanel, LeadsResultView } from "./panels/leads";
import { SupportExtras, SupportInputPanel, SupportResultView } from "./panels/support";

type Panel = {
  inputTitle: string;
  inputDescription: string;
  InputPanel: ComponentType<InputPanelProps>;
  ResultView: ComponentType<ResultViewProps>;
  Extras?: ComponentType<{ canWrite: boolean; currency: string }>;
  layout?: "side" | "stacked";
};

export const PANELS: Record<AgentSlug, Panel> = {
  "data-analytics-agent": {
    inputTitle: "Analyze a dataset",
    inputDescription: "Upload a CSV or Excel file and optionally ask a question.",
    InputPanel: AnalyticsInputPanel,
    ResultView: AnalyticsResultView,
  },
  "email-automation-agent": {
    inputTitle: "Process emails",
    inputDescription: "Categorize, summarize and draft replies. Nothing is sent without your approval.",
    InputPanel: EmailInputPanel,
    ResultView: EmailResultView,
  },
  "finance-audit-agent": {
    inputTitle: "Review financial records",
    inputDescription: "Upload transactions and, optionally, invoices to reconcile.",
    InputPanel: FinanceInputPanel,
    ResultView: FinanceResultView,
  },
  "crm-automation-agent": {
    inputTitle: "How it runs",
    inputDescription: "Triggered automatically by changes in your CRM.",
    InputPanel: CrmInputPanel,
    ResultView: CrmResultView,
  },
  "data-advisory-agent": {
    inputTitle: "Ask about your business",
    inputDescription: "Recommendations are based only on figures in your records.",
    InputPanel: AdvisoryInputPanel,
    ResultView: AdvisoryResultView,
    Extras: AdvisoryExtras,
  },
  "customer-support-agent": {
    inputTitle: "Support chat",
    inputDescription: "Answers come only from your approved knowledge base.",
    InputPanel: SupportInputPanel,
    ResultView: SupportResultView,
    Extras: SupportExtras,
  },
  "lead-generation-agent": {
    inputTitle: "Score a prospect list",
    inputDescription: "Define your ideal customer, upload prospects, review before anything reaches the CRM.",
    InputPanel: LeadsInputPanel,
    ResultView: LeadsResultView,
  },
};
