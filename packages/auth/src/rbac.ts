/**
 * Role and permission checking.
 *
 * Mortar checks; projects define. There is deliberately no shared enumeration
 * of roles or permissions — a "manager" in a repair shop and a "manager" in a
 * recruitment agency have nothing in common, and a shared list would be wrong
 * within two projects.
 */

/** A permission string, conventionally `resource:action`, e.g. `booking:write`. */
export type Permission = string;

/** Maps each role to the permissions it grants. Supplied by the project. */
export type RolePermissions = Readonly<Record<string, readonly Permission[]>>;

/** The wildcard, granting everything. Use sparingly. */
export const ALL_PERMISSIONS = '*';

/**
 * Expands roles into the permissions they grant.
 *
 * Supports `resource:*` as well as the bare `*`, because most real role
 * definitions want "everything to do with bookings" without listing every verb
 * and then forgetting to update the list when a verb is added.
 */
export function permissionsForRoles(
  roles: readonly string[],
  mapping: RolePermissions,
): Set<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of mapping[role] ?? []) granted.add(permission);
  }
  return granted;
}

/** Whether a granted set satisfies a required permission. */
export function hasPermission(granted: ReadonlySet<Permission>, required: Permission): boolean {
  if (granted.has(ALL_PERMISSIONS)) return true;
  if (granted.has(required)) return true;

  const separator = required.indexOf(':');
  if (separator > 0) {
    if (granted.has(`${required.slice(0, separator)}:*`)) return true;
  }
  return false;
}

/** Whether every required permission is satisfied. */
export function hasAllPermissions(
  granted: ReadonlySet<Permission>,
  required: readonly Permission[],
): boolean {
  return required.every((permission) => hasPermission(granted, permission));
}

/** Whether at least one required permission is satisfied. */
export function hasAnyPermission(
  granted: ReadonlySet<Permission>,
  required: readonly Permission[],
): boolean {
  return required.some((permission) => hasPermission(granted, permission));
}
