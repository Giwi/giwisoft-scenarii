// Resolves a URL against an optional base URL. Absolute URLs pass through unchanged.
export function resolveUrl(base_url: string | undefined, url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (!base_url) throw new Error('No base_url configured and url is relative');
  return `${base_url.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

// Replaces {{variable}} placeholders in a template string with values from the vars map.
export function interpolateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

// Navigates a parsed JSON object using a dot-notation path (e.g. $.data.items[0].id).
// Returns the value at that path, or undefined if any segment is missing.
export function resolveJsonPath(obj: unknown, path: string): unknown {
  const parts = path.replace('$.', '').split('.');
  let value: unknown = obj;
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    const arrMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) {
      value = (value as Record<string, unknown>)[arrMatch[1]];
      if (Array.isArray(value)) value = value[parseInt(arrMatch[2])];
      else return undefined;
    } else {
      value = (value as Record<string, unknown>)[part];
    }
  }
  return value;
}
