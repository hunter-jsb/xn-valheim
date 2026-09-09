"""Pulumi dynamic provider backing Valheim server state on the IB file API.

`ManagedServerFile` reconciles the desired text content of a file on the server
(e.g. adminlist.txt) via GET/POST /files. This is the verified, non-destructive
surface — no server restart, and it round-trips exactly.

Auth for CRUD comes from the provider process env: IB_EMAIL/IB_PASSWORD, or
IB_SESSION. `pulumi preview` needs no credentials; `pulumi up` does.
"""
from __future__ import annotations

import os
import sys

from pulumi import ResourceOptions
from pulumi.dynamic import (
    CreateResult, DiffResult, ReadResult, Resource, ResourceProvider, UpdateResult,
)

# make the sibling `ib/` package importable when Pulumi runs this file
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _client():
    from ib import IBClient
    c = IBClient()
    if not c.session_ok():
        c.login()
    return c


class _FileProvider(ResourceProvider):
    def create(self, props):
        _client().write_file(props["linuxUsername"], props["path"], props["content"])
        return CreateResult(id_=f'{props["linuxUsername"]}:{props["path"]}', outs=props)

    def read(self, id_, props):
        try:
            props = dict(props)
            props["content"] = _client().read_file(props["linuxUsername"], props["path"])
        except Exception:
            pass
        return ReadResult(id_=id_, outs=props)

    def diff(self, id_, old, new):
        replaces = [k for k in ("linuxUsername", "path") if old.get(k) != new.get(k)]
        changed = replaces or old.get("content") != new.get("content")
        return DiffResult(changes=bool(changed), replaces=replaces,
                          delete_before_replace=False)

    def update(self, id_, old, new):
        _client().write_file(new["linuxUsername"], new["path"], new["content"])
        return UpdateResult(outs=new)

    def delete(self, id_, props):
        # Never destroy live game files on `destroy`; leave them as-is.
        return


class ManagedServerFile(Resource):
    def __init__(self, name, linux_username, path, content, opts: ResourceOptions | None = None):
        super().__init__(_FileProvider(), name,
                         {"linuxUsername": linux_username, "path": path, "content": content},
                         opts)
