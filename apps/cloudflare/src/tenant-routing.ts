export interface TenantDurableStub {
  fetch(request: Request): Promise<Response>;
}

export interface TenantRoutingEnv<Stub extends TenantDurableStub = TenantDurableStub> {
  REQUESTS: {
    idFromName(name: string): unknown;
    get(id: unknown): Stub;
  };
  NIB_TENANT_ID?: string;
}

export function publicTenantId(env: { NIB_TENANT_ID?: string }, _request?: Request): string {
  const configured = env.NIB_TENANT_ID?.trim();
  return configured ? trustedTenantId(configured) : "primary";
}

export function trustedTenantId(value: string): string {
  const tenantId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(tenantId)) {
    throw new Error("Invalid tenant ID");
  }
  return tenantId;
}

export function stubForTenant<Stub extends TenantDurableStub>(env: TenantRoutingEnv<Stub>, tenantId: string): Stub {
  return env.REQUESTS.get(env.REQUESTS.idFromName(trustedTenantId(tenantId)));
}
