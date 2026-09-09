"""Indifferent Broccoli control-panel client (reverse-engineered, cookie-auth).

There is no official IB API. This wraps the same private JSON + socket.io
endpoints the dashboard SPA calls. See API.md for the full contract.
"""
from .client import IBClient, IBError, Server

__all__ = ["IBClient", "IBError", "Server"]
