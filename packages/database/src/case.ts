/**
 * Converts an identifier to snake_case.
 *
 * Handles the acronym case correctly — `parseHTTPResponse` becomes
 * `parse_http_response`, not `parse_h_t_t_p_response` — because entity
 * properties like `imageURL` and `customerVATNumber` are common and the naive
 * regex mangles them.
 */
export function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}
