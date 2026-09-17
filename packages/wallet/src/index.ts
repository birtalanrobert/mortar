/**
 * Apple Wallet and Google Wallet passes.
 *
 * One content model, two renderers, and a conformance suite that checks the
 * result against the rules a device would apply — because the products using
 * this have no device to check against. What that can and cannot prove is set
 * out in `README.md`, and the rules themselves, each with a citation, are in
 * `apple/rules.ts`.
 *
 * Designed against two specifications rather than one: a loyalty stamp card and
 * an event ticket are the same four operations over different content, so the
 * words here are `PassContent` and `PassField` rather than `stamps` and
 * `balance`.
 *
 * **This root is server-side.** It reads certificates, signs archives and hashes
 * files; nothing in a browser bundle should import it.
 */

export {
  type FieldFormat,
  type ImageSet,
  type PassAssets,
  type PassBarcode,
  type PassColours,
  type PassContent,
  type PassField,
  type PassHolder,
  type PassLocalisations,
  type PassLocation,
  type PassStyle,
  type PassWebService,
  type Rgb,
} from './content';

/* --- Apple --- */

export { buildPkPass, assetFiles, type BuildOptions, type BuiltPass } from './apple/build';

export {
  daysUntilExpiry,
  identityOf,
  readSigningCertificate,
  EXPIRY_WARNINGS,
  type SigningCertificate,
} from './apple/certificate';

export {
  generateDevelopmentCertificate,
  type CertificateAndKey,
  type DevelopmentCertificateInput,
} from './apple/development-certificate';

export { parseDistinguishedName } from './apple/distinguished-name';
export { buildManifest, serialiseManifest } from './apple/manifest';
export {
  buildPassJson,
  buildPassStrings,
  type PassIdentity,
  type PassJson,
} from './apple/pass-json';
export { readPngSize, type PngSize } from './apple/png';

export {
  ASSET_SIZES,
  BARCODE_FORMATS,
  DEFAULT_BARCODE_ENCODING,
  FIELD_LIMITS,
  MAX_LOCATIONS,
  MIN_AUTHENTICATION_TOKEN,
  RULES,
  RULES_REVIEWED,
  STYLE_ASSETS,
  type Citation,
  type PassProblem,
  type Rule,
  type RuleName,
} from './apple/rules';

export {
  signDetached,
  verifyDetached,
  type SignOptions,
  type SignatureVerdict,
  type SigningMaterial,
} from './apple/sign';

export { validateAssets, validateContent, validatePassJson } from './apple/validate';
export { verifyPkPass, type PassVerdict, type VerifyOptions } from './apple/verify';

/* --- Google --- */

export {
  buildLoyaltyClass,
  buildLoyaltyObject,
  type GoogleIssuer,
  type LoyaltyClassInput,
  type LoyaltyObjectInput,
  type LoyaltyState,
} from './google/payload';

export { buildSaveToken, saveLink, SAVE_URL, type SaveLinkInput } from './google/save-link';

/* --- shared --- */

export {
  decodeJwtClaims,
  signJwt,
  verifyJwt,
  type JwtAlgorithm,
  type JwtHeader,
  type JwtParts,
} from './jwt';
