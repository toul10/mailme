import type { Db } from "../db/client.js";
import { securityAudit } from "../db/schema.js";

/** Security audit event names (append-only table, never message content or secrets). */
export type AuditEvent =
  | "auth.login_ok"
  | "auth.login_fail"
  | "auth.logout"
  | "auth.mfa_verify_ok"
  | "auth.mfa_verify_fail"
  | "auth.mfa_enroll_start"
  | "auth.mfa_enrolled"
  | "auth.trusted_device_add"
  | "auth.trusted_device_used"
  | "auth.setup_done"
  | "mailbox.create"
  | "mailbox.update"
  | "mailbox.credentials_set"
  | "mailbox.credentials_probe_failed"
  | "mailbox.folder_update"
  | "mailbox.ingest_token_issue"
  | "admin.mailboxes_list"
  | "admin.org_create"
  | "admin.org_update"
  | "admin.org_delete"
  | "admin.user_create"
  | "admin.user_update"
  | "admin.user_delete"
  | "admin.setup_link"
  | "admin.ai_models_list"
  | "admin.ai_key_set"
  | "admin.ai_key_delete"
  | "admin.ai_select"
  | "admin.ai_resume"
  | "ingest.auth_fail"
  | "oneclick.action"
  | "oneclick.rejected";

export interface AuditEntry {
  orgId?: string | null;
  userId?: string | null;
  event: AuditEvent;
  /** Ids, codes and counts only. */
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}

export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.insert(securityAudit).values({
    orgId: e.orgId ?? null,
    userId: e.userId ?? null,
    event: e.event,
    detail: e.detail ?? null,
    ip: e.ip ?? null,
  });
}
