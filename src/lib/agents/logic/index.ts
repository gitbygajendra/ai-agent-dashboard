import { ANALYTICS_STAGES, mergeAnalyticsAi } from "./analytics";
import { ADVISORY_STAGES, mergeAdvisoryAi } from "./advisory";
import { CRM_STAGES, mergeCrmAi } from "./crm";
import { EMAIL_STAGES, mergeEmailAi } from "./email";
import { FINANCE_STAGES, mergeFinanceAi } from "./finance";
import { LEAD_STAGES, mergeLeadsAi } from "./leads";
import { makeN8nEntry } from "./n8n-entry";
import { SUPPORT_STAGES, mergeSupportAi } from "./support";

/** One entry per agent: its stage pipeline (one n8n Code node per stage) and the AI merge step. */
export const WORKFLOW_LOGIC = {
  "data-analytics-agent": makeN8nEntry(ANALYTICS_STAGES, mergeAnalyticsAi),
  "email-automation-agent": makeN8nEntry(EMAIL_STAGES, mergeEmailAi),
  "finance-audit-agent": makeN8nEntry(FINANCE_STAGES, mergeFinanceAi),
  "crm-automation-agent": makeN8nEntry(CRM_STAGES, mergeCrmAi),
  "data-advisory-agent": makeN8nEntry(ADVISORY_STAGES, mergeAdvisoryAi),
  "customer-support-agent": makeN8nEntry(SUPPORT_STAGES, mergeSupportAi),
  "lead-generation-agent": makeN8nEntry(LEAD_STAGES, mergeLeadsAi),
} as const;
