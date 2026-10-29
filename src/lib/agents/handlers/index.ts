import "server-only";
import type { HandlerMap } from "../types";
import { advisoryHandler } from "./advisory";
import { analyticsHandler } from "./analytics";
import { crmHandler } from "./crm";
import { emailHandler } from "./email";
import { financeHandler } from "./finance";
import { leadsHandler } from "./leads";
import { supportHandler } from "./support";

export const HANDLERS: HandlerMap = {
  "data-analytics-agent": analyticsHandler,
  "email-automation-agent": emailHandler,
  "finance-audit-agent": financeHandler,
  "crm-automation-agent": crmHandler,
  "data-advisory-agent": advisoryHandler,
  "customer-support-agent": supportHandler,
  "lead-generation-agent": leadsHandler,
};
