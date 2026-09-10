import { AcceptanceHttpError } from "./http";

export interface AcceptancePilotEnv {
  ACCEPTANCE_PILOT_ACCOUNT_IDS?: string;
  ACCEPTANCE_PILOT_PROJECT_IDS?: string;
}

// Setting either list activates the pilot. An omitted or empty companion list denies access.
export function acceptancePilotEnabled(env: AcceptancePilotEnv): boolean {
  return env.ACCEPTANCE_PILOT_ACCOUNT_IDS !== undefined || env.ACCEPTANCE_PILOT_PROJECT_IDS !== undefined;
}

export function pilotIds(list: string | undefined): string[] {
  return (list ?? "").split(",").map(value => value.trim()).filter(Boolean);
}

function includes(list: string | undefined, id: string): boolean {
  return !!id && pilotIds(list).includes(id);
}

export function isPilotAccountAllowed(env: AcceptancePilotEnv, accountId: string): boolean {
  return !acceptancePilotEnabled(env) || includes(env.ACCEPTANCE_PILOT_ACCOUNT_IDS, accountId);
}

export function isPilotProjectAllowed(env: AcceptancePilotEnv, projectId: string): boolean {
  return !acceptancePilotEnabled(env) || includes(env.ACCEPTANCE_PILOT_PROJECT_IDS, projectId);
}

export function assertPilotAccount(env: AcceptancePilotEnv, accountId: string): void {
  if (!isPilotAccountAllowed(env, accountId)) {
    throw new AcceptanceHttpError(403, "pilot_account_required", "Acceptance is currently available to invited pilot accounts.");
  }
}

export function assertPilotProject(env: AcceptancePilotEnv, projectId: string): void {
  if (!isPilotProjectAllowed(env, projectId)) {
    throw new AcceptanceHttpError(403, "pilot_project_required", "This project is not enabled for the acceptance pilot.");
  }
}

export async function isPilotEmailAllowed(env: AcceptancePilotEnv & { DB: D1Database }, email: string): Promise<boolean> {
  if (!acceptancePilotEnabled(env)) return true;
  const account = await env.DB.prepare("SELECT account_id FROM accounts WHERE lower(email) = lower(?)")
    .bind(email).first<{ account_id: string }>();
  return !!account && isPilotAccountAllowed(env, account.account_id);
}
