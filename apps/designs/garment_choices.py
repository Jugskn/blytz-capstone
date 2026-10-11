"""
Garment template and color allow-lists for Design save/submit.

Must stay aligned with static/js/editor_garments.js GARMENT_TYPES / GARMENT_COLORS
(ids only; grey is a client alias for gray and is not accepted on the server).
"""

# Cross-ref: static/js/editor_garments.js GARMENT_TYPES ids
GARMENT_TEMPLATE_IDS = ("tee", "polo", "jersey", "hoodie")

# Cross-ref: static/js/editor_garments.js GARMENT_COLORS ids (canonical)
GARMENT_COLOR_IDS = (
    "white",
    "black",
    "gray",
    "navy",
    "red",
    "royal",
    "green",
    "yellow",
    "orange",
    "maroon",
)

GARMENT_TEMPLATE_CHOICES = [(x, x) for x in GARMENT_TEMPLATE_IDS]
GARMENT_COLOR_CHOICES = [(x, x) for x in GARMENT_COLOR_IDS]


def views_have_objects(views) -> bool:
    if not isinstance(views, dict):
        return False
    for value in views.values():
        if (
            isinstance(value, dict)
            and isinstance(value.get("objects"), list)
            and len(value["objects"]) > 0
        ):
            return True
    return False


def apply_stale_client_views_guard(incoming: dict, stored) -> dict:
    """
    When schema_version is 1 and the client omits "views" while the stored design
    has a views key with at least one object in any view, keep the stored views.
    Explicit views (even empty) overwrite.
    Non-v1 payloads are returned unchanged (opaque).
    """
    if not isinstance(incoming, dict) or incoming.get("schema_version") != 1:
        return incoming
    if "views" in incoming:
        return incoming
    stored_dict = stored if isinstance(stored, dict) else {}
    stored_views = stored_dict.get("views")
    if views_have_objects(stored_views):
        merged = dict(incoming)
        merged["views"] = stored_views
        return merged
    return incoming
