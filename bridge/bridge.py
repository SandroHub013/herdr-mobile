"""
Herdr Mobile Bridge Daemon & True-to-Life Herdr Terminal Client
Replicates Herdr's authentic desktop TUI layout, sidebar, workspaces, tabs,
and real-time ANSI terminal rendering with xterm.js.
"""

import asyncio
import json
import mimetypes
import os
import re
import socket
import sys
import threading
import time
from io import BytesIO
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from urllib.parse import unquote
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import BaseModel

DEFAULT_SOCKET_PATH = os.path.expandvars(r"%APPDATA%\herdr\herdr.sock")
PORT = 43737
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
# Herdr keeps a thousand lines of scrollback per pane and hands back at most
# that many: asking for all of it is what lets the phone scroll a shell's past.
READ_LINES = 1000


def get_local_ip() -> str:
    """Find local IPv4 address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def resolve_pipe_endpoint(socket_path: str) -> str:
    if sys.platform == "win32":
        clean = os.path.abspath(socket_path)
        return rf"\\.\pipe\{clean}"
    return socket_path


def get_git_branch(cwd: Optional[str]) -> Optional[str]:
    """Inspect Git repository branch for a workspace directory."""
    if not cwd or not os.path.exists(cwd):
        return None
    try:
        git_dir = os.path.join(cwd, ".git")
        if os.path.isfile(git_dir):
            with open(git_dir, "r", encoding="utf-8", errors="ignore") as f:
                line = f.read().strip()
                if line.startswith("gitdir:"):
                    git_dir = line.split("gitdir:")[1].strip()
        head_file = os.path.join(git_dir, "HEAD")
        if os.path.exists(head_file):
            with open(head_file, "r", encoding="utf-8", errors="ignore") as f:
                ref = f.read().strip()
                if ref.startswith("ref: refs/heads/"):
                    return ref.replace("ref: refs/heads/", "")
                return ref[:7]
    except Exception:
        pass
    return None


class HerdrPipeClient:
    """Thread-safe client for Herdr's Windows Named Pipe."""

    def __init__(self, socket_path: str = DEFAULT_SOCKET_PATH):
        self.pipe_path = resolve_pipe_endpoint(socket_path)
        self.lock = threading.Lock()
        self._req_counter = 0

    def call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        with self.lock:
            self._req_counter += 1
            req_id = f"bridge-{int(time.time() * 1000)}-{self._req_counter}"
            payload = json.dumps({"id": req_id, "method": method, "params": params or {}}) + "\n"

            try:
                with open(self.pipe_path, "r+b", buffering=0) as pipe:
                    pipe.write(payload.encode("utf-8"))
                    response_line = pipe.readline().decode("utf-8", errors="replace")
                    if not response_line:
                        raise RuntimeError("Empty response from Herdr named pipe")
                    data = json.loads(response_line)
                    if "error" in data and data["error"]:
                        err = data["error"]
                        raise RuntimeError(err.get("message") or str(err))
                    return data.get("result")
            except Exception as e:
                raise RuntimeError(f"Herdr RPC error ({method}): {e}")


herdr_client = HerdrPipeClient()

app = FastAPI(title="Herdr Mobile Bridge", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Static assets
@app.get("/static/{filename}")
def serve_static(filename: str):
    file_path = os.path.join(STATIC_DIR, filename)
    if os.path.exists(file_path):
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="Static asset not found")


# ---------------------------------------------------------------------------
# WebSocket & State Streaming
# ---------------------------------------------------------------------------
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.pane_subscriptions: Dict[WebSocket, Any] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)
            self.pane_subscriptions[websocket] = set()

    async def disconnect(self, websocket: WebSocket):
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
            self.pane_subscriptions.pop(websocket, None)

    async def set_pane_subscription(self, websocket: WebSocket, pane_ids: Any):
        async with self._lock:
            if isinstance(pane_ids, (list, tuple, set)):
                self.pane_subscriptions[websocket] = set(pane_ids)
            elif isinstance(pane_ids, str):
                self.pane_subscriptions[websocket] = {pane_ids}

    async def broadcast(self, message: Dict[str, Any]):
        async with self._lock:
            dead = []
            for ws in self.active_connections:
                try:
                    await ws.send_json(message)
                except Exception:
                    dead.append(ws)
            for d in dead:
                if d in self.active_connections:
                    self.active_connections.remove(d)
                self.pane_subscriptions.pop(d, None)

    async def stream_panes(self, cached_pane_texts: Dict[str, str]):
        """Send terminal data to websockets subscribed to active panes."""
        async with self._lock:
            dead = []
            for ws, pids in list(self.pane_subscriptions.items()):
                for pane_id in pids:
                    text = cached_pane_texts.get(pane_id)
                    if text is not None:
                        try:
                            await ws.send_json({
                                "type": "terminal_data",
                                "pane_id": pane_id,
                                "text": text,
                            })
                        except Exception:
                            dead.append(ws)
            for d in dead:
                if d in self.active_connections:
                    self.active_connections.remove(d)
                self.pane_subscriptions.pop(d, None)


ws_manager = ConnectionManager()
latest_snapshot: Optional[Dict[str, Any]] = None
cached_pane_texts: Dict[str, str] = {}


async def background_sync_loop():
    """Sync snapshot and stream active pane output."""
    global latest_snapshot, cached_pane_texts
    tick = 0
    while True:
        tick += 1
        try:
            # 1. Periodically fetch full snapshot (every ~1s)
            if tick % 3 == 0 or latest_snapshot is None:
                res = await asyncio.to_thread(herdr_client.call, "session.snapshot")
                if res and isinstance(res, dict) and "snapshot" in res:
                    snap = res["snapshot"]
                    # Enrich workspaces with git branch info
                    panes_by_ws = {}
                    for p in snap.get("panes", []):
                        ws_id = p.get("workspace_id")
                        if ws_id and ws_id not in panes_by_ws:
                            panes_by_ws[ws_id] = p.get("cwd")

                    for w in snap.get("workspaces", []):
                        ws_id = w.get("workspace_id")
                        cwd = panes_by_ws.get(ws_id)
                        branch = get_git_branch(cwd)
                        if branch:
                            w["git_branch"] = branch

                    latest_snapshot = snap
                    await ws_manager.broadcast({"type": "snapshot_update", "snapshot": snap})

            # 2. Read terminals for subscribed panes (every 300ms)
            sub_panes = set()
            for pset in ws_manager.pane_subscriptions.values():
                if isinstance(pset, set):
                    sub_panes.update(pset)
                elif isinstance(pset, str):
                    sub_panes.add(pset)
            new_cache = {}
            for pane_id in sub_panes:
                try:
                    read_res = await asyncio.to_thread(
                        herdr_client.call,
                        "pane.read",
                        {"pane_id": pane_id, "source": "recent", "format": "ansi", "lines": READ_LINES}
                    )
                    text = ""
                    if read_res and "read" in read_res:
                        text = read_res["read"].get("text", "")
                    elif isinstance(read_res, dict):
                        text = read_res.get("text", "")

                    if text != cached_pane_texts.get(pane_id):
                        cached_pane_texts[pane_id] = text
                        new_cache[pane_id] = text
                except Exception:
                    pass

            if new_cache:
                await ws_manager.stream_panes(new_cache)

        except Exception:
            pass

        await asyncio.sleep(0.3)


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(background_sync_loop())


# ---------------------------------------------------------------------------
# REST Endpoints
# ---------------------------------------------------------------------------
class CreateWorkspaceRequest(BaseModel):
    label: str
    cwd: Optional[str] = None
    focus: bool = False


class CreateTabRequest(BaseModel):
    workspace_id: Optional[str] = None
    focus: bool = True


class SendTextRequest(BaseModel):
    text: str


class SendKeysRequest(BaseModel):
    keys: List[str]


class SplitPaneRequest(BaseModel):
    direction: str = "right"  # "right" or "down"


@app.get("/api/status")
def get_status():
    ip = get_local_ip()
    is_herdr_up = False
    try:
        herdr_client.call("ping")
        is_herdr_up = True
    except Exception:
        pass

    return {
        "status": "online",
        "local_ip": ip,
        "port": PORT,
        "mobile_url": f"http://{ip}:{PORT}",
        "herdr_alive": is_herdr_up,
        "ws_clients": len(ws_manager.active_connections),
    }


@app.get("/api/snapshot")
def get_snapshot():
    if latest_snapshot:
        return latest_snapshot
    try:
        res = herdr_client.call("session.snapshot")
        return res.get("snapshot") if res else {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/panes/{pane_id}/read")
def read_pane_ansi(pane_id: str, lines: int = READ_LINES):
    try:
        res = herdr_client.call("pane.read", {
            "pane_id": pane_id,
            "source": "recent",
            "format": "ansi",
            "lines": max(1, min(lines, READ_LINES))
        })
        if res and "read" in res:
            return res["read"]
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/panes/{pane_id}/send-text")
def send_text_to_pane(pane_id: str, req: SendTextRequest):
    try:
        herdr_client.call("pane.send_text", {"pane_id": pane_id, "text": req.text})
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/panes/{pane_id}/send-keys")
def send_keys_to_pane(pane_id: str, req: SendKeysRequest):
    try:
        herdr_client.call("pane.send_keys", {"pane_id": pane_id, "keys": req.keys})
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/workspaces")
def create_workspace(req: CreateWorkspaceRequest):
    try:
        params: Dict[str, Any] = {"label": req.label, "focus": req.focus}
        if req.cwd:
            params["cwd"] = req.cwd
        return herdr_client.call("workspace.create", params)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/workspaces/{workspace_id}/focus")
def focus_workspace(workspace_id: str):
    try:
        return herdr_client.call("workspace.focus", {"workspace_id": workspace_id})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/tabs/{tab_id}/focus")
def focus_tab(tab_id: str):
    try:
        return herdr_client.call("tab.focus", {"tab_id": tab_id})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/tabs")
def create_tab(req: CreateTabRequest):
    try:
        params: Dict[str, Any] = {"focus": req.focus}
        if req.workspace_id:
            params["workspace_id"] = req.workspace_id
        return herdr_client.call("tab.create", params)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/panes/{pane_id}/focus")
def focus_pane(pane_id: str):
    try:
        return herdr_client.call("pane.focus", {"pane_id": pane_id})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/panes/{pane_id}/split")
def split_pane(pane_id: str, req: SplitPaneRequest):
    try:
        return herdr_client.call("pane.split", {"pane_id": pane_id, "direction": req.direction})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/panes/{pane_id}/close")
def close_pane(pane_id: str):
    try:
        return herdr_client.call("pane.close", {"pane_id": pane_id})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/panes/{pane_id}/zoom")
def zoom_pane(pane_id: str):
    try:
        return herdr_client.call("pane.zoom", {"pane_id": pane_id})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/tabs/{tab_id}/close")
def close_tab(tab_id: str):
    try:
        return herdr_client.call("tab.close", {"tab_id": tab_id})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


RELEASES_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "releases"))
APK_MEDIA_TYPE = "application/vnd.android.package-archive"


def read_latest_release() -> Optional[Dict[str, Any]]:
    """
    The release published last by release.mjs, with a download path per APK.

    The path is relative on purpose: the phone reaches this bridge by whichever
    address it has configured, over the LAN or over Tailscale, and only the
    phone knows which one that is.
    """
    path = os.path.join(RELEASES_DIR, "latest.json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        release = json.load(f)
    for apk in release.get("apks", {}).values():
        apk["url"] = f"/app/{apk['file']}"
    return release


@app.get("/api/app/latest")
def latest_release():
    release = read_latest_release()
    if release is None:
        raise HTTPException(status_code=404, detail="Nessuna release pubblicata")
    return release


@app.get("/app/{filename}")
def release_apk(filename: str):
    # Only names of files that live in the releases folder, nothing with a path in it.
    safe_name = os.path.basename(filename)
    if safe_name != filename or not safe_name.endswith(".apk"):
        raise HTTPException(status_code=404, detail="APK non trovata")
    path = os.path.join(RELEASES_DIR, safe_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="APK non trovata")
    return FileResponse(path, media_type=APK_MEDIA_TYPE, filename=safe_name)


@app.get("/download/apk")
def download_apk():
    """The newest arm64 release, or whatever Gradle built last if nothing was released yet."""
    release = read_latest_release()
    if release:
        apk = release.get("apks", {}).get("arm64-v8a") or next(iter(release.get("apks", {}).values()), None)
        if apk and os.path.exists(os.path.join(RELEASES_DIR, apk["file"])):
            return FileResponse(os.path.join(RELEASES_DIR, apk["file"]), media_type=APK_MEDIA_TYPE, filename=apk["file"])

    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    candidates = [
        os.path.join(base_dir, "app", "android", "app", "build", "outputs", "apk", "release", "app-release.apk"),
        os.path.join(base_dir, "app", "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return FileResponse(c, media_type=APK_MEDIA_TYPE, filename="HerdrMobile.apk")
    raise HTTPException(status_code=404, detail="APK not built yet")


def resolve_upload_cwd(workspace_id: Optional[str], pane_id: Optional[str]) -> Optional[str]:
    """
    Working directory the uploaded file should be relative to.

    The pane actually being written to wins: panes in one workspace can sit in
    different directories, and dropping the file next to the wrong one makes the
    reference handed to the agent point at nothing.
    """
    if not latest_snapshot:
        return None
    panes = latest_snapshot.get("panes", [])
    if pane_id:
        for p in panes:
            if p.get("pane_id") == pane_id and p.get("cwd"):
                return p["cwd"]
    if workspace_id:
        for p in panes:
            if p.get("workspace_id") == workspace_id and p.get("cwd"):
                return p["cwd"]
    return None


# ------------------------------------------------------------- session files

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
THUMB_MAX_WIDTH = 1024
# Windows' registry does not know every kind the phone cares about; the
# installer only opens for the right one.
MIME_OVERRIDES = {".apk": APK_MEDIA_TYPE, ".md": "text/markdown", ".csv": "text/csv", ".webp": "image/webp"}


def served_roots() -> List[str]:
    """
    Directories a file may be served from: the user's own profile and every
    directory a pane is working in. Anything else stays where it is.

    The phone can already type any command into any terminal, so this is not
    a boundary against the phone; it keeps a stray path in some output from
    turning the bridge into a file server for the whole disk.
    """
    roots = [os.path.expanduser("~")]
    if latest_snapshot:
        roots += [p["cwd"] for p in latest_snapshot.get("panes", []) if p.get("cwd")]
    return [os.path.normcase(os.path.abspath(root)).rstrip("\\/") for root in roots]


def resolve_session_file(path: str, workspace_id: Optional[str], pane_id: Optional[str]) -> Optional[str]:
    """
    The file a path in the transcript points at, or None if it is not there.

    Relative paths, including the "@uploads/…" references the app writes, are
    taken from the pane's working directory, which is where the agent that
    printed them resolves them too.
    """
    raw = path.strip().strip("\"'")
    if raw.startswith("@"):
        raw = raw[1:]
    raw = os.path.expanduser(raw)
    if not os.path.isabs(raw):
        cwd = resolve_upload_cwd(workspace_id, pane_id)
        if not cwd:
            return None
        raw = os.path.join(cwd, raw)
    full = os.path.normpath(os.path.abspath(raw))
    if not os.path.isfile(full):
        return None
    check = os.path.normcase(full)
    if not any(check.startswith(root + os.sep) for root in served_roots()):
        return None
    return full


def describe_session_file(full: str) -> Dict[str, Any]:
    stat = os.stat(full)
    ext = os.path.splitext(full)[1].lower()
    return {
        "path": full,
        "name": os.path.basename(full),
        "size": stat.st_size,
        "mtime": int(stat.st_mtime),
        "mime": MIME_OVERRIDES.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream",
        "kind": "image" if ext in IMAGE_EXTENSIONS else "file",
    }


@app.get("/api/files/meta")
def session_file_meta(path: str, workspace_id: Optional[str] = None, pane_id: Optional[str] = None):
    full = resolve_session_file(path, workspace_id, pane_id)
    if not full:
        raise HTTPException(status_code=404, detail="File non trovato")
    return describe_session_file(full)


@app.get("/api/files")
def session_file(path: str, workspace_id: Optional[str] = None, pane_id: Optional[str] = None):
    full = resolve_session_file(path, workspace_id, pane_id)
    if not full:
        raise HTTPException(status_code=404, detail="File non trovato")
    info = describe_session_file(full)
    return FileResponse(full, media_type=info["mime"], filename=info["name"])


@app.get("/api/files/thumb")
def session_file_thumbnail(
    path: str, workspace_id: Optional[str] = None, pane_id: Optional[str] = None, w: int = 512
):
    """A reduced copy of an image: a strip of screenshots must not cost a strip of screenshots' worth of bytes."""
    full = resolve_session_file(path, workspace_id, pane_id)
    if not full:
        raise HTTPException(status_code=404, detail="File non trovato")
    info = describe_session_file(full)
    if info["kind"] != "image":
        raise HTTPException(status_code=415, detail="Non è un'immagine")
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return FileResponse(full, media_type=info["mime"])

    width = max(64, min(int(w), THUMB_MAX_WIDTH))
    try:
        with Image.open(full) as source:
            image = ImageOps.exif_transpose(source)
            image.thumbnail((width, width))
            buffer = BytesIO()
            if image.mode in ("RGBA", "LA", "P"):
                image.save(buffer, "PNG", optimize=True)
                media = "image/png"
            else:
                image.convert("RGB").save(buffer, "JPEG", quality=82)
                media = "image/jpeg"
    except Exception:
        return FileResponse(full, media_type=info["mime"])
    return Response(buffer.getvalue(), media_type=media, headers={"Cache-Control": "private, max-age=3600"})


# --------------------------------------------------------------- transcripts
#
# An agent's pane holds one screen and no scrollback: the interface redraws in
# place. The conversation itself is in the transcript Claude Code writes as it
# goes, one JSON line per event, under ~/.claude/projects. The bridge finds the
# file behind a pane and reads it as the conversation it is.

CLAUDE_HOME = os.path.expanduser(r"~\.claude")
PROJECTS_DIR = os.path.join(CLAUDE_HOME, "projects")
SESSIONS_DIR = os.path.join(CLAUDE_HOME, "sessions")
TRANSCRIPT_CACHE: Dict[str, Dict[str, Any]] = {}
TRANSCRIPT_LOCK = threading.Lock()
TRANSCRIPT_LOOKUP: Dict[str, Any] = {}
TRANSCRIPT_LOOKUP_TTL = 60
# Turns Claude Code files as the user's without the user having typed them.
BOOKKEEPING_TURN = re.compile(
    r"^\s*(<(command-name|command-message|local-command|system-reminder|bash-input|bash-stdout|bash-stderr|"
    r"task-notification|user-prompt-submit-hook)|\[Request interrupted)"
)


def project_slug(cwd: str) -> str:
    """How Claude Code names a working directory's folder: anything but a letter or digit becomes a dash."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd.rstrip("\\/"))


def transcript_by_session(session_id: Optional[str]) -> Optional[str]:
    if not session_id or not re.fullmatch(r"[A-Za-z0-9-]+", session_id) or not os.path.isdir(PROJECTS_DIR):
        return None
    for name in os.listdir(PROJECTS_DIR):
        candidate = os.path.join(PROJECTS_DIR, name, session_id + ".jsonl")
        if os.path.isfile(candidate):
            return candidate
    return None


def session_of_process(pid: int) -> Optional[str]:
    """Claude Code leaves a note per process with the session it is running."""
    try:
        with open(os.path.join(SESSIONS_DIR, f"{pid}.json"), "r", encoding="utf-8") as f:
            return json.load(f).get("sessionId")
    except Exception:
        return None


def newest_transcript_for(cwd: str) -> Optional[str]:
    folder = os.path.join(PROJECTS_DIR, project_slug(cwd))
    if not os.path.isdir(folder):
        return None
    files = [os.path.join(folder, n) for n in os.listdir(folder) if n.endswith(".jsonl")]
    files = [f for f in files if os.path.isfile(f)]
    return max(files, key=os.path.getmtime) if files else None


def resolve_transcript(pane_id: str) -> Optional[Dict[str, Any]]:
    """
    The transcript behind a pane, and how it was matched: by the session id
    the agent reported to Herdr, by the agent's own process, or, failing
    both, the newest one for the pane's directory.
    """
    cached = TRANSCRIPT_LOOKUP.get(pane_id)
    if cached and cached["expires"] > time.time():
        return cached["found"]

    found = None
    pane = next((p for p in (latest_snapshot or {}).get("panes", []) if p.get("pane_id") == pane_id), None)
    if pane:
        path = transcript_by_session((pane.get("agent_session") or {}).get("value"))
        if path:
            found = {"path": path, "match": "session"}
        if not found:
            try:
                info = herdr_client.call("pane.process_info", {"pane_id": pane_id}) or {}
                for proc in (info.get("process_info") or {}).get("foreground_processes", []):
                    if str(proc.get("name", "")).lower().startswith("claude"):
                        path = transcript_by_session(session_of_process(int(proc["pid"])))
                        if path:
                            found = {"path": path, "match": "process"}
                            break
            except Exception:
                pass
        if not found and pane.get("cwd"):
            path = newest_transcript_for(pane["cwd"])
            if path:
                found = {"path": path, "match": "cwd"}
    if found:
        found["session"] = os.path.splitext(os.path.basename(found["path"]))[0]

    TRANSCRIPT_LOOKUP[pane_id] = {"expires": time.time() + TRANSCRIPT_LOOKUP_TTL, "found": found}
    return found


def describe_tool(name: str, params: Dict[str, Any]) -> str:
    """One quiet line per tool call, the way the desktop shows it."""
    def base(value: Any) -> str:
        text = str(value or "").rstrip("\\/")
        return os.path.basename(text) or text

    if name == "Read":
        return f"Letto {base(params.get('file_path'))}"
    if name == "Edit":
        return f"Modificato {base(params.get('file_path'))}"
    if name == "Write":
        return f"Scritto {base(params.get('file_path'))}"
    if name in ("Bash", "PowerShell"):
        return (params.get("description") or str(params.get("command") or "")[:80] or name).strip()
    if name in ("Grep", "Glob"):
        return f"Cercato {params.get('pattern', '')}"[:100]
    if name == "Agent":
        return f"Agente: {params.get('description') or ''}".rstrip(": ")
    if name == "WebFetch":
        return f"Aperto {params.get('url', '')}"[:100]
    if name == "WebSearch":
        return f"Cercato sul web: {params.get('query', '')}"[:100]
    if name == "SendUserFile":
        return f"Inviato {base(params.get('path') or params.get('file_path'))}"
    if name == "Skill":
        return f"Skill {params.get('skill', '')}"
    return name


def turns_from_line(line: str) -> List[Dict[str, Any]]:
    """
    The conversation turns in one transcript line, usually none.

    Tool results are the bulk of the file and are not conversation; they are
    recognised from the first bytes and never parsed. Thinking is skipped too.
    """
    # The role sits near the start of the message; the entry's own type comes
    # after the message, which for a reply can be pages long.
    head = line[:700]
    if '"role":"user"' in head:
        kind = "user"
    elif '"role":"assistant"' in head:
        kind = "assistant"
    else:
        return []
    if '"isSidechain":true' in head or '"isMeta":true' in head:
        return []
    if kind == "user" and '"tool_use_id"' in line[:900]:
        return []
    try:
        entry = json.loads(line)
    except Exception:
        return []
    if entry.get("type") not in ("user", "assistant"):
        return []
    message = entry.get("message") or {}
    content = message.get("content")
    stamp = entry.get("timestamp")

    # After a compaction Claude Code files its own summary of the conversation
    # so far as if the user had typed it. It is pages of markdown the reader
    # never wrote; what matters to them is that the agent's memory was cut here.
    if kind == "user" and entry.get("isCompactSummary"):
        return [{"role": "system", "text": "Contesto riassunto: da qui l'agente ricorda solo un riepilogo.", "time": stamp}]

    if kind == "user":
        images = 0
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                return []
            text = "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
            images = sum(1 for b in content if isinstance(b, dict) and b.get("type") == "image")
        else:
            return []
        text = text.strip()
        if (not text and not images) or BOOKKEEPING_TURN.match(text):
            return []
        return [{"role": "user", "text": text, "images": images, "time": stamp}]

    if not isinstance(content, list):
        return []
    turns: List[Dict[str, Any]] = []
    mid = message.get("id")
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and str(block.get("text", "")).strip():
            turns.append({"role": "assistant", "text": str(block["text"]).strip(), "time": stamp, "mid": mid})
        elif block.get("type") == "tool_use":
            name = str(block.get("name", ""))
            turns.append({"role": "tool", "name": name, "text": describe_tool(name, block.get("input") or {}), "time": stamp})
    return turns


def read_transcript(path: str) -> List[Dict[str, Any]]:
    """
    Every turn so far. The file is read once and then only from where the
    previous read stopped: a long session's transcript runs to tens of
    megabytes, and the phone asks every few seconds.
    """
    with TRANSCRIPT_LOCK:
        state = TRANSCRIPT_CACHE.get(path)
        size = os.path.getsize(path)
        if state is None or size < state["offset"]:
            state = {"offset": 0, "partial": b"", "turns": []}
            TRANSCRIPT_CACHE[path] = state
        if size == state["offset"]:
            return state["turns"]
        with open(path, "rb") as f:
            f.seek(state["offset"])
            data = state["partial"] + f.read()
        lines = data.split(b"\n")
        state["partial"] = lines.pop()  # an unfinished line waits for the rest
        state["offset"] = size - len(state["partial"])
        turns = state["turns"]
        for raw in lines:
            if not raw.strip():
                continue
            for turn in turns_from_line(raw.decode("utf-8", errors="replace")):
                previous = turns[-1] if turns else None
                # The blocks of one reply arrive as separate lines; they are one turn.
                if (
                    turn["role"] == "assistant"
                    and previous is not None
                    and previous["role"] == "assistant"
                    and previous.get("mid") == turn.get("mid")
                ):
                    previous["text"] += "\n\n" + turn["text"]
                    continue
                turn["seq"] = len(turns)
                turns.append(turn)
        return turns


@app.get("/api/panes/{pane_id}/history")
def pane_history(pane_id: str, after: int = 0):
    found = resolve_transcript(pane_id)
    if not found:
        raise HTTPException(status_code=404, detail="Nessuna trascrizione per questa finestra")
    try:
        turns = read_transcript(found["path"])
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))
    page = [{k: v for k, v in turn.items() if k != "mid"} for turn in turns[max(0, after):]]
    return {"pane_id": pane_id, "session": found["session"], "match": found["match"], "total": len(turns), "turns": page}


def original_filename(field: Optional[str], part_name: Optional[str]) -> str:
    """
    The name to save the file under, derived from the name it had on the phone.

    The app sends that name as its own form field because the multipart
    filename is percent-encoded by the mobile fetch ("nome%20file.txt"), and a
    file saved under that name is not the file the user picked. Older builds
    send only the multipart name, so an encoded one is decoded rather than kept.

    Whitespace becomes an underscore: the reference handed back is "@uploads/…"
    and the agent reads it as one token, so a space inside it would cut the
    path short.
    """
    if field:
        name = field
    elif part_name:
        name = unquote(part_name) if "%" in part_name else part_name
    else:
        return "uploaded_file"
    return re.sub(r"\s+", "_", os.path.basename(name).strip())


@app.post("/api/upload")
async def upload_file(
    file: UploadFile = File(...),
    workspace_id: Optional[str] = Form(None),
    pane_id: Optional[str] = Form(None),
    filename: Optional[str] = Form(None),
):
    try:
        base_cwd = resolve_upload_cwd(workspace_id, pane_id)
        upload_dir = (
            os.path.join(base_cwd, "uploads")
            if base_cwd
            else os.path.expanduser(r"~\Downloads\herdr_uploads")
        )
        os.makedirs(upload_dir, exist_ok=True)
        safe_name = original_filename(filename, file.filename) or "uploaded_file"
        target_path = os.path.join(upload_dir, safe_name)

        # Ensure unique filename
        base, ext = os.path.splitext(safe_name)
        counter = 1
        while os.path.exists(target_path):
            target_path = os.path.join(upload_dir, f"{base}_{counter}{ext}")
            counter += 1

        contents = await file.read()
        with open(target_path, "wb") as f:
            f.write(contents)

        # The agent resolves "@..." against its own working directory, so the
        # reference has to carry the "uploads/" segment the file actually sits in.
        if base_cwd:
            relative = os.path.relpath(target_path, base_cwd).replace("\\", "/")
            rel_ref = f"@{relative}"
        else:
            rel_ref = target_path

        return {
            "status": "ok",
            "filename": os.path.basename(target_path),
            "path": target_path,
            "rel_ref": rel_ref,
            "size": len(contents)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/panes/{pane_id}/interrupt")
def interrupt_pane(pane_id: str):
    """Interrupt/cancel running agent response by sending Escape key and ASCII 27."""
    errs = []
    try:
        herdr_client.call("pane.send_keys", {"pane_id": pane_id, "keys": ["Escape"]})
    except Exception as e:
        errs.append(str(e))
    try:
        herdr_client.call("pane.send_text", {"pane_id": pane_id, "text": "\x1b"})
    except Exception as e:
        errs.append(str(e))
    return {"status": "ok", "errors": errs}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_handler(websocket: WebSocket):
    await ws_manager.connect(websocket)
    if latest_snapshot:
        await websocket.send_json({"type": "snapshot_update", "snapshot": latest_snapshot})

    try:
        while True:
            msg = await websocket.receive_json()
            action = msg.get("action")

            if action == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if action in ("subscribe_pane", "subscribe_panes"):
                pane_id = msg.get("pane_id")
                pane_ids = msg.get("pane_ids")
                to_sub = set()
                if pane_id:
                    to_sub.add(pane_id)
                if pane_ids and isinstance(pane_ids, list):
                    to_sub.update(pane_ids)
                if to_sub:
                    await ws_manager.set_pane_subscription(websocket, to_sub)
                    for pid in to_sub:
                        try:
                            read_res = await asyncio.to_thread(
                                herdr_client.call,
                                "pane.read",
                                {"pane_id": pid, "source": "recent", "format": "ansi", "lines": READ_LINES}
                            )
                            text = read_res.get("read", {}).get("text", "") if read_res else ""
                            if text:
                                cached_pane_texts[pid] = text
                                await websocket.send_json({
                                    "type": "terminal_data",
                                    "pane_id": pid,
                                    "text": text,
                                })
                        except Exception:
                            pass

            elif action == "send_text":
                pane_id = msg.get("pane_id")
                text = msg.get("text", "")
                if pane_id and text:
                    await asyncio.to_thread(herdr_client.call, "pane.send_text", {"pane_id": pane_id, "text": text})
                    try:
                        read_res = await asyncio.to_thread(
                            herdr_client.call,
                            "pane.read",
                            {"pane_id": pane_id, "source": "recent", "format": "ansi", "lines": READ_LINES}
                        )
                        t = read_res.get("read", {}).get("text", "") if read_res else ""
                        if t:
                            cached_pane_texts[pane_id] = t
                            await websocket.send_json({
                                "type": "terminal_data",
                                "pane_id": pane_id,
                                "text": t,
                            })
                    except Exception:
                        pass

            elif action == "send_keys":
                pane_id = msg.get("pane_id")
                keys = msg.get("keys", [])
                if pane_id and keys:
                    await asyncio.to_thread(herdr_client.call, "pane.send_keys", {"pane_id": pane_id, "keys": keys})
                    try:
                        read_res = await asyncio.to_thread(
                            herdr_client.call,
                            "pane.read",
                            {"pane_id": pane_id, "source": "recent", "format": "ansi", "lines": READ_LINES}
                        )
                        t = read_res.get("read", {}).get("text", "") if read_res else ""
                        if t:
                            cached_pane_texts[pane_id] = t
                            await websocket.send_json({
                                "type": "terminal_data",
                                "pane_id": pane_id,
                                "text": t,
                            })
                    except Exception:
                        pass

    except WebSocketDisconnect:
        await ws_manager.disconnect(websocket)
    except Exception:
        await ws_manager.disconnect(websocket)


# ---------------------------------------------------------------------------
# Authentic Herdr TUI Web Client
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
def get_herdr_tui_page():
    local_ip = get_local_ip()
    return f"""<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>Herdr</title>
    <link rel="stylesheet" href="/static/xterm.css">
    <script src="/static/xterm.js"></script>
    <script src="/static/xterm-addon-fit.js"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {{
            --bg-main: #181926;
            --bg-sidebar: #13141f;
            --border-color: #212334;
            --active-space: #2b2d42;
            --active-tab: #515694;
            --inactive-tab: #222438;
            --text-primary: #e2e8f0;
            --text-muted: #828a9e;
            --green: #10b981;
            --cyan: #38bdf8;
            --pink: #f472b6;
            --amber: #fbbf24;
            --font-mono: 'JetBrains Mono', monospace;
        }}
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            -webkit-tap-highlight-color: transparent;
        }}
        body {{
            background: var(--bg-main);
            color: var(--text-primary);
            font-family: var(--font-mono);
            height: 100vh;
            width: 100vw;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            user-select: none;
        }}

        /* App Shell Layout */
        .app-container {{
            flex: 1;
            display: flex;
            height: 100%;
            width: 100%;
            position: relative;
            overflow: hidden;
        }}

        /* Left Sidebar: Spaces & Agents */
        aside.sidebar {{
            width: 250px;
            background: var(--bg-sidebar);
            border-right: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            z-index: 100;
            transition: transform 0.22s ease-in-out;
            height: 100%;
            flex-shrink: 0;
        }}
        @media (max-width: 768px) {{
            aside.sidebar {{
                position: absolute;
                top: 0;
                bottom: 0;
                left: 0;
                transform: translateX(-100%);
                box-shadow: 10px 0 30px rgba(0,0,0,0.7);
            }}
            aside.sidebar.open {{
                transform: translateX(0);
            }}
        }}

        .sidebar-section-title {{
            font-size: 13px;
            font-weight: 600;
            color: var(--text-muted);
            padding: 14px 16px 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }}
        .sidebar-section-title span.dim {{
            font-size: 11px;
            color: #555b72;
            cursor: pointer;
        }}

        .spaces-list, .agents-list {{
            overflow-y: auto;
            flex: 1;
            padding: 0 8px;
        }}
        .spaces-list {{
            max-height: 48%;
            border-bottom: 1px solid var(--border-color);
        }}
        .agents-list {{
            flex: 1;
        }}

        /* Space Item */
        .space-item {{
            padding: 6px 10px;
            border-radius: 6px;
            margin-bottom: 2px;
            cursor: pointer;
            display: flex;
            align-items: flex-start;
            gap: 10px;
            transition: background 0.12s;
        }}
        .space-item.active {{
            background: var(--active-space);
        }}
        .space-item:active {{
            opacity: 0.8;
        }}
        .status-dot {{
            width: 7px;
            height: 7px;
            border-radius: 50%;
            margin-top: 6px;
            flex-shrink: 0;
        }}
        .dot-green {{
            border: 1.5px solid var(--green);
            background: transparent;
        }}
        .dot-gray {{
            background: #555b72;
        }}
        .dot-amber {{
            background: var(--amber);
            box-shadow: 0 0 6px var(--amber);
        }}

        .space-info {{
            display: flex;
            flex-direction: column;
            overflow: hidden;
            white-space: nowrap;
        }}
        .space-label {{
            font-size: 13px;
            color: #d1d5db;
            text-overflow: ellipsis;
            overflow: hidden;
        }}
        .space-branch {{
            font-size: 11px;
            color: #6b7280;
            display: flex;
            align-items: center;
            gap: 4px;
        }}
        .branch-ahead {{
            color: var(--green);
        }}

        .sidebar-footer {{
            padding: 10px 14px;
            border-top: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 12px;
            color: var(--text-muted);
        }}
        .btn-new-space {{
            cursor: pointer;
            color: #94a3b8;
        }}
        .btn-menu {{
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
        }}
        .menu-dot {{
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #8b5cf6;
        }}

        /* Agent Item */
        .agent-item {{
            padding: 6px 10px;
            border-radius: 6px;
            margin-bottom: 2px;
            cursor: pointer;
            display: flex;
            align-items: flex-start;
            gap: 10px;
            transition: background 0.12s;
        }}
        .agent-item:active {{
            background: rgba(255,255,255,0.05);
        }}
        .agent-info {{
            display: flex;
            flex-direction: column;
            overflow: hidden;
            white-space: nowrap;
        }}
        .agent-title {{
            font-size: 12px;
            color: #e2e8f0;
            text-overflow: ellipsis;
            overflow: hidden;
        }}
        .agent-sub {{
            font-size: 11px;
            color: #6b7280;
        }}

        /* Main Workspace & Terminal Area */
        main.workspace-area {{
            flex: 1;
            display: flex;
            flex-direction: column;
            background: var(--bg-main);
            overflow: hidden;
            position: relative;
        }}

        /* Top Tab Bar */
        header.tabs-bar {{
            height: 38px;
            background: #151622;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            padding: 0 10px;
            gap: 6px;
            flex-shrink: 0;
        }}
        .btn-sidebar-toggle {{
            background: none;
            border: none;
            color: var(--text-muted);
            font-size: 18px;
            cursor: pointer;
            padding: 4px 8px;
            margin-right: 4px;
            display: none;
        }}
        @media (max-width: 768px) {{
            .btn-sidebar-toggle {{
                display: block;
            }}
        }}

        .tab-pill {{
            padding: 4px 14px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 500;
            color: var(--text-muted);
            background: var(--inactive-tab);
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
        }}
        .tab-pill.active {{
            background: var(--active-tab);
            color: #ffffff;
        }}
        .tab-add {{
            padding: 4px 10px;
            cursor: pointer;
            color: var(--text-muted);
            font-size: 14px;
        }}

        /* Terminal Container */
        .terminal-container {{
            flex: 1;
            padding: 4px 6px;
            background: var(--bg-main);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            position: relative;
            cursor: text;
        }}
        #xterm-viewport {{
            flex: 1;
            width: 100%;
            height: 100%;
        }}
        .xterm {{
            height: 100%;
            padding: 2px;
        }}
        .xterm-viewport {{
            background-color: var(--bg-main) !important;
        }}

        /* Mobile direct terminal typing support */
        .xterm-helper-textarea {{
            position: absolute !important;
            opacity: 0 !important;
            left: 0 !important;
            top: 0 !important;
            width: 1px !important;
            height: 1px !important;
            font-size: 16px !important;
            pointer-events: auto !important;
            z-index: 50 !important;
            user-select: text !important;
            -webkit-user-select: text !important;
        }}

        /* Bottom Herdr Status Footer */
        footer.status-footer {{
            height: 24px;
            background: #11121b;
            border-top: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: flex-end;
            padding: 0 14px;
            gap: 16px;
            font-size: 11px;
            flex-shrink: 0;
        }}
        .status-badge-orange {{
            color: #f97316;
            display: flex;
            align-items: center;
            gap: 4px;
        }}
        .status-badge-cyan {{
            color: var(--cyan);
            display: flex;
            align-items: center;
            gap: 4px;
        }}
        .status-badge-euro {{
            color: #94a3b8;
        }}

        /* Overlay for mobile sidebar */
        .sidebar-overlay {{
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.6);
            z-index: 90;
            display: none;
        }}
        .sidebar-overlay.show {{
            display: block;
        }}
    </style>
</head>
<body>

    <div class="sidebar-overlay" id="overlay" onclick="toggleSidebar()"></div>

    <div class="app-container">
        <!-- LEFT HERDR SIDEBAR -->
        <aside class="sidebar" id="sidebar">
            <div class="sidebar-section-title">
                <span>spaces</span>
            </div>
            <div class="spaces-list" id="spaces-list">
                <!-- Injected spaces -->
            </div>
            <div class="sidebar-footer">
                <span class="btn-new-space" onclick="createNewSpacePrompt()">new</span>
                <span class="btn-menu"><span class="menu-dot"></span> menu</span>
            </div>

            <div class="sidebar-section-title">
                <span>agents</span>
                <span class="dim">priority</span>
            </div>
            <div class="agents-list" id="agents-list">
                <!-- Injected agents -->
            </div>
        </aside>

        <!-- MAIN TERMINAL AREA -->
        <main class="workspace-area">
            <!-- Workspace Tabs -->
            <header class="tabs-bar">
                <button class="btn-sidebar-toggle" onclick="toggleSidebar()">☰</button>
                <div id="tabs-container" style="display: flex; gap: 6px; align-items: center; overflow-x: auto;">
                    <!-- Injected tabs -->
                </div>
                <div class="tab-add" onclick="createNewTab()">+</div>
            </header>

            <!-- Real xterm.js Terminal Canvas -->
            <div class="terminal-container" id="terminal-container">
                <div id="xterm-viewport"></div>
            </div>

            <!-- Bottom Herdr Status Line -->
            <footer class="status-footer">
                <span class="status-badge-orange">🟧 LIMITED</span>
                <span class="status-badge-orange">⚙️ LIMITED</span>
                <span class="status-badge-cyan">✦ 92% (52m)</span>
                <span class="status-badge-euro">≈ €12,407.65</span>
            </footer>
        </main>
    </div>

    <script>
        let currentSnapshot = null;
        let activeWorkspaceId = null;
        let activeTabId = null;
        let activePaneId = null;
        let term = null;
        let fitAddon = null;

        // Initialize xterm.js matching Herdr's look
        function initTerminal() {{
            term = new Terminal({{
                cursorBlink: true,
                cursorStyle: 'block',
                fontFamily: "'JetBrains Mono', 'Menlo', monospace",
                fontSize: 13,
                lineHeight: 1.25,
                theme: {{
                    background: '#181926',
                    foreground: '#e2e8f0',
                    cursor: '#ffffff',
                    black: '#1e2030',
                    red: '#f87171',
                    green: '#4ade80',
                    yellow: '#facc15',
                    blue: '#60a5fa',
                    magenta: '#f472b6',
                    cyan: '#38bdf8',
                    white: '#f3f4f6',
                    brightBlack: '#475569',
                    brightGreen: '#22c55e',
                    brightCyan: '#00d2ff'
                }}
            }});

            fitAddon = new FitAddon.FitAddon();
            term.loadAddon(fitAddon);
            term.open(document.getElementById('xterm-viewport'));
            fitAddon.fit();

            const fitTerminal = () => {{
                try {{ fitAddon.fit(); }} catch (e) {{}}
            }};

            window.addEventListener('resize', fitTerminal);
            if (window.visualViewport) {{
                window.visualViewport.addEventListener('resize', fitTerminal);
            }}

            // Send keystrokes directly to active pane shell
            term.onData(data => {{
                if (activePaneId) {{
                    sendSocketMessage({{
                        action: 'send_text',
                        pane_id: activePaneId,
                        text: data
                    }});
                }}
            }});

            // Tap anywhere in terminal to focus and summon mobile keyboard
            const termContainer = document.getElementById('terminal-container');
            const focusTerminal = (e) => {{
                if (term) {{
                    term.focus();
                    const helper = document.querySelector('.xterm-helper-textarea');
                    if (helper) {{
                        helper.focus();
                    }}
                }}
            }};
            termContainer.addEventListener('click', focusTerminal);
            termContainer.addEventListener('touchend', focusTerminal);

            // Clean mobile textarea attributes
            setTimeout(() => {{
                const helper = document.querySelector('.xterm-helper-textarea');
                if (helper) {{
                    helper.setAttribute('autocapitalize', 'none');
                    helper.setAttribute('autocomplete', 'off');
                    helper.setAttribute('autocorrect', 'off');
                    helper.setAttribute('spellcheck', 'false');
                }}
            }}, 100);
        }}

        // WebSocket Connection
        const wsUrl = `ws://${{window.location.host}}/ws`;
        let ws = null;

        function connectWS() {{
            ws = new WebSocket(wsUrl);

            ws.onopen = () => {{
                if (activePaneId) {{
                    subscribeToPane(activePaneId);
                }}
            }};

            ws.onmessage = (event) => {{
                try {{
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'snapshot_update') {{
                        currentSnapshot = msg.snapshot;
                        renderSpacesAndTabs();
                    }} else if (msg.type === 'terminal_data') {{
                        if (msg.pane_id === activePaneId && msg.text) {{
                            renderTerminalAnsi(msg.text);
                        }}
                    }}
                }} catch (e) {{
                    console.error('WS parse error:', e);
                }}
            }};

            ws.onclose = () => {{
                setTimeout(connectWS, 2000);
            }};
        }}

        function sendSocketMessage(payload) {{
            if (ws && ws.readyState === WebSocket.OPEN) {{
                ws.send(JSON.stringify(payload));
            }}
        }}

        function subscribeToPane(paneId) {{
            activePaneId = paneId;
            sendSocketMessage({{ action: 'subscribe_pane', pane_id: paneId }});
        }}

        function renderTerminalAnsi(ansiText) {{
            if (!term) return;
            term.reset();
            const formatted = ansiText.replace(/\\r?\\n/g, '\\r\\n');
            term.write(formatted);
        }}

        // Render Herdr Sidebar Spaces, Tabs, Agents
        function renderSpacesAndTabs() {{
            if (!currentSnapshot) return;

            const spaces = currentSnapshot.workspaces || [];
            const panes = currentSnapshot.panes || [];
            const tabs = currentSnapshot.tabs || [];

            // Default to first or focused space
            if (!activeWorkspaceId && spaces.length > 0) {{
                const focused = spaces.find(s => s.focused);
                activeWorkspaceId = focused ? focused.workspace_id : spaces[0].workspace_id;
            }}

            // 1. Render Spaces in Sidebar
            const spacesContainer = document.getElementById('spaces-list');
            spacesContainer.innerHTML = spaces.map(s => {{
                const isActive = s.workspace_id === activeWorkspaceId;
                const hasAgent = s.agent_status === 'working' || s.agent_status === 'idle';
                const isBlocked = s.agent_status === 'blocked';
                const dotClass = isBlocked ? 'dot-amber' : (hasAgent ? 'dot-green' : 'dot-gray');

                return `
                    <div class="space-item ${{isActive ? 'active' : ''}}" onclick="selectWorkspace('${{s.workspace_id}}')">
                        <div class="status-dot ${{dotClass}}"></div>
                        <div class="space-info">
                            <span class="space-label">${{escapeHtml(s.label)}}</span>
                            ${{s.git_branch ? `<span class="space-branch">${{escapeHtml(s.git_branch)}}</span>` : ''}}
                        </div>
                    </div>
                `;
            }}).join('');

            // 2. Render Tabs for current active space
            const tabsContainer = document.getElementById('tabs-container');
            const currentTabs = tabs.filter(t => t.workspace_id === activeWorkspaceId);

            if (!activeTabId && currentTabs.length > 0) {{
                activeTabId = currentTabs[0].tab_id;
            }}

            tabsContainer.innerHTML = currentTabs.map(t => {{
                const isTabActive = t.tab_id === activeTabId;
                const label = t.label || t.number;
                return `
                    <div class="tab-pill ${{isTabActive ? 'active' : ''}}" onclick="selectTab('${{t.tab_id}}')">
                        ${{escapeHtml(label)}}
                    </div>
                `;
            }}).join('');

            // 3. Find active pane for selected tab
            const currentPanes = panes.filter(p => p.tab_id === activeTabId);
            if (currentPanes.length > 0) {{
                const p = currentPanes[0];
                if (p.pane_id !== activePaneId) {{
                    subscribeToPane(p.pane_id);
                }}
            }}

            // 4. Render ONLY Active Agents in Sidebar
            const agentsContainer = document.getElementById('agents-list');
            let activeAgents = (currentSnapshot.agents && currentSnapshot.agents.length > 0)
                ? currentSnapshot.agents.filter(a => a.agent && a.agent_status !== 'unknown')
                : panes.filter(p => p.agent && p.agent_status && p.agent_status !== 'unknown');

            // Sort by priority (blocked first, then working, then idle)
            const priorityWeight = {{ 'blocked': 0, 'working': 1, 'idle': 2, 'done': 3 }};
            activeAgents.sort((a, b) => {{
                const wa = priorityWeight[a.agent_status] ?? 99;
                const wb = priorityWeight[b.agent_status] ?? 99;
                return wa - wb;
            }});

            if (activeAgents.length === 0) {{
                agentsContainer.innerHTML = '<div style="color:var(--text-muted); font-size:11px; padding:12px 8px; text-align:center;">Nessun agente attivo</div>';
            }} else {{
                agentsContainer.innerHTML = activeAgents.map(p => {{
                    const space = spaces.find(s => s.workspace_id === p.workspace_id);
                    const spaceName = space ? space.label : 'Space';
                    const tab = tabs.find(t => t.tab_id === p.tab_id);
                    const tabLabel = tab ? (tab.label || tab.number) : '';
                    const agentName = p.agent || 'agent';
                    const isBlocked = p.agent_status === 'blocked';
                    const dotClass = isBlocked ? 'dot-amber' : 'dot-green';

                    return `
                        <div class="agent-item" onclick="focusAgentPane('${{p.workspace_id}}', '${{p.tab_id}}', '${{p.pane_id}}')">
                            <div class="status-dot ${{dotClass}}"></div>
                            <div class="agent-info">
                                <span class="agent-title">${{escapeHtml(spaceName)}} · ${{escapeHtml(tabLabel)}}</span>
                                <span class="agent-sub">${{escapeHtml(agentName)}}</span>
                            </div>
                        </div>
                    `;
                }}).join('');
            }}
        }}

        function selectWorkspace(wsId) {{
            activeWorkspaceId = wsId;
            activeTabId = null;
            renderSpacesAndTabs();
            // Close sidebar on mobile
            if (window.innerWidth <= 768) toggleSidebar();
            // Tell Herdr to focus workspace
            fetch(`/api/workspaces/${{wsId}}/focus`, {{ method: 'POST' }}).catch(() => {{}});
        }}

        function selectTab(tabId) {{
            activeTabId = tabId;
            renderSpacesAndTabs();
            fetch(`/api/tabs/${{tabId}}/focus`, {{ method: 'POST' }}).catch(() => {{}});
        }}

        function focusAgentPane(wsId, tabId, paneId) {{
            activeWorkspaceId = wsId;
            activeTabId = tabId;
            subscribeToPane(paneId);
            renderSpacesAndTabs();
            if (window.innerWidth <= 768) toggleSidebar();
            fetch(`/api/panes/${{paneId}}/focus`, {{ method: 'POST' }}).catch(() => {{}});
        }}

        function sendKey(key) {{
            if (!activePaneId) return;
            sendSocketMessage({{
                action: 'send_keys',
                pane_id: activePaneId,
                keys: [key]
            }});
        }}

        function createNewSpacePrompt() {{
            const name = prompt('Nome del nuovo workspace:');
            if (name) {{
                fetch('/api/workspaces', {{
                    method: 'POST',
                    headers: {{ 'Content-Type': 'application/json' }},
                    body: JSON.stringify({{ label: name, focus: true }})
                }}).catch(() => {{}});
            }}
        }}

        async function createNewTab() {{
            const targetWsId = activeWorkspaceId || (currentSnapshot && currentSnapshot.workspaces && currentSnapshot.workspaces[0] ? currentSnapshot.workspaces[0].workspace_id : null);
            if (!targetWsId) return;

            try {{
                const res = await fetch('/api/tabs', {{
                    method: 'POST',
                    headers: {{ 'Content-Type': 'application/json' }},
                    body: JSON.stringify({{ workspace_id: targetWsId, focus: true }})
                }});
                const data = await res.json();
                if (data && data.tab && data.tab.tab_id) {{
                    activeTabId = data.tab.tab_id;
                    if (data.root_pane && data.root_pane.pane_id) {{
                        activePaneId = data.root_pane.pane_id;
                        subscribeToPane(data.root_pane.pane_id);
                    }}
                    const snapRes = await fetch('/api/snapshot');
                    currentSnapshot = await snapRes.json();
                    renderSpacesAndTabs();
                }}
            }} catch (e) {{
                console.error('Error creating tab:', e);
            }}
        }}

        function toggleSidebar() {{
            const sidebar = document.getElementById('sidebar');
            const overlay = document.getElementById('overlay');
            sidebar.classList.toggle('open');
            overlay.classList.toggle('show');
            setTimeout(() => fitAddon.fit(), 250);
        }}

        function escapeHtml(str) {{
            return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }}

        // Start
        window.addEventListener('DOMContentLoaded', () => {{
            initTerminal();
            connectWS();
        }});
    </script>
</body>
</html>"""


def run_bridge():
    local_ip = get_local_ip()
    print("=" * 60)
    print("      🦙 HERDR AUTHENTIC TUI TERMINAL DAEMON")
    print("=" * 60)
    print(f"  Local IP Address : http://{local_ip}:{PORT}")
    print(f"  Localhost URL    : http://127.0.0.1:{PORT}")
    print(f"  WebSocket Stream : ws://{local_ip}:{PORT}/ws")
    print("=" * 60)
    print(f"  Open http://{local_ip}:{PORT} on your phone to connect!")
    print("=" * 60)

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=PORT,
        log_level="warning",
        ws_ping_interval=10,
        ws_ping_timeout=15,
        timeout_keep_alive=30,
    )


if __name__ == "__main__":
    run_bridge()
