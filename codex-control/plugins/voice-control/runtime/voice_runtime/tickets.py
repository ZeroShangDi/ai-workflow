"""Short-lived, one-use tickets issued by the Voice Control host."""

import base64
import binascii
import hashlib
import hmac
import json
import time


def verify_ticket(token: str, secret: str, used: dict[str, int], now: int | None = None) -> dict:
    current = int(time.time()) if now is None else now
    if len(secret) < 32 or not isinstance(token, str) or len(token) > 4096:
        raise ValueError("Invalid ticket")
    try:
        payload, signature = token.split(".")
        expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
        actual = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
        if not hmac.compare_digest(expected, actual):
            raise ValueError("Invalid signature")
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if claims.get("aud") != "voice" or not current < claims["exp"] <= current + 60:
            raise ValueError("Expired ticket")
        for key in ("tenant", "user", "device"):
            value = claims.get(key)
            if not isinstance(value, str) or not value.isascii() or not value.isdigit() or len(value) > 19:
                raise ValueError("Invalid identity")
        nonce = claims["nonce"]
        if not isinstance(nonce, str) or len(nonce) != 36:
            raise ValueError("Invalid nonce")
        for key, expiry in list(used.items()):
            if expiry <= current:
                del used[key]
        if nonce in used:
            raise ValueError("Ticket already used")
        if len(used) >= 4096:
            raise ValueError("Ticket capacity exceeded")
        used[nonce] = claims["exp"]
        return claims
    except (KeyError, TypeError, UnicodeError, json.JSONDecodeError, binascii.Error) as exc:
        raise ValueError("Invalid ticket") from exc
