"""BEHAVIOR and SOURCE-STRING tests for garment fields and B1 views (Stage 3d+3e)."""

import json

from django.contrib.auth import get_user_model
from django.contrib.staticfiles import finders
from django.test import TestCase
from django.urls import reverse

from apps.designs.forms import DesignSaveForm, MAX_CANVAS_JSON_BYTES
from apps.designs.models import Design

User = get_user_model()


def _v1_envelope(front_objects=None, back_objects=None, include_views=True):
    env = {
        "schema_version": 1,
        "width": 800,
        "height": 800,
        "canvas": {
            "version": "6.6.1",
            "objects": front_objects
            if front_objects is not None
            else [{"type": "Rect", "blytzId": "f1", "left": 10, "top": 10}],
        },
    }
    if include_views:
        env["views"] = {
            "back": {
                "version": "6.6.1",
                "objects": back_objects
                if back_objects is not None
                else [{"type": "Ellipse", "blytzId": "b1", "left": 20, "top": 20}],
            }
        }
    return env


class GarmentFieldsBehaviorTests(TestCase):
    """BEHAVIOR: garment_template / garment_color save semantics."""

    def setUp(self):
        self.user = User.objects.create_user(
            email="garment@example.com",
            password="test-pass-123",
            role=User.Role.CUSTOMER,
        )
        self.design = Design.objects.create(
            owner=self.user,
            title="Garment design",
            garment_template="tee",
            garment_color="black",
            canvas_json=_v1_envelope(),
        )
        self.client.force_login(self.user)

    def test_save_valid_garment_persists_and_editor_renders_data_attrs(self):
        """BEHAVIOR"""
        payload = _v1_envelope()
        resp = self.client.post(
            reverse("design_save", args=[self.design.pk]),
            {
                "canvas_json": json.dumps(payload),
                "garment_template": "hoodie",
                "garment_color": "navy",
            },
            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
        )
        self.assertEqual(resp.status_code, 200)
        self.design.refresh_from_db()
        self.assertEqual(self.design.garment_template, "hoodie")
        self.assertEqual(self.design.garment_color, "navy")
        editor = self.client.get(reverse("design_editor", args=[self.design.pk]))
        self.assertEqual(editor.status_code, 200)
        html = editor.content.decode("utf-8")
        self.assertIn('data-garment-template="hoodie"', html)
        self.assertIn('data-garment-color="navy"', html)

    def test_invalid_template_rejected_nothing_saved(self):
        """BEHAVIOR"""
        before_t = self.design.garment_template
        before_c = self.design.garment_color
        before_canvas = self.design.canvas_json
        resp = self.client.post(
            reverse("design_save", args=[self.design.pk]),
            {
                "canvas_json": json.dumps(_v1_envelope()),
                "garment_template": "evil",
                "garment_color": "navy",
            },
            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
        )
        self.assertEqual(resp.status_code, 400)
        self.design.refresh_from_db()
        self.assertEqual(self.design.garment_template, before_t)
        self.assertEqual(self.design.garment_color, before_c)
        self.assertEqual(self.design.canvas_json, before_canvas)

    def test_invalid_color_rejected_nothing_saved(self):
        """BEHAVIOR"""
        before_t = self.design.garment_template
        before_c = self.design.garment_color
        resp = self.client.post(
            reverse("design_save", args=[self.design.pk]),
            {
                "canvas_json": json.dumps(_v1_envelope()),
                "garment_template": "tee",
                "garment_color": "hotpink",
            },
            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
        )
        self.assertEqual(resp.status_code, 400)
        self.design.refresh_from_db()
        self.assertEqual(self.design.garment_template, before_t)
        self.assertEqual(self.design.garment_color, before_c)

    def test_absent_garment_fields_leave_stored_unchanged(self):
        """BEHAVIOR"""
        self.design.garment_template = "polo"
        self.design.garment_color = "red"
        self.design.save(update_fields=["garment_template", "garment_color"])
        resp = self.client.post(
            reverse("design_save", args=[self.design.pk]),
            {"canvas_json": json.dumps(_v1_envelope())},
            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
        )
        self.assertEqual(resp.status_code, 200)
        self.design.refresh_from_db()
        self.assertEqual(self.design.garment_template, "polo")
        self.assertEqual(self.design.garment_color, "red")

    def test_legacy_save_without_garment_fields_still_works(self):
        """BEHAVIOR"""
        form = DesignSaveForm(
            data={"canvas_json": json.dumps(_v1_envelope())},
            stored_canvas=self.design.canvas_json,
        )
        self.assertTrue(form.is_valid(), form.errors)


class ViewsEnvelopeBehaviorTests(TestCase):
    """BEHAVIOR: views.back persistence, stale-client guard, safety, size cap."""

    def setUp(self):
        self.user = User.objects.create_user(
            email="views@example.com",
            password="test-pass-123",
            role=User.Role.CUSTOMER,
        )
        self.other = User.objects.create_user(
            email="views-other@example.com",
            password="test-pass-123",
            role=User.Role.CUSTOMER,
        )
        self.design = Design.objects.create(
            owner=self.user,
            title="Views design",
            garment_template="tee",
            garment_color="black",
            canvas_json=_v1_envelope(),
        )
        self.client.force_login(self.user)

    def test_save_with_views_back_persists_both_and_reload_returns_both(self):
        """BEHAVIOR"""
        payload = _v1_envelope(
            front_objects=[{"type": "Rect", "blytzId": "frontA"}],
            back_objects=[{"type": "IText", "text": "back", "blytzId": "backA"}],
        )
        resp = self.client.post(
            reverse("design_save", args=[self.design.pk]),
            {"canvas_json": json.dumps(payload)},
            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
        )
        self.assertEqual(resp.status_code, 200)
        self.design.refresh_from_db()
        stored = self.design.canvas_json
        self.assertEqual(stored["canvas"]["objects"][0]["blytzId"], "frontA")
        self.assertEqual(stored["views"]["back"]["objects"][0]["blytzId"], "backA")
        editor = self.client.get(reverse("design_editor", args=[self.design.pk]))
        initial = json.loads(editor.context["canvas_json_initial"])
        self.assertEqual(initial["canvas"]["objects"][0]["blytzId"], "frontA")
        self.assertEqual(initial["views"]["back"]["objects"][0]["blytzId"], "backA")

    def test_stale_client_guard_keeps_stored_back_when_views_omitted(self):
        """BEHAVIOR"""
        self.design.canvas_json = _v1_envelope(
            back_objects=[{"type": "Rect", "blytzId": "keep-me"}]
        )
        self.design.save(update_fields=["canvas_json"])
        incoming = _v1_envelope(include_views=False)
        incoming["canvas"]["objects"] = [{"type": "Rect", "blytzId": "new-front"}]
        resp = self.client.post(
            reverse("design_save", args=[self.design.pk]),
            {"canvas_json": json.dumps(incoming)},
            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
        )
        self.assertEqual(resp.status_code, 200)
        self.design.refresh_from_db()
        self.assertEqual(
            self.design.canvas_json["views"]["back"]["objects"][0]["blytzId"],
            "keep-me",
        )
        self.assertEqual(
            self.design.canvas_json["canvas"]["objects"][0]["blytzId"], "new-front"
        )

    def test_explicit_empty_views_clears_back(self):
        """BEHAVIOR"""
        self.design.canvas_json = _v1_envelope(
            back_objects=[{"type": "Rect", "blytzId": "gone"}]
        )
        self.design.save(update_fields=["canvas_json"])
        incoming = _v1_envelope(back_objects=[])
        resp = self.client.post(
            reverse("design_save", args=[self.design.pk]),
            {"canvas_json": json.dumps(incoming)},
            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
        )
        self.assertEqual(resp.status_code, 200)
        self.design.refresh_from_db()
        self.assertEqual(self.design.canvas_json["views"]["back"]["objects"], [])

    def test_views_front_rejected(self):
        """BEHAVIOR"""
        payload = _v1_envelope()
        payload["views"]["front"] = {"objects": []}
        form = DesignSaveForm(
            data={"canvas_json": json.dumps(payload)},
            stored_canvas=self.design.canvas_json,
        )
        self.assertFalse(form.is_valid())
        self.assertIn("canvas_json", form.errors)

    def test_unknown_views_key_rejected(self):
        """BEHAVIOR"""
        payload = _v1_envelope()
        payload["views"]["sleeve"] = {"objects": []}
        form = DesignSaveForm(
            data={"canvas_json": json.dumps(payload)},
            stored_canvas=self.design.canvas_json,
        )
        self.assertFalse(form.is_valid())

    def test_views_back_external_image_rejected(self):
        """BEHAVIOR"""
        payload = _v1_envelope(
            back_objects=[
                {
                    "type": "Image",
                    "src": "https://evil.example/x.png",
                    "blytzId": "bad",
                }
            ]
        )
        form = DesignSaveForm(
            data={"canvas_json": json.dumps(payload)},
            stored_canvas=self.design.canvas_json,
        )
        self.assertFalse(form.is_valid())

    def test_non_v1_payload_stays_untouched(self):
        """BEHAVIOR"""
        payload = {"schema_version": 99, "blob": "x" * 100}
        form = DesignSaveForm(
            data={"canvas_json": json.dumps(payload)},
            stored_canvas={"schema_version": 99, "blob": "old"},
        )
        self.assertTrue(form.is_valid(), form.errors)
        self.assertEqual(form.cleaned_data["canvas_json"]["schema_version"], 99)
        self.assertNotIn("views", form.cleaned_data["canvas_json"])

    def test_whole_envelope_2mib_cap_counts_both_views(self):
        """BEHAVIOR"""
        # Each view under 2 MiB alone, combined over the cap.
        half = (MAX_CANVAS_JSON_BYTES // 2) + 50_000
        pad_a = "a" * half
        pad_b = "b" * half
        payload = {
            "schema_version": 1,
            "width": 800,
            "height": 800,
            "canvas": {
                "version": "6.6.1",
                "objects": [{"type": "Rect", "blytzId": "a", "pad": pad_a}],
            },
            "views": {
                "back": {
                    "version": "6.6.1",
                    "objects": [{"type": "Rect", "blytzId": "b", "pad": pad_b}],
                }
            },
        }
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        self.assertGreater(len(encoded.encode("utf-8")), MAX_CANVAS_JSON_BYTES)
        # Per-view rough check: canvas-only stringify under cap.
        front_only = json.dumps(payload["canvas"], separators=(",", ":"))
        back_only = json.dumps(payload["views"]["back"], separators=(",", ":"))
        self.assertLess(len(front_only.encode("utf-8")), MAX_CANVAS_JSON_BYTES)
        self.assertLess(len(back_only.encode("utf-8")), MAX_CANVAS_JSON_BYTES)
        form = DesignSaveForm(data={"canvas_json": encoded})
        self.assertFalse(form.is_valid())
        self.assertIn("canvas_json", form.errors)

    def test_other_user_cannot_save(self):
        """BEHAVIOR: ownership"""
        self.client.force_login(self.other)
        resp = self.client.post(
            reverse("design_save", args=[self.design.pk]),
            {"canvas_json": json.dumps(_v1_envelope())},
            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
        )
        self.assertIn(resp.status_code, (403, 404))
        self.design.refresh_from_db()
        self.assertEqual(
            self.design.canvas_json["canvas"]["objects"][0].get("blytzId"), "f1"
        )


class GarmentViewsSourceStringTests(TestCase):
    """SOURCE-STRING: garment/view constants and public API names."""

    def test_js_garment_and_view_api_names(self):
        """SOURCE-STRING"""
        canvas_path = finders.find("js/editor_canvas.js")
        self.assertIsNotNone(canvas_path)
        with open(canvas_path, encoding="utf-8") as fh:
            canvas_src = fh.read()
        for token in (
            "getActiveView",
            "setActiveView",
            "getActiveCanvasJSON",
            "onViewChange",
            "getGarmentState",
            "setGarmentState",
            "onGarmentChange",
            "views.back",
            "loadAllViewsFromEnvelope",
        ):
            self.assertIn(token, canvas_src)

        garments_path = finders.find("js/editor_garments.js")
        self.assertIsNotNone(garments_path)
        with open(garments_path, encoding="utf-8") as fh:
            g_src = fh.read()
        for token in (
            "GARMENT_TYPES",
            "GARMENT_COLORS",
            "VIEW_IDS",
            "contrastColor",
            "renderGarmentLayer",
            "static/js/editor_garments.js",
        ):
            # last token may not be in file — check core exports
            if token.startswith("static/"):
                continue
            self.assertIn(token, g_src)

        from pathlib import Path

        choices = Path(__file__).resolve().parents[1] / "garment_choices.py"
        text = choices.read_text(encoding="utf-8")
        self.assertIn("editor_garments.js", text)
        self.assertIn("apply_stale_client_views_guard", text)
        self.assertIn("tee", text)
        self.assertIn("hoodie", text)
