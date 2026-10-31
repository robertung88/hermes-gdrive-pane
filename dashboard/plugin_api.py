"""Read-only Google Drive API for the Hermes Desktop Drive pane.

Profile-scoped: the Hermes home is resolved per call and that profile's own
``google_token.json`` is used (the same grant the Gmail pane reads). Refreshed
access tokens stay in memory; the token file is never rewritten here.

Reads only — listing a folder, searching, and one file's metadata. Downloads,
moves, renames and shares go through the agent (``gog-robert drive …``) or the
rclone mount, which is where the "don't touch what I didn't ask for" rule lives.
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

router = APIRouter()

_MAX_PAGE = 200
_FOLDER_MIME = "application/vnd.google-apps.folder"

_lock = threading.Lock()
_local = threading.local()

_FIELDS = (
    "nextPageToken, files(id,name,mimeType,size,modifiedTime,createdTime,webViewLink,"
    "owners(emailAddress,displayName),shortcutDetails(targetId,targetMimeType),parents,"
    "shared,starred,trashed,iconLink,fileExtension)"
)


class AuthUnavailable(RuntimeError):
    """No usable google_token.json for this profile."""


# --------------------------------------------------------------------------- #
# credentials / service
# --------------------------------------------------------------------------- #


def _current_home() -> str:
    from hermes_constants import get_hermes_home

    return str(Path(get_hermes_home()).expanduser().resolve(strict=False))


def _token_path() -> Path:
    return Path(_current_home()) / "google_token.json"


def _stamp() -> str:
    try:
        return str(int(_token_path().stat().st_mtime))
    except OSError:
        return ""


def _load_credentials() -> Any:
    from google.auth.transport.requests import Request as GoogleAuthRequest
    from google.oauth2.credentials import Credentials

    path = _token_path()
    if not path.is_file():
        raise AuthUnavailable("missing google_token.json")
    credentials = Credentials.from_authorized_user_file(str(path))
    if credentials.expired and credentials.refresh_token:
        credentials.refresh(GoogleAuthRequest())
    if not credentials.valid:
        raise AuthUnavailable("invalid credentials")
    return credentials


def _build_drive_service() -> Any:
    from googleapiclient.discovery import build

    return build(
        "drive",
        "v3",
        credentials=_load_credentials(),
        cache_discovery=False,
        static_discovery=True,
        num_retries=0,
    )


def _service() -> Any:
    home = _current_home()
    stamp = _stamp()
    store = getattr(_local, "services", None)
    if store is None:
        store = {}
        _local.services = store
    entry = store.get(home)
    if entry and entry[0] == stamp:
        return entry[1]
    service = _build_drive_service()
    store[home] = (stamp, service)
    return service


def _drop_service() -> None:
    store = getattr(_local, "services", None)
    if store:
        store.clear()


def _execute(request: Any) -> dict[str, Any]:
    result = request.execute(num_retries=0)
    if not isinstance(result, dict):
        raise ValueError("invalid provider response")
    return result


def _provider_error(*, auth: bool = False) -> HTTPException:
    _drop_service()
    if auth:
        return HTTPException(
            status_code=401,
            detail="Google Drive is not authorised for this Hermes profile.",
        )
    return HTTPException(status_code=502, detail="Google Drive is unavailable.")


def _guard(fn: Any) -> Any:
    try:
        return fn()
    except HTTPException:
        raise
    except AuthUnavailable:
        raise _provider_error(auth=True) from None
    except Exception:
        raise _provider_error() from None


# --------------------------------------------------------------------------- #
# shaping
# --------------------------------------------------------------------------- #


def _text(value: Any, limit: int = 400) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit].strip()


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _file_row(item: dict[str, Any]) -> dict[str, Any]:
    mime = _text(item.get("mimeType"), 200)
    owners = item.get("owners") if isinstance(item.get("owners"), list) else []
    owner = owners[0] if owners and isinstance(owners[0], dict) else {}
    shortcut = item.get("shortcutDetails") if isinstance(item.get("shortcutDetails"), dict) else {}
    return {
        "id": _text(item.get("id"), 256),
        "name": _text(item.get("name"), 400) or "(untitled)",
        "mimeType": mime,
        "isFolder": mime == _FOLDER_MIME,
        "size": _int(item.get("size")),
        "modifiedTime": _text(item.get("modifiedTime"), 40),
        "createdTime": _text(item.get("createdTime"), 40),
        "webViewLink": _text(item.get("webViewLink"), 900),
        "iconLink": _text(item.get("iconLink"), 900),
        "extension": _text(item.get("fileExtension"), 12),
        "owner": _text(owner.get("emailAddress"), 320),
        "ownerName": _text(owner.get("displayName"), 200),
        "shared": bool(item.get("shared")),
        "starred": bool(item.get("starred")),
        "parents": [_text(p, 256) for p in (item.get("parents") or []) if isinstance(p, str)][:5],
        "shortcutTarget": _text(shortcut.get("targetId"), 256),
        "shortcutMime": _text(shortcut.get("targetMimeType"), 200),
    }


def _escape_query(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


# --------------------------------------------------------------------------- #
# routes
# --------------------------------------------------------------------------- #


@router.get("/status")
def status(request: Request) -> dict[str, Any]:
    def run() -> dict[str, Any]:
        service = _service()
        about = _execute(
            service.about().get(fields="user(emailAddress,displayName),storageQuota(limit,usage)")
        )
        user = about.get("user") if isinstance(about.get("user"), dict) else {}
        quota = about.get("storageQuota") if isinstance(about.get("storageQuota"), dict) else {}
        root = _execute(service.files().get(fileId="root", fields="id,name"))
        return {
            "ok": True,
            "account": _text(user.get("emailAddress"), 320),
            "displayName": _text(user.get("displayName"), 200),
            "rootId": _text(root.get("id"), 256) or "root",
            "quota": {"limit": _int(quota.get("limit")), "usage": _int(quota.get("usage"))},
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }

    return _guard(run)


@router.get("/files")
def files(
    request: Request,
    folderId: str = Query("", max_length=256),
    q: str = Query("", max_length=300),
    scope: str = Query("browse", max_length=20),
    pageToken: str = Query("", max_length=2000),
    pageSize: int = Query(100, ge=1, le=_MAX_PAGE),
) -> dict[str, Any]:
    """One page of Drive children.

    ``scope``: browse (folder contents), search (name/full-text), shared
    (shared with me), starred, recent.
    """

    def run() -> dict[str, Any]:
        service = _service()
        root = _execute(service.files().get(fileId="root", fields="id"))
        root_id = _text(root.get("id"), 256) or "root"
        parent = folderId or root_id

        query = ""
        order_by = "folder,name_natural"
        if scope == "search":
            needle = _escape_query(q.strip())
            if not needle:
                raise HTTPException(status_code=422, detail="Search needs a term.")
            query = (
                "trashed = false and ("
                f"name contains '{needle}' or fullText contains '{needle}')"
            )
            order_by = "modifiedTime desc"
        elif scope == "shared":
            query = "sharedWithMe = true and trashed = false"
            order_by = "modifiedTime desc"
        elif scope == "starred":
            query = "starred = true and trashed = false"
            order_by = "modifiedTime desc"
        elif scope == "recent":
            query = "trashed = false"
            order_by = "modifiedTime desc"
        else:
            query = f"'{_escape_query(parent)}' in parents and trashed = false"

        kwargs: dict[str, Any] = {
            "q": query,
            "pageSize": pageSize,
            "fields": _FIELDS,
            "orderBy": order_by,
            "includeItemsFromAllDrives": True,
            "supportsAllDrives": True,
            "corpora": "user" if scope in {"search", "shared", "starred", "recent"} else "user",
        }
        if pageToken:
            kwargs["pageToken"] = pageToken

        raw = _execute(service.files().list(**kwargs))
        rows = [
            _file_row(item)
            for item in (raw.get("files") or [])
            if isinstance(item, dict) and item.get("id")
        ]
        return {
            "ok": True,
            "scope": scope if scope in {"browse", "search", "shared", "starred", "recent"} else "browse",
            "folderId": parent,
            "rootId": root_id,
            "files": rows,
            "nextPageToken": _text(raw.get("nextPageToken"), 2000),
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }

    return _guard(run)


@router.get("/file")
def file_detail(
    request: Request,
    fileId: str = Query(..., min_length=1, max_length=256),
) -> dict[str, Any]:
    def run() -> dict[str, Any]:
        service = _service()
        raw = _execute(
            service.files().get(
                fileId=fileId,
                fields=(
                    "id,name,mimeType,size,modifiedTime,createdTime,webViewLink,iconLink,"
                    "owners(emailAddress,displayName),parents,shared,starred,description,"
                    "fileExtension,md5Checksum,videoMediaMetadata(durationMillis),"
                    "imageMediaMetadata(width,height),shortcutDetails(targetId,targetMimeType)"
                ),
                supportsAllDrives=True,
            )
        )
        row = _file_row(raw)
        row["description"] = _text(raw.get("description"), 2000)
        row["md5"] = _text(raw.get("md5Checksum"), 64)

        parents: list[dict[str, str]] = []
        for parent_id in row["parents"]:
            try:
                parent = _execute(
                    service.files().get(fileId=parent_id, fields="id,name", supportsAllDrives=True)
                )
            except Exception:
                continue
            parents.append({"id": _text(parent.get("id"), 256), "name": _text(parent.get("name"), 400)})

        row["parentFolders"] = parents
        return {"ok": True, "file": row, "fetchedAt": datetime.now(timezone.utc).isoformat()}

    return _guard(run)
