# Auth Service Migration — Full Design

## Overview

Migrate authentication from session-based cookies to JWT tokens across 14 downstream services.
The auth service currently handles ~2000 req/s at p99 latency of 12ms. The migration must
maintain backward compatibility throughout a 7-week rollout window.

## Architecture

### Token Lifecycle

1. User authenticates via `/auth/login` with credentials (username/password or SSO SAML assertion)
2. Auth service validates against LDAP directory, checks MFA status, issues JWT (RS256, 15-min expiry)
3. Refresh token stored in HTTP-only secure cookie (7-day expiry, rotated on each use)
4. Downstream services validate JWT signature using public key from JWKS endpoint (`/.well-known/jwks.json`)
5. On token expiry, client calls `/auth/refresh` with refresh token cookie
6. Auth service validates refresh token, issues new JWT + rotated refresh token
7. On logout, all refresh tokens for the user are revoked server-side

### Components

| Component | Action | Risk | Owner |
|-----------|--------|------|-------|
| Auth API | New `/token/refresh`, `/token/revoke` endpoints | Medium — new attack surface | Auth team |
| API Gateway (Kong) | Replace session check with JWT validation plugin | High — all traffic flows through | Platform team |
| User DB (PostgreSQL) | Add `refresh_tokens` table, add `jwt_key_pairs` table | Low — additive schema change | DBA team |
| JWKS endpoint | Expose public keys at `/.well-known/jwks.json` with key rotation support | Low — read-only, cached | Auth team |
| Client SDK (TypeScript) | Token refresh interceptor with retry logic | Medium — consumed by all frontend apps | Frontend platform |
| Client SDK (Python) | Token refresh middleware for internal services | Medium — consumed by backend services | Platform team |
| Admin console | Token revocation UI, active session viewer | Low — internal tool | Auth team |

### Data Model

```sql
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    device_fingerprint VARCHAR(128),
    ip_address INET,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    rotated_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    revoke_reason VARCHAR(50) -- 'logout', 'password_change', 'admin_revoke', 'rotation'
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_expiry ON refresh_tokens(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE jwt_key_pairs (
    kid VARCHAR(36) PRIMARY KEY, -- Key ID (UUID format)
    algorithm VARCHAR(10) NOT NULL DEFAULT 'RS256',
    public_key TEXT NOT NULL,
    private_key_encrypted TEXT NOT NULL, -- AES-256-GCM encrypted
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN NOT NULL DEFAULT true
);
```

### JWT Claims

```json
{
  "sub": "user-uuid",
  "iss": "auth.example.com",
  "aud": ["api.example.com"],
  "exp": 1234567890,
  "iat": 1234566990,
  "jti": "unique-token-id",
  "roles": ["admin", "editor"],
  "org_id": "org-uuid",
  "permissions": ["read:widgets", "write:widgets"]
}
```

## Migration Strategy

### Phase 1: Dual-mode (2 weeks)

- Deploy JWT issuance alongside existing session middleware
- API Gateway accepts both session cookies and JWT Bearer tokens
- Priority: JWT > session cookie (if both present, use JWT)
- Monitor: track JWT vs session auth ratio in Datadog dashboard
- Feature flag: `auth.jwt.enabled` (default: true for new sessions)
- Canary: 5% of login requests get JWT-only response for 48 hours

### Phase 2: Consumer migration (4 weeks)

- Each downstream service switches to JWT validation using provided SDK
- Migration order based on traffic volume (lowest first):
  1. Internal admin tools (week 1)
  2. Reporting service, notification service (week 2)
  3. Search service, recommendation engine (week 3)
  4. Core API, mobile BFF (week 4)
- Provide SDK with retry + token refresh logic + circuit breaker
- Track migration per-service in dashboard with automated alerts

### Phase 3: Session removal (1 week)

- Remove session middleware from auth service
- Drop sessions table after 30-day grace period
- Remove cookie-based auth from API Gateway config
- Archive session-related code (don't delete, tag with deprecation commit)

## Security Considerations

- RS256 key pair: 4096-bit RSA, rotated quarterly with 2-key overlap period
- Refresh token rotation: old token invalidated immediately on each refresh
- Token revocation: revoke ALL refresh tokens on password change or account lock
- Rate limiting: 10 refresh attempts per minute per user, 100 per IP
- JWTs are NOT stored server-side (stateless validation via signature)
- Refresh tokens stored as SHA-256 hashes (not plaintext)
- Private keys encrypted at rest with AES-256-GCM, decryption key from KMS
- CORS: JWT only accepted from whitelisted origins
- Token binding: optional device fingerprint validation for high-security flows

## Rollback Plan

- Phase 1 rollback: disable JWT issuance feature flag, sessions still work
- Phase 2 rollback: revert individual service to session mode (SDK has fallback)
- Phase 3 rollback: re-deploy session middleware from tagged commit
- Emergency: global kill switch disables all JWT validation, falls back to sessions

## Monitoring & Alerting

- Latency: p50/p95/p99 for token issuance, validation, and refresh
- Error rate: failed validations, expired tokens, revocation events
- Business metrics: active refresh tokens per user, token refresh frequency
- Alert thresholds:
  - Token issuance p99 > 50ms → page
  - Failed validation rate > 5% → page
  - Refresh token table size > 10M rows → ticket
  - Key rotation overdue by > 7 days → ticket
- Dashboard: Real-time auth flow visualization showing JWT vs session split

## Non-Goals

- OAuth2/OIDC provider functionality (we're not building an IdP)
- Multi-tenant token isolation (single-tenant system)
- Token encryption (JWE) — signature verification is sufficient
- Browser-side token storage (refresh token is HTTP-only cookie)
- gRPC token propagation (REST-only for now)
