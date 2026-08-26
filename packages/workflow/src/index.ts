/**
 * Workflow — lifecycle state machines, due dates and signed public links.
 *
 * This entry point is **framework-free and dependency-light on purpose**. It is
 * imported by Next.js server components, browser bundles and CLI tools as well
 * as by NestJS applications, and pulling TypeORM in here would make a Next.js
 * site install an ORM in order to verify a link.
 *
 * The Nest and database integration — entities, modules, injectable services —
 * lives behind the `./nestjs` subpath.
 */
export {
  permits,
  signLink,
  verifyLink,
  type LinkClaims,
  type LinkFailure,
  type LinkResult,
  type VerifyOptions,
} from './links';
