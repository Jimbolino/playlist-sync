"""CI smoke test: read back the track scripts/smoke.ts stored, and check the sync libraries import.

Usage: python python/smoke_test.py data/smoke.db
"""

import sys
from pathlib import Path

import spotapi  # noqa: F401  (fail early when a dependency update breaks the import)
import ytmusicapi  # noqa: F401

from sync_playlists import load_tracks

tracks = load_tracks(Path(sys.argv[1]), run_id=None, adapter="nl538.house_article", allow_all=False)
assert len(tracks) == 1 and tracks[0].artist == "Ten Walls", tracks
print(f"python smoke ok: {tracks[0].artist} - {tracks[0].title}")
