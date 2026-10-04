# 05 — Frontend state decisions (Angular 21, standalone, zoneless)

Rule from the plan: do not use Signals just because they are new. For each piece of state, the reason it lives where it does:

| State | Where | Why |
|---|---|---|
| Logged-in user (`AuthService.user`) | **Signal** in a root service | Synchronous, app-wide, read by templates, guards and other services. `isLoggedIn`/`isAdmin` are `computed()`. |
| Cart (`CartService`) | **Signal** in a root service | Needed by the navbar badge, product pages, cart and checkout at once. `count`, `totalCents`, `hasUnavailableItems` are `computed()` from the items, so they can never disagree. |
| Reload cart on login/logout | **`effect()`** in `CartService` | A genuine side effect of a signal change (call the API / clear). Uses `untracked()` to avoid loops. |
| HTTP calls | **Observables** (RxJS) | Async, one-shot, cancellable. Services return Observables; components subscribe or bridge with `toSignal`. |
| Product search/filter/paging | Form controls → **signal** → `computed` query → RxJS `debounceTime` + `switchMap` → `toSignal` | RxJS is the right tool for "wait while typing" and "cancel the stale request". Signals expose the result to the template. |
| Form inputs | **Reactive Forms** | Validation, touched/dirty state, typed controls. |
| Loading/error/busy flags, mobile menu, toasts | **Local component signals** (toasts: small root service) | Nobody else cares. |
| Session across reloads | `localStorage` (token + user) + `/auth/me` at startup | Simple. Trade-off: readable by any script on the page (XSS risk); httpOnly cookies are the hardened alternative. |

## Other decisions
- **Interceptor** adds the Bearer token to API calls only and logs out on a 401 (except on the login/register calls themselves, where 401 means "wrong password").
- **Guards** (`authGuard`, `adminGuard`, `guestGuard`) are UX only; the API enforces authorization.
- **`returnUrl`** after login is restricted to in-app paths (open-redirect protection).
- **Lazy loading:** every page is a `loadComponent` import; Bootstrap CSS only, no Bootstrap JS and no Angular Material.
- **OnPush** on every component; with signals the view updates exactly when a signal it read changes.
- **Route params as inputs** (`withComponentInputBinding`): `id = input.required<string>()` instead of injecting `ActivatedRoute`.
