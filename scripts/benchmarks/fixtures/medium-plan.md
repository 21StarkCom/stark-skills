# Auth Service Migration — Design

## Overview

Migrate authentication from session-based cookies to JWT tokens. The auth service
currently handles ~2000 req/s and serves 14 downstream consumers.

## Architecture

### Token Lifecycle

1. User authenticates via `/auth/login` with credentials
2. Auth service validates against LDAP, issues JWT (RS256, 15-min expiry)
3. Refresh token stored in HTTP-only cookie (7-day expiry, rotated on use)
4. Downstream services validate JWT signature using public key from JWKS endpoint

### Components

| Component | Action | Risk |
|-----------|--------|------|
| Auth API | New `/token/refresh` endpoint | Medium — new attack surface |
| API Gateway | Replace session check with JWT validation | High — all traffic flows through |
| User DB | Add `refresh_tokens` table | Low — additive schema change |
| JWKS endpoint | Expose public keys at `/.well-known/jwks.json` | Low — read-only |

### Data Model

```sql
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMP
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
```

## Migration Strategy

### Phase 1: Dual-mode (2 weeks)

- Deploy JWT issuance alongside existing sessions
- API Gateway accepts both session cookies and JWT Bearer tokens
- Monitor: track JWT vs session auth ratio in Datadog

### Phase 2: Consumer migration (4 weeks)

- Each downstream service switches to JWT validation
- Provide SDK with retry + token refresh logic
- Track migration per-service in dashboard

### Phase 3: Session removal (1 week)

- Remove session middleware from auth service
- Drop sessions table after 30-day grace period
- Remove cookie-based auth from API Gateway

## Security Considerations

- RS256 key pair: 2048-bit RSA, rotated quarterly
- Refresh token rotation: old token invalidated on each refresh
- Token revocation: revoke all refresh tokens on password change
- Rate limiting: 10 refresh attempts per minute per user
- JWTs contain only: sub (user_id), roles, exp, iat, jti

## Rollback Plan

- Phase 1 rollback: disable JWT issuance, sessions still work
- Phase 2 rollback: revert individual services to session mode
- Phase 3 rollback: re-deploy session middleware (schema still exists during grace period)

## Monitoring

- Latency: p50/p95/p99 for token issuance and validation
- Error rate: failed validations, expired tokens, revocation events
- Business: active refresh tokens per user, token refresh frequency
