import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ assertCanDeleteAccount: vi.fn(), removeAccountMemberships: vi.fn() }));
vi.mock("./teams", () => mocks);
import { deleteAccount } from "../account-deletion";
import type { Env } from "../types";

beforeEach(() => { vi.clearAllMocks(); });
describe("account deletion with acceptance team ownership", () => {
  it("keeps billing, review data, and sessions intact when ownership must be transferred", async () => {
    mocks.assertCanDeleteAccount.mockRejectedValue(new Error("acceptance_last_owner"));
    const prepare = vi.fn();
    const fetchReview = vi.fn();
    const response = await deleteAccount(new Request("https://nib.test/api/account", { method: "DELETE" }),
      { id: "owner", email: "owner@example.com", sessionId: "session", sessionName: "Browser", platform: "web" },
      { DB: { prepare }, REVIEW: { fetch: fetchReview } } as unknown as Env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "acceptance_last_owner" });
    expect(prepare).not.toHaveBeenCalled();
    expect(fetchReview).not.toHaveBeenCalled();
    expect(mocks.removeAccountMemberships).not.toHaveBeenCalled();
    expect(response.headers.has("set-cookie")).toBe(false);
  });
});
