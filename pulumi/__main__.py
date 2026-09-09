"""Valheim server state as code.

Every file under state/valheim/ is reconciled onto the live server at its mapped
path. Edit a file here, run `pulumi up`, and the server matches. Admin/ban/
permitted lists are the "roles as code" surface.
"""
import pulumi

from provider import ManagedServerFile

cfg = pulumi.Config()
U = cfg.require("linuxUsername")

VH = ".config/unity3d/IronGate/Valheim"
FILES = {
    "adminlist":     (f"{VH}/adminlist.txt",     "state/valheim/adminlist.txt"),
    "bannedlist":    (f"{VH}/bannedlist.txt",    "state/valheim/bannedlist.txt"),
    "permittedlist": (f"{VH}/permittedlist.txt", "state/valheim/permittedlist.txt"),
}

for name, (remote, local) in FILES.items():
    with open(local, encoding="utf-8") as fh:
        ManagedServerFile(name, U, remote, fh.read())

pulumi.export("linuxUsername", U)
