/**
 * @qm/auth — auth control plane ported from qm `src/auth/`: signed payload
 * tokens, agent capability tokens, source-auth signing/verification with
 * replay dedupe, the AWS STS role broker and portal identity verification.
 */
export {
  mintSignedPayload,
  signingKeyId,
  verifySignedPayload,
} from './signed-token.ts'
export {
  BLOB_TRANSFER_AUD,
  CAPABILITY_COMPRESS_CEILING,
  CAPABILITY_COMPRESS_MARKER,
  CAPABILITY_COMPRESS_THRESHOLD,
  CAPABILITY_TTL_MS,
  CapabilityTokenError,
  COMPRESS_FLAG,
  CONTROL_PLANE_AUD,
  CREDENTIAL_BROKER_AUD,
  EGRESS_PROXY_AUD,
  OAUTH_CONSENT_AUD,
  SECRET_DROP_AUD,
  compressPayload,
  decompressPayload,
  isCompressedPayload,
  isValidCapabilityTimezone,
  mintCapabilityToken,
  verifyBlobTransferCapability,
  verifyCapabilityToken,
  type CapabilityClaims,
} from './capability-token.ts'
export {
  createMemoryReplayDedupe,
  createPostgresReplayDedupe,
  type ReplayDedupe,
} from './replay-dedupe.ts'
export {
  SOURCE_AUTH_REPLAY_WINDOW_MS,
  MIN_SIGNING_SECRET_LENGTH,
  createSourceAuth,
  isStrongSigningSecret,
  signRequest,
  verifySignature,
  type SourceAuth,
  type SourceAuthOptions,
  type SourceAuthResult,
} from './source-auth.ts'
export {
  canonicalPayload,
  signRequest as signCanonicalRequest,
  signedRequestHeaders,
} from './source-auth-sign.ts'
export {
  brokerSessionName,
  createAwsRoleBroker,
  type AwsRoleBroker,
  type AwsRoleBrokerOptions,
} from './aws-role-broker.ts'
export {
  PORTAL_IDENTITY_HEADER,
  mintPortalIdentity,
  verifyPortalIdentity,
  type PortalIdentity,
  ALLOW_UNSIGNED_TEST_IDENTITY,
  MissingPortalSecretError,
  requirePortalIdentitySecret,
} from './portal-identity.ts'
