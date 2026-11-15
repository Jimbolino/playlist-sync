#!/usr/bin/env python3
"""
Read scraped tracks from SQLite and sync to YouTube Music (ytmusicapi) and/or Spotify (spotapi).

Auth via project root .env:
  YTMUSIC_HEADERS_PATH  — ytmusicapi auth file: browser headers JSON *or* oauth.json from ``ytmusicapi oauth``
  For oauth.json you must also set YOUTUBE_OAUTH_CLIENT_ID and YOUTUBE_OAUTH_CLIENT_SECRET (GCP OAuth client,
  type \"TVs and Limited Input devices\"). Browser headers often still work for search but playlist edits return HTTP 403.
  SPOTIFY_SESSION_PATH  — JSON with \"identifier\" and \"cookies\" (SpotAPI cookie dump; list wraps one object)

Requires: pip install -r python/requirements.txt
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Mapping
from typing import Any

try:
    from dotenv import load_dotenv as _load_dotenv
except ImportError:
    def _load_dotenv(*_a: Any, **_k: Any) -> bool:
        return False


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def load_env() -> None:
    _load_dotenv(PROJECT_ROOT / ".env")


def resolve_path(p: str | Path) -> Path:
    path = Path(p)
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return path.resolve()


def database_path_from_env_or_arg(db_arg: str | None) -> Path:
    raw = db_arg or os.environ.get("DATABASE_URL", "file:./data/scraper.db")
    if raw.startswith("file:"):
        raw = raw[5:]
    path = Path(raw)
    if not path.is_absolute():
        path = Path.cwd() / path
    return path.resolve()


@dataclass(frozen=True)
class Track:
    item_id: int
    title: str
    artist: str | None
    spotify_track_id: str | None
    isrc: str | None
    dedupe_key: str


SPOTIFY_TRACK_RE = re.compile(
    r"(?:https?://open\.spotify\.com/track/|spotify:track:)([a-zA-Z0-9]+)"
)


def norm(s: str | None) -> str:
    if not s:
        return ""
    return " ".join(s.lower().split())


def parse_payload(payload_raw: str | bytes) -> dict[str, Any]:
    if isinstance(payload_raw, bytes):
        payload_raw = payload_raw.decode("utf-8")
    data = json.loads(payload_raw)
    if not isinstance(data, dict):
        return {}
    return data


def track_from_payload(item_id: int, payload: dict[str, Any]) -> Track | None:
    kind = payload.get("kind")
    title: str | None = None
    artist: str | None = None
    spotify_track_id: str | None = None
    isrc: str | None = None

    if kind == "nl538_house_csv":
        song = payload.get("song")
        if isinstance(song, str) and song.strip():
            title = song.strip()
        artist_val = payload.get("artist")
        if isinstance(artist_val, str) and artist_val.strip():
            artist = artist_val.strip()
        isrc_val = payload.get("isrc")
        if isinstance(isrc_val, str) and isrc_val.strip():
            isrc = isrc_val.strip()
    elif kind == "nl538_house":
        url = payload.get("spotifyUrl")
        if isinstance(url, str):
            m = SPOTIFY_TRACK_RE.search(url)
            if m:
                spotify_track_id = m.group(1)
        t = payload.get("title")
        if isinstance(t, str) and t.strip():
            title = t.strip()
    else:
        return None

    if not title and not spotify_track_id:
        return None

    if not title:
        title = spotify_track_id or "unknown"

    if spotify_track_id:
        dedupe = f"spotify:{spotify_track_id}"
    elif isrc:
        dedupe = f"isrc:{isrc.lower()}"
    else:
        dedupe = f"text:{norm(artist)}|{norm(title)}"

    return Track(
        item_id=item_id,
        title=title,
        artist=artist,
        spotify_track_id=spotify_track_id,
        isrc=isrc,
        dedupe_key=dedupe,
    )


def load_tracks(
    db_path: Path,
    *,
    run_id: int | None,
    adapter: str | None,
    allow_all: bool,
) -> list[Track]:
    if not allow_all and run_id is None and adapter is None:
        print(
            "Refusing to sync: pass --run-id and/or --adapter, or --allow-all.",
            file=sys.stderr,
        )
        sys.exit(2)

    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        sql = """
            SELECT items.id, items.payload
            FROM items
            LEFT JOIN sources ON items.source_id = sources.id
            WHERE 1 = 1
        """
        params: list[Any] = []
        if run_id is not None:
            sql += " AND items.run_id = ?"
            params.append(run_id)
        if adapter is not None:
            sql += " AND sources.adapter_id = ?"
            params.append(adapter)

        cur.execute(sql, params)
        rows = cur.fetchall()
    finally:
        conn.close()

    seen: set[str] = set()
    out: list[Track] = []
    for item_id, payload_raw in rows:
        payload = parse_payload(payload_raw)
        t = track_from_payload(int(item_id), payload)
        if t is None:
            continue
        if t.dedupe_key in seen:
            continue
        seen.add(t.dedupe_key)
        out.append(t)
    return out


def first_spotify_track_id_from_search(data: Any) -> str | None:
    """Walk Spotify search JSON for the first spotify:track URI."""
    if isinstance(data, dict):
        uri = data.get("uri")
        if isinstance(uri, str) and uri.startswith("spotify:track:"):
            return uri.split(":")[-1]
        for v in data.values():
            found = first_spotify_track_id_from_search(v)
            if found:
                return found
    elif isinstance(data, list):
        for x in data:
            found = first_spotify_track_id_from_search(x)
            if found:
                return found
    return None


def collect_spotify_ids_from_obj(obj: Any, out: set[str]) -> None:
    if isinstance(obj, str) and obj.startswith("spotify:track:"):
        out.add(obj.split(":")[-1])
    elif isinstance(obj, dict):
        for v in obj.values():
            collect_spotify_ids_from_obj(v, out)
    elif isinstance(obj, list):
        for x in obj:
            collect_spotify_ids_from_obj(x, out)


def ytm_video_ids_in_playlist(yt: Any, playlist_id: str) -> set[str]:
    """Collect videoIds on a playlist. Uses limit=None so ytmusicapi follows continuations (no offset API)."""
    found: set[str] = set()
    pl = yt.get_playlist(playlist_id, limit=None)
    tracks = pl.get("tracks") if isinstance(pl, dict) else None
    if not tracks:
        return found
    for tr in tracks:
        if not isinstance(tr, dict):
            continue
        vid = tr.get("videoId")
        if isinstance(vid, str) and vid:
            found.add(vid)
    return found


def spotify_ids_in_playlist(client: Any, playlist_id: str) -> set[str]:
    from spotapi.playlist import PublicPlaylist

    pub = PublicPlaylist(playlist_id, client=client)
    ids: set[str] = set()
    try:
        for chunk in pub.paginate_playlist():
            collect_spotify_ids_from_obj(chunk, ids)
    except Exception:
        first = pub.get_playlist_info(limit=343)
        collect_spotify_ids_from_obj(first, ids)
    return ids


def ytm_add_playlist_items_safe(
    ytm: Any,
    playlist_id: str,
    video_ids: list[str],
    *,
    add_delay_s: float,
) -> tuple[list[str], list[tuple[str, str]]]:
    """
    Add videos to a playlist.
    Returns (accepted_video_ids, [(rejected_id, error_detail), ...]).
    Uses duplicates=True; on HTTP/API failure splits the batch (smaller payloads).
    """
    from ytmusicapi.exceptions import YTMusicServerError

    if not video_ids:
        return [], []

    r: Any = None
    err: BaseException | None = None
    try:
        r = ytm.add_playlist_items(playlist_id, videoIds=video_ids, duplicates=True)
    except YTMusicServerError as e:
        err = e

    ok = False
    if err is None:
        if isinstance(r, str):
            ok = "SUCCEEDED" in r
        elif isinstance(r, dict):
            st = r.get("status", "")
            ok = isinstance(st, str) and "SUCCEEDED" in st
    if err is None and ok:
        time.sleep(add_delay_s)
        return (list(video_ids), [])

    detail = (str(err) if err else str(r)).strip().replace("\n", " ")
    if len(detail) > 400:
        detail = detail[:400] + "…"

    if len(video_ids) <= 1:
        vid = video_ids[0]
        return ([], [(vid, detail)])

    mid = (len(video_ids) + 1) // 2
    ok_a, fail_a = ytm_add_playlist_items_safe(ytm, playlist_id, video_ids[:mid], add_delay_s=add_delay_s)
    ok_b, fail_b = ytm_add_playlist_items_safe(ytm, playlist_id, video_ids[mid:], add_delay_s=add_delay_s)
    return (ok_a + ok_b, fail_a + fail_b)


def build_ytmusic_client(auth_path: Path) -> Any:
    """
    Browser header auth is increasingly rejected for library/playlist writes (HTTP 403).
    OAuth (oauth.json + client id/secret) is what ytmusicapi documents as of late 2024.
    """
    from ytmusicapi import OAuthCredentials, YTMusic

    try:
        data = json.loads(auth_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"Invalid JSON in auth file {auth_path}: {e}", file=sys.stderr)
        sys.exit(1)

    if isinstance(data, dict) and "access_token" in data and "refresh_token" in data:
        cid = os.environ.get("YOUTUBE_OAUTH_CLIENT_ID") or os.environ.get("YTMUSIC_OAUTH_CLIENT_ID")
        sec = os.environ.get("YOUTUBE_OAUTH_CLIENT_SECRET") or os.environ.get("YTMUSIC_OAUTH_CLIENT_SECRET")
        if not cid or not sec:
            print(
                "Auth file looks like OAuth (access_token + refresh_token) but .env is missing\n"
                "  YOUTUBE_OAUTH_CLIENT_ID and YOUTUBE_OAUTH_CLIENT_SECRET\n"
                "(Create a YouTube Data API OAuth client: type \"TVs and Limited Input devices\".)",
                file=sys.stderr,
            )
            sys.exit(1)
        print("YouTube Music: auth mode OAuth (recommended for playlist edits).", flush=True)
        return YTMusic(str(auth_path), oauth_credentials=OAuthCredentials(cid, sec))

    print(
        "YouTube Music: auth mode browser headers. If playlist uploads return HTTP 403, switch to OAuth: "
        "run `ytmusicapi oauth`, point YTMUSIC_HEADERS_PATH at oauth.json, and set YOUTUBE_OAUTH_CLIENT_* in .env.",
        flush=True,
    )
    return YTMusic(str(auth_path))


def sync_youtube_music(
    tracks: list[Track],
    *,
    headers_path: Path,
    playlist_id: str | None,
    playlist_name: str,
    dry_run: bool,
    skip_existing: bool,
    search_delay_s: float,
    ytm_add_batch_size: int,
    ytm_add_delay_s: float,
) -> str | None:
    _ = skip_existing  # YTM always loads playlist from server; flag applies to Spotify only.

    print("YouTube Music: loading client (first request may fetch a visitor id)...", flush=True)
    ytm = build_ytmusic_client(headers_path)
    # Prime headers / visitor id so a slow first HTTP round-trip is visible, not silent.
    _ = ytm.headers
    print("YouTube Music: client ready.", flush=True)

    target_playlist_id = playlist_id
    if not target_playlist_id:
        if dry_run:
            print(f"[dry-run] would create YTM playlist named {playlist_name!r}", flush=True)
        else:
            print("YouTube Music: creating playlist...", flush=True)
            target_playlist_id = ytm.create_playlist(playlist_name, "")
            if not isinstance(target_playlist_id, str):
                print(f"ytmusicapi create_playlist failed: {target_playlist_id}", file=sys.stderr)
                sys.exit(1)
            print(f"Created YouTube Music playlist id: {target_playlist_id}", flush=True)

    assert target_playlist_id is not None
    # Always load playlist from server so re-runs skip what's already there (duplicates=True is unreliable).
    on_playlist: set[str] = set()
    if not dry_run:
        print("YouTube Music: loading current playlist (skip duplicates vs server)...", flush=True)
        on_playlist = ytm_video_ids_in_playlist(ytm, target_playlist_id)
        print(f"YouTube Music: {len(on_playlist)} video id(s) already on playlist.", flush=True)

    n = len(tracks)
    est_s = n * max(0.0, search_delay_s) if not dry_run else 0.0
    print(
        f"YouTube Music: {'dry-run ' if dry_run else ''}processing {n} track(s)"
        + (f" (~{est_s / 60:.1f} min from search delay alone)" if est_s > 30 else "")
        + f"; add batches of up to {ytm_add_batch_size} after each search.",
        flush=True,
    )

    pending: list[tuple[Track, str]] = []
    pending_ids: set[str] = set()
    total_added = 0
    add_batch = max(1, ytm_add_batch_size)
    no_search_hits: list[tuple[Track, str]] = []
    skipped_duplicate: list[tuple[Track, str]] = []
    add_failed: list[tuple[Track, str, str]] = []

    def track_line(t: Track, extra: str = "") -> str:
        art = f"{t.artist} — " if t.artist else ""
        return f"  item_id={t.item_id} {art}{t.title!r}{extra}"

    def flush_pending(*, final: bool = False) -> None:
        nonlocal pending, total_added, on_playlist
        if dry_run:
            return
        while pending and (final or len(pending) >= add_batch):
            chunk_pairs = pending[:add_batch]
            del pending[:add_batch]
            for _, vid in chunk_pairs:
                pending_ids.discard(vid)
            vids = [v for _, v in chunk_pairs]
            by_vid = {v: t for t, v in chunk_pairs}
            print(
                f"YouTube Music: uploading {len(vids)} video(s) ({total_added} confirmed added this run)...",
                flush=True,
            )
            ok_ids, fail_pairs = ytm_add_playlist_items_safe(
                ytm,
                target_playlist_id,
                vids,
                add_delay_s=ytm_add_delay_s,
            )
            for vid in ok_ids:
                on_playlist.add(vid)
            total_added += len(ok_ids)
            for vid, detail in fail_pairs:
                tr = by_vid.get(vid)
                if tr is not None:
                    add_failed.append((tr, vid, detail))

    for i, t in enumerate(tracks):
        if dry_run:
            q = " ".join(x for x in [t.artist, t.title] if x).strip() or t.title
            print(f"[dry-run] ytm search: {q!r}", flush=True)
            time.sleep(0)
            continue

        if i == 0 or (i + 1) % 25 == 0 or i + 1 == n:
            print(f"YouTube Music: search {i + 1}/{n}...", flush=True)

        q = " ".join(x for x in [t.artist, t.title] if x).strip() or t.title
        results = ytm.search(q, filter="songs", limit=5)
        time.sleep(search_delay_s)

        video_id: str | None = None
        if isinstance(results, list):
            for r in results:
                if isinstance(r, dict) and r.get("resultType") == "song":
                    vid = r.get("videoId")
                    if isinstance(vid, str) and vid:
                        video_id = vid
                        break
            if video_id is None and results:
                r0 = results[0]
                if isinstance(r0, dict):
                    vid = r0.get("videoId")
                    if isinstance(vid, str) and vid:
                        video_id = vid

        if not video_id:
            no_search_hits.append((t, q))
            continue

        if video_id in on_playlist or video_id in pending_ids:
            skipped_duplicate.append((t, video_id))
            continue
        pending_ids.add(video_id)
        pending.append((t, video_id))
        flush_pending(final=False)

    if dry_run:
        return target_playlist_id

    flush_pending(final=True)

    def _print_report_section(title: str, rows: list[Any], fmt, limit: int = 80) -> None:
        print(f"\n{title} ({len(rows)}):", flush=True)
        if not rows:
            print("  (none)", flush=True)
            return
        for row in rows[:limit]:
            print(fmt(row), flush=True)
        if len(rows) > limit:
            print(f"  … and {len(rows) - limit} more", flush=True)

    print("\n======== YouTube Music sync report ========", flush=True)
    print(f"  DB tracks (unique keys): {n}", flush=True)
    print(f"  Confirmed added this run: {total_added}", flush=True)
    _print_report_section(
        "Skipped (already on playlist or queued same videoId this run)",
        skipped_duplicate,
        lambda row: track_line(row[0], f" videoId={row[1]!r}"),
    )
    _print_report_section(
        "No search result",
        no_search_hits,
        lambda row: track_line(row[0], f" search={row[1]!r}"),
    )
    _print_report_section(
        "Add rejected by API",
        add_failed,
        lambda row: track_line(row[0], f" videoId={row[1]!r} | {row[2]}"),
    )
    accounted = total_added + len(skipped_duplicate) + len(no_search_hits) + len(add_failed)
    print(
        f"  Check: added + skipped_dup + no_search + add_failed = {accounted} (DB rows can share one videoId)",
        flush=True,
    )
    print(f"  Playlist: {target_playlist_id}", flush=True)
    print("==========================================", flush=True)
    return target_playlist_id


def spotify_post_add_to_playlist(song: Any, song_ids: list[str]) -> None:
    """
    Same mutation as spotapi.song.Song.add_songs_to_playlist, but fail if the JSON body
    contains GraphQL errors (partner API often returns HTTP 200 with errors: [...]).
    """
    from spotapi.exceptions.errors import SongError

    if not song.playlist or not hasattr(song.playlist, "playlist_id"):
        raise ValueError("Playlist not set")
    url = "https://api-partner.spotify.com/pathfinder/v1/query"
    payload = {
        "variables": {
            # Partner API renamed this from `uris` (400: missing `$playlistItemUris`).
            "playlistItemUris": [f"spotify:track:{sid}" for sid in song_ids],
            "playlistUri": f"spotify:playlist:{song.playlist.playlist_id}",
            "newPosition": {"moveType": "BOTTOM_OF_PLAYLIST", "fromUid": None},
        },
        "operationName": "addToPlaylist",
        "extensions": {
            "persistedQuery": {
                "version": 1,
                "sha256Hash": song.base.part_hash("addToPlaylist"),
            }
        },
    }
    resp = song.base.client.post(url, json=payload, authenticate=True)
    if resp.fail:
        raise SongError("Could not add songs to playlist", error=resp.error.string)
    body = resp.response
    if isinstance(body, Mapping) and body.get("errors"):
        msg = json.dumps(body["errors"], ensure_ascii=False)
        if len(msg) > 800:
            msg = msg[:800] + "…"
        raise SongError("Spotify addToPlaylist returned GraphQL errors", error=msg)


def spotify_add_songs_safe(
    song: Any,
    song_ids: list[str],
    *,
    add_delay_s: float,
) -> tuple[list[str], list[tuple[str, str]]]:
    """
    Add tracks via SpotAPI; return (added_ids, [(failed_id, detail), ...]).
    Splits batch on failure (partner API often rejects large batches or single bad URIs).
    """
    from spotapi.exceptions.errors import SongError

    if not song_ids:
        return [], []
    try:
        spotify_post_add_to_playlist(song, song_ids)
    except SongError as e:
        detail = (e.error or str(e) or "SongError").strip()
    except Exception as e:
        detail = (str(e).strip() or type(e).__name__)
    else:
        time.sleep(add_delay_s)
        return (list(song_ids), [])

    if len(detail) > 500:
        detail = detail[:500] + "…"
    if len(song_ids) <= 1:
        return ([], [(song_ids[0], detail)])

    mid = (len(song_ids) + 1) // 2
    ok_a, fail_a = spotify_add_songs_safe(song, song_ids[:mid], add_delay_s=add_delay_s)
    ok_b, fail_b = spotify_add_songs_safe(song, song_ids[mid:], add_delay_s=add_delay_s)
    return (ok_a + ok_b, fail_a + fail_b)


def sync_spotify(
    tracks: list[Track],
    *,
    session_path: Path,
    playlist_id: str | None,
    playlist_name: str,
    dry_run: bool,
    skip_existing: bool,
    search_delay_s: float,
    batch_size: int,
    spotify_add_delay_s: float,
) -> str | None:
    from spotapi import Config, Login
    from spotapi.playlist import PrivatePlaylist
    from spotapi.song import Song
    from spotapi.utils.logger import NoopLogger

    raw = json.loads(session_path.read_text(encoding="utf-8"))
    if isinstance(raw, list) and raw:
        dump = raw[0]
    elif isinstance(raw, dict):
        dump = raw
    else:
        print("Invalid SPOTIFY_SESSION JSON (expected dict or single-element list).", file=sys.stderr)
        sys.exit(1)
    if not isinstance(dump, dict):
        print("Invalid SPOTIFY_SESSION JSON.", file=sys.stderr)
        sys.exit(1)

    print("Spotify: loading session...", flush=True)
    cfg = Config(logger=NoopLogger(), solver=None)
    login = Login.from_cookies(dump, cfg)

    pp = PrivatePlaylist(login)
    target: str | None = playlist_id
    if target:
        pp.set_playlist(target)
    elif dry_run:
        print(f"[dry-run] would create Spotify playlist named {playlist_name!r}")
    else:
        uri = pp.create_playlist(playlist_name)
        target = uri.split(":")[-1] if isinstance(uri, str) and ":" in uri else str(uri)
        print(f"Created Spotify playlist id: {target}")
        pp.set_playlist(target)
        print("Spotify: waiting 2s for new playlist to propagate...", flush=True)
        time.sleep(2)

    if not target and not dry_run:
        return None

    song = Song(playlist=pp)

    _ = skip_existing  # Playlist is always loaded below (same idea as YouTube Music).

    on_playlist: set[str] = set()
    if not dry_run:
        try:
            print("Spotify: loading current playlist (skip duplicates vs server)...", flush=True)
            on_playlist = spotify_ids_in_playlist(login.client, target)
            print(f"Spotify: {len(on_playlist)} track id(s) already on playlist.", flush=True)
        except Exception as e:
            print(f"Spotify: could not load existing tracks ({e}); duplicates may be re-added.", file=sys.stderr)

    n = len(tracks)
    est_s = n * max(0.0, search_delay_s) if not dry_run else 0.0
    add_batch = max(1, batch_size)
    print(
        f"Spotify: {'dry-run ' if dry_run else ''}processing {n} track(s)"
        + (f" (~{est_s / 60:.1f} min from search delay alone)" if est_s > 30 else "")
        + f"; add batches of up to {add_batch} while scanning.",
        flush=True,
    )

    pending: list[str] = []
    pending_ids: set[str] = set()
    total_added = 0
    add_failures: list[tuple[str, str]] = []
    logged_first_spotify_add_error = False

    def flush_pending(*, final: bool = False) -> None:
        nonlocal pending, total_added, on_playlist, logged_first_spotify_add_error
        if dry_run:
            return
        while pending and (final or len(pending) >= add_batch):
            chunk = pending[:add_batch]
            del pending[:add_batch]
            for x in chunk:
                pending_ids.discard(x)
            print(
                f"Spotify: adding {len(chunk)} track(s) ({total_added} confirmed on playlist this run)...",
                flush=True,
            )
            ok_ids, fail_pairs = spotify_add_songs_safe(
                song, chunk, add_delay_s=spotify_add_delay_s
            )
            total_added += len(ok_ids)
            on_playlist.update(ok_ids)
            add_failures.extend(fail_pairs)
            if fail_pairs and not ok_ids and not logged_first_spotify_add_error:
                logged_first_spotify_add_error = True
                tid0, msg0 = fail_pairs[0]
                print(
                    f"Spotify: first add failure (track {tid0}): {msg0[:500]}"
                    + ("…" if len(msg0) > 500 else ""),
                    file=sys.stderr,
                    flush=True,
                )

    for idx, t in enumerate(tracks):
        tid = t.spotify_track_id
        if not tid:
            if dry_run:
                q = " ".join(x for x in [t.artist, t.title] if x).strip() or t.title
                print(f"[dry-run] spotify search: {q!r}", flush=True)
                continue
            if idx == 0 or (idx + 1) % 25 == 0 or idx + 1 == n:
                print(f"Spotify: search {idx + 1}/{n}...", flush=True)
            q = " ".join(x for x in [t.artist, t.title] if x).strip() or t.title
            data = song.query_songs(q, limit=5)
            time.sleep(search_delay_s)
            tid = first_spotify_track_id_from_search(data)
            if not tid:
                print(f"Spotify: no result for item_id={t.item_id} query={q!r}", file=sys.stderr)
                continue
        else:
            if not dry_run and (idx == 0 or (idx + 1) % 25 == 0 or idx + 1 == n):
                print(f"Spotify: track {idx + 1}/{n} (using scraped Spotify id)...", flush=True)

        if tid in on_playlist or tid in pending_ids:
            continue
        pending_ids.add(tid)
        pending.append(tid)
        flush_pending(final=False)

    if dry_run:
        return target

    flush_pending(final=True)

    if add_failures:
        print(f"\nSpotify: {len(add_failures)} track id(s) could not be added:", flush=True)
        for tid, msg in add_failures[:40]:
            print(f"  {tid}: {msg}", flush=True)
        if len(add_failures) > 40:
            print(f"  … and {len(add_failures) - 40} more", flush=True)

    print(f"Spotify: finished ({total_added} track(s) added this run; playlist {target})", flush=True)
    return target


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sync scraped SQLite items to YouTube Music / Spotify.")
    p.add_argument("--db", help="SQLite path or DATABASE_URL-style file: path (default: env DATABASE_URL)")
    p.add_argument("--run-id", type=int, default=None, help="Only items from this scrape_runs.id")
    p.add_argument("--adapter", default=None, help="Only items whose sources.adapter_id matches")
    p.add_argument(
        "--allow-all",
        action="store_true",
        help="Allow syncing without --run-id / --adapter (use with care).",
    )
    p.add_argument(
        "--target",
        choices=("ytm", "spotify", "both"),
        default="both",
        help="Which destination to sync",
    )
    p.add_argument("--playlist-name", default="Scraped tracks", help="New playlist name if no playlist id")
    p.add_argument("--ytmusic-playlist-id", default=None, help="Existing YouTube Music playlist id")
    p.add_argument("--spotify-playlist-id", default=None, help="Existing Spotify playlist id")
    p.add_argument("--dry-run", action="store_true", help="Print actions without calling APIs")
    p.add_argument(
        "--skip-existing",
        action="store_true",
        help="Ignored: both targets load the playlist from the server and skip ids already present.",
    )
    p.add_argument("--search-delay-ms", type=int, default=400, help="Delay between search calls")
    p.add_argument(
        "--ytm-add-batch-size",
        type=int,
        default=5,
        help="Flush uploads after this many new video ids (smaller avoids YouTube 403 on large edit payloads)",
    )
    p.add_argument(
        "--ytm-add-delay-ms",
        type=int,
        default=350,
        help="Pause after each successful YouTube Music upload batch",
    )
    p.add_argument(
        "--spotify-batch-size",
        type=int,
        default=25,
        help="Target size for each add_songs_to_playlist call (smaller if the partner API errors on large batches)",
    )
    p.add_argument(
        "--spotify-add-delay-ms",
        type=int,
        default=400,
        help="Pause after each successful Spotify add batch",
    )
    return p.parse_args()


def main() -> None:
    load_env()
    args = parse_args()
    db_path = database_path_from_env_or_arg(args.db)
    if not db_path.is_file():
        print(f"Database not found: {db_path}", file=sys.stderr)
        sys.exit(1)

    tracks = load_tracks(
        db_path,
        run_id=args.run_id,
        adapter=args.adapter,
        allow_all=args.allow_all,
    )
    print(f"Loaded {len(tracks)} unique track(s) from {db_path}", flush=True)

    delay_s = max(0.0, args.search_delay_ms / 1000.0)

    ytm_headers = os.environ.get("YTMUSIC_HEADERS_PATH")
    spotify_session = os.environ.get("SPOTIFY_SESSION_PATH")

    ytm_pl = args.ytmusic_playlist_id or os.environ.get("YTMUSIC_PLAYLIST_ID")
    sp_pl = args.spotify_playlist_id or os.environ.get("SPOTIFY_PLAYLIST_ID")

    if args.target in ("ytm", "both"):
        if not ytm_headers:
            print("YTMUSIC_HEADERS_PATH is not set in .env", file=sys.stderr)
            sys.exit(1)
        hp = resolve_path(ytm_headers)
        if not hp.is_file():
            print(f"YTM headers file not found: {hp}", file=sys.stderr)
            sys.exit(1)
        sync_youtube_music(
            tracks,
            headers_path=hp,
            playlist_id=ytm_pl,
            playlist_name=args.playlist_name,
            dry_run=args.dry_run,
            skip_existing=args.skip_existing,
            search_delay_s=delay_s,
            ytm_add_batch_size=args.ytm_add_batch_size,
            ytm_add_delay_s=max(0.0, args.ytm_add_delay_ms / 1000.0),
        )

    if args.target in ("spotify", "both"):
        if not spotify_session:
            print("SPOTIFY_SESSION_PATH is not set in .env", file=sys.stderr)
            sys.exit(1)
        sp = resolve_path(spotify_session)
        if not sp.is_file():
            print(f"Spotify session file not found: {sp}", file=sys.stderr)
            sys.exit(1)
        sync_spotify(
            tracks,
            session_path=sp,
            playlist_id=sp_pl,
            playlist_name=args.playlist_name,
            dry_run=args.dry_run,
            skip_existing=args.skip_existing,
            search_delay_s=delay_s,
            batch_size=args.spotify_batch_size,
            spotify_add_delay_s=max(0.0, args.spotify_add_delay_ms / 1000.0),
        )


if __name__ == "__main__":
    main()
