import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";

export interface AuditLogParams {
  organizationId: string;
  userId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export function auditRequestContext(request: Request): Pick<AuditLogParams, "ipAddress" | "userAgent"> {
  return {
    ipAddress:
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      undefined,
    userAgent: request.headers.get("user-agent") || undefined,
  };
}

export function truncateAuditText(value: string | null | undefined, maxChars = 8000): string {
  if (!value) return "";
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[Truncated for audit log storage]`;
}

/**
 * Generate the cross-store identifier used to reconcile a durable audit
 * intent with the file-backed SCSEM session mutation that follows it.
 */
export function createAuditOperationId(): string {
  return randomUUID();
}

async function persistAudit(params: AuditLogParams): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId ?? null,
      action: params.action,
      resourceType: params.resourceType ?? null,
      resourceId: params.resourceId ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: (params.metadata ?? undefined) as any,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    },
  });
}

/**
 * Persist a fail-closed audit record. Callers must not perform the protected
 * action if this promise rejects. This is intentionally separate from the
 * application's normal best-effort audit helper below.
 */
export async function logAuditStrict(params: AuditLogParams): Promise<void> {
  await persistAudit(params);
}

/**
 * Write an entry to the AuditLog table.
 *
 * Every significant action in the application should call this function.
 * Audit logs are append-only and must never be deleted (per Pub 1075
 * safeguards requirements).
 *
 * This function intentionally does NOT throw on failure — a logging error
 * should never break the primary user flow.  Errors are logged to the
 * server console so they surface in infrastructure monitoring.
 */
export async function logAudit(params: AuditLogParams): Promise<void> {
  try {
    await persistAudit(params);
  } catch (error) {
    // Never throw — audit failures must not break the primary workflow.
    console.error("[AuditLog] Failed to write audit log entry:", error, {
      action: params.action,
      organizationId: params.organizationId,
      userId: params.userId,
    });
  }
}
