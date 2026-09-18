/**
 * Login authentication for demo-app.
 * Phase 3 bug fixed: valid credentials succeed; invalid return 401.
 */
export type LoginInput = {
  username: string;
  password: string;
};

export type LoginResult =
  | { ok: true; redirectTo: string }
  | { ok: false; status: number; error: string };

const VALID_USER = "demo";
const VALID_PASS = "demo123";

export const BUG_ENABLED = false;

export function authenticate(input: LoginInput): LoginResult {
  if (input.username === VALID_USER && input.password === VALID_PASS) {
    return { ok: true, redirectTo: "/dashboard" };
  }
  return { ok: false, status: 401, error: "Invalid credentials" };
}
