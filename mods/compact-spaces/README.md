# Compact Spaces

Owned clone of the shipped Spaces mod, retained for layouts that prefer a dropdown. The herdr-workspace layout now uses the accordion tree in `space-agents` instead.

The full-width, left-aligned trigger reflects Herdr's actual selected space. Open it to select a space or create one on a ready machine; creation stays inside the dropdown, without a separate button. Arrow keys move a temporary highlight, Enter activates the exact live ID, and Escape cancels. Right-click retains the native space menu; drag between popup space rows to reorder within a machine.

Machine-qualified IDs distinguish equal names. Removed spaces and unavailable machines cannot fall back to another index or create locally. Collapsed sidebars retain a labelled avatar trigger and popup create actions. Space colors, attention and worktree grouping use the shipped model.

No independent space selection is saved. A layout using this dropdown should give it a fixed 44-pixel row. The dropdown uses Herdr's native selection and leaves agent sessions and Files/Changes unchanged. Native popup mouse/keyboard and narrow/zoom acceptance still require a user-visible check when GUI automation is unavailable.
