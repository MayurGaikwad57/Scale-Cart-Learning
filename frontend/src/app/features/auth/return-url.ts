// After login we go back to where the user came from, but only to a path inside this app.
// Accepting any URL would be an "open redirect" (phishing: /login?returnUrl=https://evil.com).
export function safeReturnUrl(url: string | null): string {
  return url && url.startsWith('/') && !url.startsWith('//') ? url : '/';
}
