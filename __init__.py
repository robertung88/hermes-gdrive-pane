"""Agent half of a desktop-only pane.

The feature is entirely a desktop surface, so this half registers nothing: no
tools, hooks, slash commands or env vars. It exists because a directory plugin
is imported through its ``__init__.py``, and because ``plugins.enabled`` is the
gate that also lets the gateway import ``dashboard/plugin_api.py`` — the
profile-scoped Google read API the pane talks to.
"""


def register(ctx) -> None:  # noqa: ARG001
    """Nothing to add to the agent side. The pane and its backend do the work."""
    return None
