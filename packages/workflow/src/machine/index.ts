/**
 * The lifecycle, with no database in it.
 *
 * Everything here is a pure function over values, which is what lets a Next.js
 * server component ask "what can this customer do next" without installing an
 * ORM to find out. The log — the half that genuinely needs one — is reached
 * through the `./nestjs` subpath and is deliberately not re-exported here: a
 * barrel that exports it would pull TypeORM into every consumer of this file,
 * and nothing about the types would reveal that it had.
 */
export { InvalidMachine, type MachineDefinition, type Transition } from './definition';
export { defineMachine, type Machine } from './machine';
export {
  DEFAULT_CALENDAR,
  addWorkingDays,
  heldSinceCutoff,
  isWorkingDay,
  workingDaysBetween,
  type WorkingCalendar,
} from './working-days';
