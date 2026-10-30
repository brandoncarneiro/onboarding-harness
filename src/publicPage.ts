/** Tokens belong in HTML text or quoted attributes, never scripts or styles. */
export function renderPublicPage(template: string, organizationName: string): string {
  const escaped = organizationName.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
  return template.replaceAll("{{ORGANIZATION_NAME}}", () => escaped);
}
