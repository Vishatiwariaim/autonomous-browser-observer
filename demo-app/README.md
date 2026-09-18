# Demo Login App (Phase 3)

Deliberately broken login for Cursor ACP end-to-end testing.

## Bug

`src/auth.ts` returns HTTP 500 for all login attempts while the bug flag is enabled.

## Fix expectation

Cursor should change `authenticate()` so valid `demo` / `demo123` succeeds with redirect to `/dashboard`.

## Run

```bash
npm start --workspace=@abo/demo-app
# http://127.0.0.1:3000/
```
