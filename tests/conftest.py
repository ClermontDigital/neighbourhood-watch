"""Test bootstrap.

The integration package's __init__ imports Home Assistant, which we do not want
to require just to test the pure logic. Bind the source directory as a
lightweight package instead, so relative imports inside models.py and const.py
still resolve.
"""

import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "custom_components" / "neighbourhood_watch"

if "nw" not in sys.modules:
    package = types.ModuleType("nw")
    package.__path__ = [str(ROOT)]
    sys.modules["nw"] = package
