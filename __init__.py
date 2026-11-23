"""Auto mode for Hermes: rules, a decision model, a chat decider, then the approval gate.

Hermes loads this folder as a plugin and calls register(ctx). The decisions themselves live in
core/, shared with the Pi plugin; hermes/ holds the Hermes side.
"""

from .hermes.plugin import register  # noqa: F401  (Hermes calls this)
